// A small JSON file that decides something security-relevant (grants): validated by the caller
// on every read, replaced atomically on every write, and readable and writable only by its owner.
// A file or directory someone else could have written or redirected is refused, never read.

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as nodeFs from 'node:fs/promises'
import { dirname } from 'node:path'
import { ValetError } from '@valet/core'

/** The file operations the store uses, injected so tests can fail them. */
export type GrantFs = Pick<typeof nodeFs, 'lstat' | 'mkdir' | 'open' | 'rename' | 'unlink'>

// Never follow a planted symlink, and never block on a planted FIFO.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export class SecureJsonFile {
  readonly #path: string
  readonly #fs: GrantFs
  // Serialises read-modify-write so concurrent writers in this process never lose one another.
  #queue: Promise<unknown> = Promise.resolve()

  constructor(path: string, fs: GrantFs = nodeFs) {
    this.#path = path
    this.#fs = fs
  }

  /** Runs `work` after every earlier exclusive() has settled. */
  exclusive(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(work, work)
    this.#queue = run.catch(() => {})
    return run
  }

  /**
   * The parsed contents, or undefined when there is no file. Throws ValetError('config'):
   * `insecure-file`, `unavailable`, or `invalid` for text that isn't JSON.
   */
  async read(): Promise<unknown> {
    let raw: string
    try {
      if (!(await this.#checkDirectory())) return undefined
      // The checks and the read go through one handle, so the file can't be swapped between them.
      const handle = await this.#fs.open(this.#path, READ_FLAGS)
      try {
        const info = await handle.stat()
        if (!info.isFile() || !safeOwnership(info)) throw new ValetError('config', 'insecure-file')
        raw = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof ValetError) throw error
      if (errorCode(error) === 'ENOENT') return undefined
      // What O_NOFOLLOW reports for a symlink.
      if (errorCode(error) === 'ELOOP') throw new ValetError('config', 'insecure-file')
      throw new ValetError('config', 'unavailable')
    }
    try {
      return JSON.parse(raw) as unknown
    } catch {
      throw new ValetError('config', 'invalid')
    }
  }

  async write(value: unknown): Promise<void> {
    const directory = dirname(this.#path)
    const temp = `${this.#path}.${randomUUID()}.tmp`
    const body = `${JSON.stringify(value, null, 2)}\n`
    try {
      await this.#fs.mkdir(directory, { recursive: true, mode: 0o700 })
    } catch {
      throw new ValetError('config', 'unavailable')
    }
    // mkdir's mode only applies to a directory it creates; an existing one is checked as on read.
    await this.#checkDirectory()
    try {
      const handle = await this.#fs.open(temp, 'wx', 0o600)
      try {
        // The umask can only remove bits; chmod makes the mode exact either way.
        await handle.chmod(0o600)
        await handle.writeFile(body, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#fs.rename(temp, this.#path)
    } catch {
      await this.#fs.unlink(temp).catch(() => {})
      throw new ValetError('config', 'unavailable')
    }
    await this.#syncDirectory(directory)
  }

  /**
   * Refuses a directory that another user could write to: whoever can write there can replace the
   * file with their own. Returns false when the directory doesn't exist yet.
   */
  async #checkDirectory(): Promise<boolean> {
    let info: Awaited<ReturnType<GrantFs['lstat']>>
    try {
      info = await this.#fs.lstat(dirname(this.#path))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw new ValetError('config', 'unavailable')
    }
    if (!info.isDirectory() || !safeOwnership(info)) throw new ValetError('config', 'insecure-file')
    return true
  }

  /** Makes the rename durable. Best effort: not every platform can fsync a directory. */
  async #syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await this.#fs.open(directory, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch {
      // The data is already in place; only crash durability of the rename is at stake.
    }
  }
}

/** Owned by this user, and writable by no one else. */
function safeOwnership(info: { mode: number; uid: number }): boolean {
  return (info.mode & 0o022) === 0 && (process.getuid === undefined || info.uid === process.getuid())
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
