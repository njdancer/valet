import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { AuditEvent } from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog, GENESIS_HASH } from '../src/audit-log'
import { main, VERIFY_AUDIT_USAGE } from '../src/verify-audit-cli'

let dir: string
let path: string
let now: number
const clock = { now: () => now++ }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-verify-audit-'))
  path = join(dir, 'audit.jsonl')
  now = Date.UTC(2026, 10, 7, 9, 0, 0)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const events: AuditEvent[] = [
  {
    type: 'tool-called',
    adapterId: 'woolworths',
    adapterHash: 'a'.repeat(64),
    tool: 'get_trolley',
    client: 'claude-code',
    callId: 'call-1',
  },
  {
    type: 'request-blocked',
    adapterId: 'woolworths',
    method: 'GET',
    target: 'https://evil.test/x',
    reason: 'host-not-allowed',
    initiator: 'tool',
    partition: 'tool',
    callId: 'call-1',
  },
  { type: 'tool-finished', adapterId: 'woolworths', callId: 'call-1', outcome: 'ok', durationMs: 12 },
]

/** Writes a real log of three records and returns its bytes and head. */
async function writeLog(): Promise<{ bytes: Buffer; head: string }> {
  const log = new AuditLog(path, clock)
  let head = GENESIS_HASH
  for (const event of events) head = (await log.append(event)).hash
  return { bytes: await readFile(path), head }
}

function sink(): Writable & { text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk))
      done()
    },
  })
  return Object.assign(stream, { text: () => chunks.join('') })
}

async function run(args: string[], extra: { dataDir?: string; cwd?: string } = {}) {
  const output = sink()
  const errors = sink()
  const code = await main(args, { output, errors, ...extra })
  return { code, stdout: output.text(), stderr: errors.text() }
}

/** Every way of cutting the file short, other than to its full length. */
function truncations(bytes: Buffer): Buffer[] {
  return Array.from({ length: bytes.length }, (_, n) => bytes.subarray(0, n))
}

function lineStarts(bytes: Buffer): number[] {
  const starts = [0]
  for (let i = 0; i < bytes.length - 1; i++) if (bytes[i] === 0x0a) starts.push(i + 1)
  return starts
}

describe('valet-verify-audit', () => {
  it('passes an intact log and prints the record count and head', async () => {
    const { head } = await writeLog()
    expect(await run([path])).toEqual({ code: 0, stdout: `ok: 3 records, head ${head}\n`, stderr: '' })
    expect((await run(['--head', head, path])).code).toBe(0)
  })

  it('passes an empty log, and says "record" for one', async () => {
    await writeFile(path, '')
    expect((await run([path])).stdout).toBe(`ok: 0 records, head ${GENESIS_HASH}\n`)
    await new AuditLog(path, clock).append(events[0] as AuditEvent)
    expect((await run([path])).stdout).toMatch(/^ok: 1 record, head [0-9a-f]{64}\n$/)
  })

  // Thousands of write-and-verify rounds, one per tampered byte: about 2 s alone, and it ran past
  // vitest's 5 s default once on a busy macOS runner. The work is fixed, so give it room.
  it('fails when any byte of any line is changed', { timeout: 30_000 }, async () => {
    const { bytes } = await writeLog()
    for (let i = 0; i < bytes.length; i++) {
      for (const replacement of [bytes[i]! ^ 0x01, bytes[i]! ^ 0x20, 0x20]) {
        if (replacement === bytes[i]) continue
        const tampered = Buffer.from(bytes)
        tampered[i] = replacement
        await writeFile(path, tampered)
        const result = await run([path])
        expect(result.code, `byte ${i} -> ${replacement}`).toBe(1)
        expect(result.stderr).toMatch(/^FAILED: .*: line [1-4]: /)
      }
    }
  })

  it('fails when a line is deleted, and names the first bad line', async () => {
    const { bytes, head } = await writeLog()
    const original = bytes.toString('utf8').split('\n').slice(0, -1)
    for (let n = 0; n < original.length; n++) {
      const kept = original.filter((_, i) => i !== n)
      await writeFile(path, `${kept.join('\n')}\n`)
      const result = await run(n === original.length - 1 ? ['--head', head, path] : [path])
      expect(result.code, `deleted line ${n + 1}`).toBe(1)
      expect(result.stderr).toContain(`line ${n + 1}: `)
    }
  })

  it('fails when two lines are swapped', async () => {
    const { bytes } = await writeLog()
    const original = bytes.toString('utf8').split('\n').slice(0, -1)
    for (let a = 0; a < original.length; a++) {
      for (let b = a + 1; b < original.length; b++) {
        const swapped = [...original]
        ;[swapped[a], swapped[b]] = [swapped[b] as string, swapped[a] as string]
        await writeFile(path, `${swapped.join('\n')}\n`)
        const result = await run([path])
        expect(result.code, `swapped ${a + 1} and ${b + 1}`).toBe(1)
        expect(result.stderr).toContain(`line ${a + 1}: `)
        expect(result.stderr).toContain(`  ${swapped[a]}\n`)
      }
    }
  })

  it('fails when the file is cut short mid-line, with or without the expected head', async () => {
    const { bytes, head } = await writeLog()
    const boundaries = new Set(lineStarts(bytes))
    for (const short of truncations(bytes)) {
      await writeFile(path, short)
      expect((await run(['--head', head, path])).code, `cut to ${short.length} bytes, --head`).toBe(1)
      if (!boundaries.has(short.length)) {
        expect((await run([path])).code, `cut to ${short.length} bytes`).toBe(1)
      }
    }
  })

  it('reports a cut at a line boundary as a head mismatch when given the head', async () => {
    const { bytes, head } = await writeLog()
    await writeFile(path, bytes.subarray(0, lineStarts(bytes)[2]))
    // Without the head, two whole records are a valid log; the head kept elsewhere is what catches it.
    expect((await run([path])).code).toBe(0)
    const result = await run(['--head', head, path])
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: `FAILED: ${path}: line 3: the log ends before the expected head (records were removed from the end)\n`,
    })
  })

  it('fails when records are appended after the expected head', async () => {
    const { head } = await writeLog()
    await new AuditLog(path, clock).append(events[0] as AuditEvent)
    expect((await run(['--head', head, path])).code).toBe(1)
  })

  it('shortens a long bad line', async () => {
    await writeFile(path, `${'x'.repeat(1000)}\n`)
    const result = await run([path])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`  ${'x'.repeat(400)}…\n`)
  })

  it('reads the release app log by default, and resolves relative paths against cwd', async () => {
    const { head } = await writeLog()
    expect((await run([], { dataDir: dir })).stdout).toContain(head)
    expect((await run(['audit.jsonl'], { cwd: dir })).stdout).toContain(head)
  })

  it('fails on a missing or unreadable file rather than calling it empty', async () => {
    const missing = await run([join(dir, 'nope.jsonl')])
    expect(missing).toEqual({
      code: 1,
      stdout: '',
      stderr: `valet-verify-audit: ${join(dir, 'nope.jsonl')}: no such file\n`,
    })
    expect((await run([dir])).stderr).toBe(`valet-verify-audit: ${dir}: cannot be read\n`)
  })

  it('rejects bad usage with exit code 2', async () => {
    for (const args of [
      ['a', 'b'],
      ['--head'],
      ['--head', 'nothex', path],
      ['--head', 'a'.repeat(64), '--head', 'a'.repeat(64), path],
      ['--json', path],
    ]) {
      expect(await run(args), args.join(' ')).toEqual({ code: 2, stdout: '', stderr: VERIFY_AUDIT_USAGE })
    }
  })

  it('runs as a process with the exit code', async () => {
    const { head } = await writeLog()
    const cli = resolve(import.meta.dirname, '../src/verify-audit-cli.ts')
    const exec = promisify(execFile)
    const ok = await exec(process.execPath, ['--import', 'tsx', cli, path])
    expect(ok.stdout).toBe(`ok: 3 records, head ${head}\n`)
    await writeFile(path, (await readFile(path, 'utf8')).replace('get_trolley', 'get_trollex'))
    await expect(exec(process.execPath, ['--import', 'tsx', cli, path])).rejects.toMatchObject({ code: 1 })
  })
})

describe('valet-verify-audit across rotated files (D27)', () => {
  async function writeRotated(): Promise<string> {
    const log = new AuditLog(path, clock)
    await log.append(events[0] as AuditEvent)
    await log.rotate()
    await log.append(events[1] as AuditEvent)
    await log.rotate()
    return (await log.append(events[2] as AuditEvent)).hash
  }

  it('follows the chain through every archive into the live file', async () => {
    const head = await writeRotated()
    expect(await run([path, '--head', head])).toEqual({
      code: 0,
      stdout: `ok: 3 records in 3 files, head ${head}\n`,
      stderr: '',
    })
  })

  it('names the file the chain breaks in when an archive is deleted', async () => {
    await writeRotated()
    await rm(join(dir, 'audit.0001.jsonl'))
    const result = await run([path])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`FAILED: ${join(dir, 'audit.0002.jsonl')}: line 1: out of sequence`)
  })

  it('verifies a log that has just rotated and has no live file yet', async () => {
    const head = await writeRotated()
    await new AuditLog(path, clock).rotate()
    expect(await run([path, '--head', head])).toMatchObject({
      code: 0,
      stdout: `ok: 3 records in 4 files, head ${head}\n`,
    })
  })
})
