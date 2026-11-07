// The app's own small state files: owner-only, replaced atomically, validated on every read. A
// file that exists but doesn't validate is an error the caller decides about (most fail closed);
// a missing file is simply "nothing yet".

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { ValetError } from '@valet/core'
import type { z } from 'zod'

/** Creates the data directory owner-only, and tightens it if it already existed looser. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

/** The parsed file, or null when it doesn't exist. Throws ValetError('config', …) otherwise. */
export async function readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ValetError('config', 'unavailable')
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ValetError('config', 'invalid')
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new ValetError('config', 'invalid')
  return parsed.data
}

/** Writes `value` as JSON, mode 0600, replacing the file in one step. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch {
    await rm(temp, { force: true })
    throw new ValetError('config', 'unavailable')
  }
}

/**
 * One JSON document with serialised updates, so two quick changes never interleave a read and a
 * write. `fallback` is what a missing file reads as; with `recoverInvalid`, an unreadable or invalid
 * file reads as it too (for files whose defaults are the safe side), otherwise reads throw.
 */
export class JsonDocument<T> {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly schema: z.ZodType<T>,
    private readonly fallback: () => T,
    private readonly recoverInvalid = false,
  ) {}

  async read(): Promise<T> {
    try {
      return (await readJsonFile(this.path, this.schema)) ?? this.fallback()
    } catch (error) {
      if (this.recoverInvalid) return this.fallback()
      throw error
    }
  }

  update(change: (current: T) => T): Promise<T> {
    const done = this.queue.then(async () => {
      const next = change(await this.read())
      await writeJsonFile(this.path, next)
      return next
    })
    this.queue = done.catch(() => undefined)
    return done
  }
}
