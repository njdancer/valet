import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TRACE_RETENTION_DAYS, pruneOlderThan } from '../src/retention'

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 10, 10, 9, 0, 0)
let dir: string
let outside: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-traces-'))
  outside = await mkdtemp(join(tmpdir(), 'valet-outside-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function aged(path: string, days: number): Promise<void> {
  const at = new Date(now - days * DAY)
  await utimes(path, at, at)
}

describe('pruneOlderThan', () => {
  it('keeps 14 days by default', () => {
    expect(DEFAULT_TRACE_RETENTION_DAYS).toBe(14)
  })

  it('removes files and run folders older than the setting, and keeps the rest', async () => {
    await writeFile(join(dir, 'old.png'), 'x')
    await aged(join(dir, 'old.png'), 15)
    await writeFile(join(dir, 'new.png'), 'x')
    await aged(join(dir, 'new.png'), 13)
    await mkdir(join(dir, 'run-1'))
    await writeFile(join(dir, 'run-1', 'trace.json'), '{}')
    await aged(join(dir, 'run-1'), 20)
    expect(await pruneOlderThan(dir, 14, now)).toEqual(['old.png', 'run-1'])
    expect(await readdir(dir)).toEqual(['new.png'])
  })

  it('takes a shorter or longer setting', async () => {
    await writeFile(join(dir, 'a'), 'x')
    await aged(join(dir, 'a'), 3)
    expect(await pruneOlderThan(dir, 30, now)).toEqual([])
    expect(await pruneOlderThan(dir, 2, now)).toEqual(['a'])
  })

  it('removes an old symbolic link without following it', async () => {
    await writeFile(join(outside, 'keep'), 'x')
    await aged(join(outside, 'keep'), 100)
    await symlink(outside, join(dir, 'link'))
    const at = new Date(now - 100 * DAY)
    const { lutimes } = await import('node:fs/promises')
    await lutimes(join(dir, 'link'), at, at)
    expect(await pruneOlderThan(dir, 14, now)).toEqual(['link'])
    expect(await readdir(outside)).toEqual(['keep'])
  })

  it('has nothing to do without the folder, and refuses a setting out of range', async () => {
    expect(await pruneOlderThan(join(dir, 'missing'), 14, now)).toEqual([])
    for (const days of [0, -1, 1.5, 366, Number.NaN]) {
      await expect(pruneOlderThan(dir, days, now)).rejects.toThrow(RangeError)
    }
  })
})
