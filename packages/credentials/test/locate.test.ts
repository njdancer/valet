import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isExecutableFile, locateExecutable } from '../src/locate'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'valet-locate-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('isExecutableFile', () => {
  it('accepts an executable regular file', async () => {
    const path = join(dir, 'op')
    await fs.writeFile(path, '#!/bin/sh\n', { mode: 0o755 })
    expect(await isExecutableFile(path)).toBe(true)
  })

  it('refuses a file that is not executable', async () => {
    const path = join(dir, 'op')
    await fs.writeFile(path, '#!/bin/sh\n', { mode: 0o644 })
    expect(await isExecutableFile(path)).toBe(false)
  })

  it('refuses a directory, which has the execute bit too', async () => {
    const path = join(dir, 'op')
    await fs.mkdir(path, { mode: 0o755 })
    expect(await isExecutableFile(path)).toBe(false)
  })

  it('refuses a path that does not exist', async () => {
    expect(await isExecutableFile(join(dir, 'missing'))).toBe(false)
  })
})

describe('locateExecutable', () => {
  it('finds a binary on disk through a PATH directory', async () => {
    const path = join(dir, 'op')
    await fs.writeFile(path, '#!/bin/sh\n', { mode: 0o755 })
    expect(await locateExecutable('op', [join(dir, 'missing')], `relative:${dir}`, isExecutableFile)).toBe(
      path,
    )
  })

  it('returns null with no candidates and no PATH', async () => {
    expect(await locateExecutable('op', [], null, async () => true)).toBeNull()
  })
})
