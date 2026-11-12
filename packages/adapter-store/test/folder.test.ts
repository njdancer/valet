import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPackage, PACKAGE_LIMITS, packageOf } from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPackageFolder } from '../src/folder'
import { MANIFESTS, sourcesOf } from './builtins'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-folder-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function write(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
}

describe('readPackageFolder', () => {
  it('reads a package laid out as a folder, and only the package', async () => {
    const files = packageOf(MANIFESTS['wikipedia']?.() as never, sourcesOf('wikipedia'))
    await write({ ...files, 'package.json': '{}', 'vitest.config.ts': '', '.git/x': '', 'src/.DS_Store': '' })
    await write({ 'node_modules/zod/index.ts': '', 'test/a.test.ts': 'x', 'fixtures/a.json': '{}' })
    const read = await readPackageFolder(dir)
    expect(Object.keys(read).sort()).toEqual(
      [...Object.keys(files), 'test/a.test.ts', 'fixtures/a.json'].sort(),
    )
    expect(checkPackage(read).adapterHash).toBe(checkPackage(files).adapterHash)
  })

  it('refuses a symlink anywhere it reads', async () => {
    await write({ 'src/tools.ts': '' })
    await symlink('/etc/hosts', join(dir, 'src', 'hosts.ts'))
    await expect(readPackageFolder(dir)).rejects.toMatchObject({ rule: 'path' })
    await rm(join(dir, 'src', 'hosts.ts'))
    await symlink('/etc/hosts', join(dir, 'manifest.json'))
    await expect(readPackageFolder(dir)).rejects.toMatchObject({ rule: 'path' })
  })

  it('refuses a file that is too large before reading it', async () => {
    await write({ 'src/big.ts': 'x'.repeat(PACKAGE_LIMITS.fileBytes + 1) })
    await expect(readPackageFolder(dir)).rejects.toMatchObject({ rule: 'file-too-large' })
  })

  it('refuses something that is not a folder', async () => {
    await write({ 'a.txt': '' })
    await expect(readPackageFolder(join(dir, 'a.txt'))).rejects.toMatchObject({ rule: 'path' })
    await write({ src: '' })
  })
})
