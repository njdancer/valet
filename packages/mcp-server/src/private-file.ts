// Files only the person's own account may read: the endpoint token and the bridge config. Written
// atomically with mode 0600, and refused on read if anyone else could have read or replaced them.

import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { SiteAdapterError } from '@siteadapter/core'

const PRIVATE_MODE = 0o600

/** Writes `contents` to `path` with mode 0600, replacing any existing file in one step. */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  // Never open the final path for writing: a file planted there could be a symlink or keep its
  // looser mode. A fresh temp file opened with O_EXCL is ours alone.
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(temp, 'wx', PRIVATE_MODE)
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
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Reads a file written by `writePrivateFile`. Throws SiteAdapterError('credential', …) when it is
 * missing, not a regular file, not owned by this user, or readable or writable by anyone else.
 */
export async function readPrivateFile(path: string, uid: number = currentUid()): Promise<string> {
  const handle = await open(path, 'r').catch(() => {
    throw new SiteAdapterError('credential', 'not-found')
  })
  try {
    // Checked on the open handle, so the file can't be swapped between the check and the read.
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0) {
      throw new SiteAdapterError('credential', 'invalid')
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
