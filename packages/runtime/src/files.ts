// Small durable-write helpers. State files are replaced atomically (write, fsync, rename, fsync the
// directory) so a crash leaves either the old file or the new one, never a torn one.

import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFileSynced(temporary, data)
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  await syncDirectory(dirname(path))
}

/** Creates or truncates `path`, writes `data` and fsyncs it before returning. */
export async function writeFileSynced(path: string, data: string): Promise<void> {
  const handle = await open(path, 'w', 0o600)
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Makes a rename or unlink in `dir` durable. */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
