import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditEvent } from '@siteadapter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog, GENESIS_HASH, recordHash, verifyAuditLog } from '../src/audit-log'

let dir: string
let path: string
let now: number
const clock = { now: () => now }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siteadapter-audit-'))
  path = join(dir, 'audit.jsonl')
  now = Date.UTC(2026, 10, 7, 9, 0, 0)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const called: AuditEvent = {
  type: 'tool-called',
  adapterId: 'woolworths',
  adapterHash: 'a'.repeat(64),
  tool: 'get_trolley',
  client: 'claude-code',
  callId: 'call-1',
}
const finished: AuditEvent = { type: 'tool-finished', callId: 'call-1', outcome: 'ok', durationMs: 12 }
const blocked: AuditEvent = {
  type: 'request-blocked',
  adapterId: 'woolworths',
  method: 'GET',
  target: 'https://evil.test/x',
  reason: 'host-not-allowed',
  callId: 'call-1',
}

async function lines(): Promise<string[]> {
  return (await readFile(path, 'utf8')).trimEnd().split('\n')
}

async function writeLines(content: string[]): Promise<void> {
  await writeFile(path, `${content.join('\n')}\n`)
}

describe('AuditLog', () => {
  it('chains records from the genesis hash with increasing sequence numbers', async () => {
    const log = new AuditLog(path, clock)
    const first = await log.append(called)
    now += 1000
    const second = await log.append(finished)

    expect(first.seq).toBe(1)
    expect(first.prev).toBe(GENESIS_HASH)
    expect(first.at).toBe('2026-11-07T09:00:00.000Z')
    expect(first.hash).toBe(recordHash(1, first.at, called, GENESIS_HASH))
    expect(second.seq).toBe(2)
    expect(second.prev).toBe(first.hash)
    expect(second.at).toBe('2026-11-07T09:00:01.000Z')
    expect(await verifyAuditLog(path)).toEqual({ ok: true, records: 2, head: second.hash })
  })

  it('writes one JSON record per line', async () => {
    const log = new AuditLog(path, clock)
    await log.append(called)
    await log.append(finished)

    const parsed = (await lines()).map((line) => JSON.parse(line))
    expect(parsed.map((record) => record.event.type)).toEqual(['tool-called', 'tool-finished'])
  })

  it('serialises concurrent appends in call order', async () => {
    const log = new AuditLog(path, clock)
    const records = await Promise.all([log.append(called), log.append(finished), log.append(blocked)])

    expect(records.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(records.map((r) => r.event.type)).toEqual(['tool-called', 'tool-finished', 'request-blocked'])
    expect((await verifyAuditLog(path)).ok).toBe(true)
  })

  it('continues an existing log after a restart', async () => {
    const before = new AuditLog(path, clock)
    const first = await before.append(called)

    const after = new AuditLog(path, clock)
    const second = await after.append(finished)

    expect(second.seq).toBe(2)
    expect(second.prev).toBe(first.hash)
    expect(await verifyAuditLog(path)).toEqual({ ok: true, records: 2, head: second.hash })
  })

  it('refuses to append to a log whose chain is already broken', async () => {
    const before = new AuditLog(path, clock)
    await before.append(called)
    await before.append(finished)
    const [first, second] = await lines()
    await writeLines([second!, first!])

    const after = new AuditLog(path, clock)
    await expect(after.append(blocked)).rejects.toMatchObject({ stage: 'tool-run', errorClass: 'internal' })
    expect(await lines()).toEqual([second, first])
  })

  it('keeps accepting appends after one write fails', async () => {
    const log = new AuditLog(join(dir, 'missing-dir', 'audit.jsonl'), clock)
    await expect(log.append(called)).rejects.toThrow()

    const good = new AuditLog(path, clock)
    await expect(good.append(called)).resolves.toMatchObject({ seq: 1 })
  })
})

describe('verifyAuditLog', () => {
  async function threeRecords(): Promise<string[]> {
    const log = new AuditLog(path, clock)
    await log.append(called)
    await log.append(finished)
    await log.append(blocked)
    return lines()
  }

  it('accepts a missing file as an empty log', async () => {
    expect(await verifyAuditLog(path)).toEqual({ ok: true, records: 0, head: GENESIS_HASH })
  })

  it('detects an edited event', async () => {
    const [first, second, third] = await threeRecords()
    await writeLines([first!, second!.replace('"durationMs":12', '"durationMs":13'), third!])

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 2, problem: 'hash' })
  })

  it('detects an edit whose hash was recomputed, through the next record', async () => {
    const [first, second, third] = await threeRecords()
    const record = JSON.parse(second!)
    record.event.durationMs = 13
    record.hash = recordHash(record.seq, record.at, record.event, record.prev)
    await writeLines([first!, JSON.stringify(record), third!])

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 3, problem: 'chain' })
  })

  it('detects a deleted record', async () => {
    const [first, , third] = await threeRecords()
    await writeLines([first!, third!])

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 2, problem: 'sequence' })
  })

  it('detects a deleted record whose successors were renumbered', async () => {
    const [first, , third] = await threeRecords()
    const record = JSON.parse(third!)
    record.seq = 2
    await writeLines([first!, JSON.stringify(record)])

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 2, problem: 'chain' })
  })

  it('detects reordered records', async () => {
    const [first, second, third] = await threeRecords()
    await writeLines([first!, third!, second!])

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 2, problem: 'sequence' })
  })

  it('detects a deleted first record', async () => {
    const [, second, third] = await threeRecords()
    const renumbered = [second!, third!].map((line, index) => {
      const record = JSON.parse(line)
      record.seq = index + 1
      return JSON.stringify(record)
    })
    await writeLines(renumbered)

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 1, problem: 'chain' })
  })

  it('detects truncation of the tail only against an expected head', async () => {
    const [first, second] = await threeRecords()
    const complete = await verifyAuditLog(path)
    if (!complete.ok) throw new Error('expected a valid log')
    await writeLines([first!, second!])

    expect((await verifyAuditLog(path)).ok).toBe(true)
    expect(await verifyAuditLog(path, { expectedHead: complete.head })).toEqual({
      ok: false,
      line: 3,
      problem: 'head-mismatch',
    })
  })

  it('accepts the expected head when it matches', async () => {
    await threeRecords()
    const verification = await verifyAuditLog(path)
    if (!verification.ok) throw new Error('expected a valid log')

    expect(await verifyAuditLog(path, { expectedHead: verification.head })).toEqual(verification)
  })

  it('rejects a line that is not JSON', async () => {
    const [first] = await threeRecords()
    await writeLines([first!, 'not json'])

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 2, problem: 'malformed' })
  })

  it('rejects a record with an extra field', async () => {
    const [first] = await threeRecords()
    const record = JSON.parse(first!)
    record.note = 'added later'
    await writeLines([JSON.stringify(record)])

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 1, problem: 'malformed' })
  })

  it('rejects records with fields of the wrong type', async () => {
    const [first] = await threeRecords()
    const variants = [
      { ...JSON.parse(first!), seq: '1' },
      { ...JSON.parse(first!), seq: 1.5 },
      { ...JSON.parse(first!), at: 0 },
      { ...JSON.parse(first!), event: null },
      { ...JSON.parse(first!), event: 'tool-called' },
    ]
    for (const variant of variants) {
      await writeLines([JSON.stringify(variant)])
      expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 1, problem: 'malformed' })
    }
  })

  it('rejects JSON values that are not records', async () => {
    for (const line of ['null', '[]', '42']) {
      await writeLines([line])
      expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 1, problem: 'malformed' })
    }
  })

  it('rejects a torn final write with no newline', async () => {
    const [first, second] = await threeRecords()
    await writeFile(path, `${first}\n${second!.slice(0, 20)}`)

    expect(await verifyAuditLog(path)).toEqual({ ok: false, line: 2, problem: 'malformed' })
  })

  it('rethrows read errors other than a missing file', async () => {
    await expect(verifyAuditLog(dir)).rejects.toThrow()
  })
})

// A write that fails part way must not leave the log chained onto a torn or duplicate line.
describe('AuditLog when a write fails', () => {
  /** Opens the real file, but its appendFile writes `written` of the data and then fails. */
  function tornWrites(written: (data: string) => string, failSync = false) {
    let failing = true
    const openFile = async (target: string) => {
      const handle = await open(target, 'a', 0o600)
      if (!failing) return handle
      failing = false
      return new Proxy(handle, {
        get(real, key) {
          if (key === 'appendFile') {
            return async (data: string) => {
              await real.appendFile(written(data), 'utf8')
              if (!failSync) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
            }
          }
          if (key === 'sync' && failSync) {
            return async () => {
              throw Object.assign(new Error('fsync failed'), { code: 'EIO' })
            }
          }
          const value = Reflect.get(real, key)
          return typeof value === 'function' ? value.bind(real) : value
        },
      })
    }
    return openFile
  }

  it('cuts a torn line back off, rejects that append, and keeps the chain whole', async () => {
    await new AuditLog(path, clock).append(called)
    const log = new AuditLog(
      path,
      clock,
      tornWrites((data) => data.slice(0, 20)),
    )

    await expect(log.append(finished)).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await lines()).toHaveLength(1)
    const next = await log.append(blocked)

    expect(next.seq).toBe(2)
    expect(await verifyAuditLog(path)).toEqual({ ok: true, records: 2, head: next.hash })
  })

  it('removes a whole line whose fsync failed, so the next append does not reuse its sequence', async () => {
    await new AuditLog(path, clock).append(called)
    const log = new AuditLog(
      path,
      clock,
      tornWrites((data) => data, true),
    )

    await expect(log.append(finished)).rejects.toMatchObject({ code: 'EIO' })
    const next = await log.append(blocked)

    expect(next.seq).toBe(2)
    expect(next.event).toEqual(blocked)
    expect(await verifyAuditLog(path)).toMatchObject({ ok: true, records: 2 })
  })

  it('refuses later appends if the torn line could not be cut off', async () => {
    let calls = 0
    const openFile = async (target: string) => {
      const handle = await open(target, 'a', 0o600)
      calls++
      if (calls > 1) return handle
      return new Proxy(handle, {
        get(real, key) {
          if (key === 'appendFile') {
            return async (data: string) => {
              await real.appendFile(data.slice(0, 10), 'utf8')
              throw new Error('no space left')
            }
          }
          if (key === 'truncate') return async () => Promise.reject(new Error('EIO'))
          const value = Reflect.get(real, key)
          return typeof value === 'function' ? value.bind(real) : value
        },
      })
    }
    const log = new AuditLog(path, clock, openFile)
    await expect(log.append(called)).rejects.toThrow()
    await expect(log.append(finished)).rejects.toMatchObject({ stage: 'tool-run', errorClass: 'internal' })
  })
})
