// Finds a helper binary by absolute path. Spawning a bare name would leave the choice to whatever
// PATH the app inherited: a Finder launch has almost nothing on it, and a relative entry such as "."
// would run a binary planted in the working directory.

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * The first of `candidates`, then of `name` in each absolute directory on `searchPath`, that
 * `isExecutable` accepts. Null when there is none. Relative candidates and PATH entries are skipped.
 */
export async function locateExecutable(
  name: string,
  candidates: readonly string[],
  searchPath: string | null,
  isExecutable: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const directories = (searchPath ?? '').split(delimiter).filter((entry) => isAbsolute(entry))
  const paths = [
    ...candidates.filter((path) => isAbsolute(path)),
    ...directories.map((dir) => join(dir, name)),
  ]
  for (const path of paths) {
    if (await isExecutable(path)) return path
  }
  return null
}

/** True when `path` is a regular file this process may execute. Never throws. */
export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
