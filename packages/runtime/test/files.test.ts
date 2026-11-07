import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isErrno, writeFileAtomic } from '../src/files'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-files-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temporary file behind', async () => {
    const path = join(dir, 'state.json')
    await writeFileAtomic(path, 'one')
    await writeFileAtomic(path, 'two')

    expect(await readFile(path, 'utf8')).toBe('two')
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  it('removes its temporary file when the rename fails', async () => {
    const path = join(dir, 'state.json')
    await mkdir(join(path, 'child'), { recursive: true })

    await expect(writeFileAtomic(path, 'data')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['state.json'])
  })
})

describe('isErrno', () => {
  it('matches an error by its code', () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
    expect(isErrno(error, 'ENOENT')).toBe(true)
    expect(isErrno(error, 'EACCES')).toBe(false)
    expect(isErrno('ENOENT', 'ENOENT')).toBe(false)
  })
})
