// Reads a package from a development folder (docs/adapter-packages.md#the-package). Only what a
// package may hold is read: manifest.json and README.md at the top, and the src/, test/ and
// fixtures/ folders; anything else at the top (package.json, configs) is left alone, and dotfiles
// and node_modules are skipped everywhere. Symlinks and anything else that isn't a plain file or
// folder are refused, checked with lstat and never followed. The files are read into memory once;
// only that copy is checked, hashed and stored.

import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_LIMITS, PackageError, type PackageFiles } from '@valet/core'

const TOP_FILES = ['manifest.json', 'README.md']
const TOP_FOLDERS = ['src', 'test', 'fixtures']

export async function readPackageFolder(root: string): Promise<PackageFiles> {
  const files: Record<string, string> = {}
  let total = 0
  const add = async (path: string, relative: string): Promise<void> => {
    const info = await lstat(path)
    if (!info.isFile()) throw new PackageError('path', `${relative} is not a plain file`)
    if (info.size > PACKAGE_LIMITS.fileBytes) throw new PackageError('file-too-large', relative)
    total += info.size
    if (total > PACKAGE_LIMITS.totalBytes) throw new PackageError('too-large', String(total))
    if (Object.keys(files).length >= PACKAGE_LIMITS.files) throw new PackageError('too-many-files', relative)
    files[relative] = await readFile(path, 'utf8')
  }
  const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (depth > PACKAGE_LIMITS.segments) throw new PackageError('path', relative)
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      const child = `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) throw new PackageError('path', `${child} is a symlink`)
      if (entry.isDirectory()) await walk(path, child, depth + 1)
      else await add(path, child)
    }
  }
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory()) throw new PackageError('path', 'not a folder')
  for (const name of TOP_FILES) {
    const path = join(root, name)
    const info = await lstat(path).catch(() => null)
    if (info === null) continue
    if (info.isSymbolicLink()) throw new PackageError('path', `${name} is a symlink`)
    await add(path, name)
  }
  for (const name of TOP_FOLDERS) {
    const path = join(root, name)
    const info = await lstat(path).catch(() => null)
    if (info === null) continue
    if (!info.isDirectory()) throw new PackageError('path', `${name} is not a folder`)
    await walk(path, name, 1)
  }
  return files
}
