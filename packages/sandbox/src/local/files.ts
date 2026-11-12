// `ctx.local.files`, enforced in the main process (docs/sandbox.md#files-in-detail). Every call:
// the path must be one tool code may name; it must sit within a declared pattern; its real path
// (symlinks resolved, the pattern's own root resolved too) must still sit within one and must not
// touch a forbidden place; the file is opened without following a last symlink and its identity is
// checked against the real path, so a swap between the check and the open fails. Errors are
// ValetError classes only, never an OS message or a path.

import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  isWritablePath,
  type LocalEncoding,
  type LocalFileEntry,
  type LocalFiles,
  type SandboxException,
  touchesForbiddenPath,
  ValetError,
} from '@valet/core'
import { checkRequestedPath, type FilePattern, homeRelative, toPattern, withinPattern } from './paths'

export const MAX_FILE_BYTES = 16 * 1024 * 1024
export const MAX_LIST_ENTRIES = 1_000

const fail = (errorClass: 'not-granted' | 'denied-path' | 'not-found' | 'invalid'): ValetError =>
  new ValetError('tool-run', errorClass)

/** What the files capability may reach: the declared patterns, or (unsandboxed) anything not forbidden. */
export type FileReach =
  | { readonly kind: 'declared'; readonly patterns: readonly FilePattern[] }
  | { readonly kind: 'open' }

export function fileReach(exceptions: readonly SandboxException[], home: string): FileReach {
  const patterns: FilePattern[] = []
  for (const e of exceptions)
    if (e.kind === 'files') for (const p of e.paths) patterns.push(toPattern(p, e.access, home))
  return { kind: 'declared', patterns }
}

const encodingOf = (options: unknown): LocalEncoding => {
  if (options === undefined || options === null) return 'utf8'
  if (typeof options !== 'object') throw fail('invalid')
  const encoding = (options as { encoding?: unknown }).encoding
  if (encoding === undefined || encoding === 'utf8') return 'utf8'
  if (encoding === 'base64') return 'base64'
  throw fail('invalid')
}

function osError(error: unknown): ValetError {
  if (error instanceof ValetError) return error
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return fail('not-found')
  if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') return fail('denied-path')
  return fail('invalid')
}

export function localFiles(reach: FileReach, home: string): LocalFiles {
  const resolvedRoots = new Map<string, Promise<string>>()
  const resolvedRoot = (root: string): Promise<string> => {
    let r = resolvedRoots.get(root)
    if (r === undefined) {
      r = realpath(root).catch(() => root)
      resolvedRoots.set(root, r)
    }
    return r
  }

  /** The patterns that let `path` be used for `need`, by the name tool code gave. */
  const candidates = (path: string, need: 'read' | 'write'): readonly FilePattern[] | 'open' => {
    if (reach.kind === 'open') return 'open'
    const found = reach.patterns.filter(
      (p) => (need === 'read' || p.access === 'read-write') && withinPattern(path, p),
    )
    if (found.length === 0) throw fail('not-granted')
    return found
  }

  /** The real path must still be within one of `patterns` (by its resolved root) and not forbidden. */
  const checkReal = async (
    real: string,
    patterns: readonly FilePattern[] | 'open',
    need: 'read' | 'write',
  ) => {
    const relative = homeRelative(real, home)
    if (touchesForbiddenPath(relative, home) || touchesForbiddenPath(real, home)) throw fail('denied-path')
    if (need === 'write' && !isWritablePath(relative)) throw fail('denied-path')
    if (patterns === 'open') return
    for (const p of patterns) {
      if (withinPattern(real, p) || withinPattern(real, p, await resolvedRoot(p.root))) return
    }
    throw fail('denied-path')
  }

  const requested = (value: unknown): string => {
    const path = checkRequestedPath(value, home)
    if (path === null) throw fail('invalid')
    return path
  }

  const entryOf = (name: string, stats: Stats): LocalFileEntry => ({
    name,
    kind: stats.isSymbolicLink()
      ? 'other'
      : stats.isFile()
        ? 'file'
        : stats.isDirectory()
          ? 'directory'
          : 'other',
    size: stats.size,
    modifiedAt: Math.trunc(stats.mtimeMs),
  })

  /** Opens a regular file at its real path, checking it is the file the path names now. */
  const openChecked = async (real: string, flags: number) => {
    // Opening a FIFO or a device can block or do something; only a regular file is ever opened, and
    // O_NONBLOCK keeps a FIFO swapped in after this check from hanging the open.
    if (!(await lstat(real)).isFile()) throw fail('denied-path')
    const handle = await open(real, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const [held, named] = await Promise.all([handle.stat(), lstat(real)])
      if (!held.isFile() || held.dev !== named.dev || held.ino !== named.ino) throw fail('denied-path')
      // A second name for the same file is one the forbidden check never saw.
      if (held.nlink > 1) throw fail('denied-path')
      return { handle, stats: held }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  return {
    async list(dirValue: unknown) {
      try {
        const dir = requested(dirValue)
        const patterns = candidates(dir, 'read')
        const real = await realpath(dir)
        await checkReal(real, patterns, 'read')
        const names = (await readdir(real)).filter((n) => n.normalize('NFC') === n).sort()
        const entries: LocalFileEntry[] = []
        for (const name of names) {
          if (entries.length >= MAX_LIST_ENTRIES) break
          const child = join(dir, name)
          if (patterns !== 'open' && !patterns.some((p) => withinPattern(child, p))) continue
          const stats = await lstat(join(real, name)).catch(() => null)
          if (stats !== null) entries.push(entryOf(name, stats))
        }
        return entries
      } catch (error) {
        throw osError(error)
      }
    },

    async stat(pathValue: unknown) {
      try {
        const path = requested(pathValue)
        const patterns = candidates(path, 'read')
        const real = await realpath(path)
        await checkReal(real, patterns, 'read')
        return entryOf(basename(path), await lstat(real))
      } catch (error) {
        throw osError(error)
      }
    },

    async read(pathValue: unknown, options?: unknown) {
      try {
        const encoding = encodingOf(options)
        const path = requested(pathValue)
        const patterns = candidates(path, 'read')
        const real = await realpath(path)
        await checkReal(real, patterns, 'read')
        const { handle, stats } = await openChecked(real, constants.O_RDONLY)
        try {
          if (stats.size > MAX_FILE_BYTES) throw fail('invalid')
          const bytes = await handle.readFile()
          if (bytes.byteLength > MAX_FILE_BYTES) throw fail('invalid')
          return bytes.toString(encoding)
        } finally {
          await handle.close()
        }
      } catch (error) {
        throw osError(error)
      }
    },

    async write(pathValue: unknown, content: unknown, options?: unknown) {
      try {
        const encoding = encodingOf(options)
        if (typeof content !== 'string') throw fail('invalid')
        const bytes = Buffer.from(content, encoding)
        if (bytes.byteLength > MAX_FILE_BYTES) throw fail('invalid')
        const path = requested(pathValue)
        const patterns = candidates(path, 'write')
        const parent = await realpath(dirname(path))
        const name = basename(path)
        const real = join(parent, name)
        await checkReal(real, patterns, 'write')
        const existing = await lstat(real).catch(() => null)
        if (existing !== null && (!existing.isFile() || existing.nlink > 1)) throw fail('denied-path')
        const temp = join(parent, `.${name}.valet-${process.pid}-${Date.now()}`)
        const handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          await handle.writeFile(bytes)
        } finally {
          await handle.close()
        }
        // The folder must still be the one checked before the file takes its name.
        if ((await realpath(dirname(path)).catch(() => null)) !== parent) {
          await rm(temp, { force: true })
          throw fail('denied-path')
        }
        await rename(temp, real)
      } catch (error) {
        throw osError(error)
      }
    },

    async mkdir(dirValue: unknown) {
      try {
        const dir = requested(dirValue)
        const patterns = candidates(dir, 'write')
        // Check where it will land before creating anything: the nearest folder that exists, resolved.
        let existing = dir
        const missing: string[] = []
        for (;;) {
          const real = await realpath(existing).catch(() => null)
          if (real !== null) {
            await checkReal(join(real, ...missing.reverse()), patterns, 'write')
            break
          }
          missing.push(basename(existing))
          const up = dirname(existing)
          if (up === existing) throw fail('not-found')
          existing = up
        }
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await checkReal(await realpath(dir), patterns, 'write')
      } catch (error) {
        throw osError(error)
      }
    },
  } as LocalFiles
}
