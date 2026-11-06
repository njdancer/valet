// Files only the person's own account may read: the endpoint token and the bridge config. Written
// atomically with mode 0600, and refused on read if anyone else could have read or replaced them.

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { SiteAdapterError } from '@siteadapter/core'

const PRIVATE_MODE = 0o600
// Never follow a planted symlink, and never block on a planted FIFO.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/**
 * Writes `contents` to `path` with mode 0600, replacing any existing file in one step. Throws
 * SiteAdapterError('config', 'unavailable') when it can't.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  // Never open the final path for writing: a file planted there could be a symlink or keep its
  // looser mode. A fresh temp file opened with O_EXCL is ours alone.
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(temp, 'wx', PRIVATE_MODE).catch(() => {
    throw new SiteAdapterError('config', 'unavailable')
  })
  try {
    try {
      await handle.writeFile(contents, 'utf8')
      // The creation mode is filtered by umask; make sure it is exactly 0600.
      await handle.chmod(PRIVATE_MODE)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch {
    await rm(temp, { force: true })
    throw new SiteAdapterError('config', 'unavailable')
  }
}

/**
 * Reads a file written by `writePrivateFile`. Throws SiteAdapterError with stage `config`:
 * `not-found` when it is missing; `insecure-file` when it is a symlink or not a regular file, is
 * owned by another account, or others could read or write it; `unavailable` when it can't be read.
 */
export async function readPrivateFile(path: string, uid: number = currentUid()): Promise<string> {
  const handle = await open(path, READ_FLAGS).catch((error: unknown) => {
    const code = errorCode(error)
    if (code === 'ENOENT') throw new SiteAdapterError('config', 'not-found')
    // What O_NOFOLLOW reports for a symlink.
    if (code === 'ELOOP') throw new SiteAdapterError('config', 'insecure-file')
    throw new SiteAdapterError('config', 'unavailable')
  })
  try {
    // Checked on the open handle, so the file can't be swapped between the check and the read.
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0) {
      throw new SiteAdapterError('config', 'insecure-file')
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function currentUid(): number {
  /* v8 ignore next -- getuid exists on every platform siteadapter runs on (macOS). */
  return process.getuid?.() ?? -1
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}
