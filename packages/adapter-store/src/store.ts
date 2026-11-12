// Where installed adapter versions live (docs/adapter-packages.md#storage):
//
//   <dir>/<adapter id>/state.json        the active version, whether it's pinned, the history
//   <dir>/<adapter id>/<adapter hash>.json   one file per version, written once
//
// The only names on disk are the adapter id and the hash; nothing from inside a package is ever a
// file name. A version is re-checked and re-hashed every time it's read. state.json is a cache of
// the person's choices: the approval store, not this file, decides what runs, since an adapter has
// at most one approved hash and a version whose hash isn't it lists no tools.

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type CheckedPackage, checkPackage, PackageError, type PackageFiles } from '@valet/core'
import { isErrno, writeFileAtomic } from '@valet/runtime'
import { z } from 'zod'
import type { BuildRecord } from './load'

export const ADAPTER_ID = /^[a-z][a-z0-9-]{1,63}$/
const HASH = /^[0-9a-f]{64}$/
/** Versions kept per adapter. The active one, and any `keep` names, are never dropped. */
export const MAX_VERSIONS = 20

export const SOURCES = ['builtin', 'folder', 'draft'] as const
export type PackageSource = (typeof SOURCES)[number]

export interface StoredVersion {
  readonly hash: string
  readonly packageHash: string
  readonly version: string
  readonly source: PackageSource
  readonly installedAt: string
  readonly build: BuildRecord
}

export interface AdapterState {
  readonly active: string
  /** The person chose this version (a rollback or their own package): a new built-in doesn't replace it. */
  readonly pinned: boolean
  readonly versions: readonly StoredVersion[]
}

export type StoreProblem =
  | 'unreadable'
  | 'missing'
  | 'hash-mismatch'
  | 'id-mismatch'
  | 'invalid'
  | 'draft-unsandboxed'

export class StoreError extends Error {
  constructor(
    readonly problem: StoreProblem,
    readonly detail: string,
  ) {
    super(`adapter store (${problem}): ${detail}`)
    this.name = 'StoreError'
  }
}

const buildSchema = z
  .object({
    appVersion: z.string().max(40),
    preludeHash: z.string().regex(HASH),
    compiler: z.string().max(60),
  })
  .strict()
const versionSchema = z
  .object({
    hash: z.string().regex(HASH),
    packageHash: z.string().regex(HASH),
    version: z.string().max(40),
    source: z.enum(SOURCES),
    installedAt: z.iso.datetime(),
    build: buildSchema,
  })
  .strict()
const stateSchema = z
  .object({
    version: z.literal(1),
    active: z.string().regex(HASH),
    pinned: z.boolean(),
    // Kept versions (approved, with grants) may hold the count above MAX_VERSIONS.
    versions: z
      .array(versionSchema)
      .min(1)
      .max(MAX_VERSIONS * 2),
  })
  .strict()
  .refine((s) => s.versions.some((v) => v.hash === s.active), 'active must be a stored version')
const fileSchema = z.object({ format: z.literal(1), files: z.record(z.string(), z.string()) }).strict()

export interface PutOptions {
  readonly source: PackageSource
  readonly build: BuildRecord
  readonly now: Date
  /** Make it active. Default true. */
  readonly activate?: boolean
  /** Pin it. Default: true for anything but a built-in. */
  readonly pin?: boolean
  /** Hashes that must not be dropped to keep within MAX_VERSIONS: the approved one, any with grants. */
  readonly keep?: ReadonlySet<string>
}

export class AdapterStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {}

  /** The ids with a state file, sorted. */
  async ids(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw new StoreError('unreadable', 'adapters folder')
    }
    return entries.filter((e) => ADAPTER_ID.test(e)).sort()
  }

  /** The adapter's state, or null when nothing is stored. Throws StoreError('unreadable') otherwise. */
  async state(id: string): Promise<AdapterState | null> {
    checkId(id)
    let text: string
    try {
      text = await readFile(join(this.dir, id, 'state.json'), 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null
      throw new StoreError('unreadable', `${id} state`)
    }
    let parsed: z.infer<typeof stateSchema>
    try {
      parsed = stateSchema.parse(JSON.parse(text))
    } catch {
      throw new StoreError('unreadable', `${id} state`)
    }
    return { active: parsed.active, pinned: parsed.pinned, versions: parsed.versions }
  }

  /**
   * Reads one version back, checking it again: the package rules, its hash against the file's name,
   * and its manifest's id against the folder's. Throws StoreError.
   */
  async read(id: string, hash: string): Promise<CheckedPackage> {
    checkId(id)
    if (!HASH.test(hash)) throw new StoreError('invalid', 'hash')
    let text: string
    try {
      text = await readFile(join(this.dir, id, `${hash}.json`), 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) throw new StoreError('missing', `${id} ${hash.slice(0, 12)}`)
      throw new StoreError('unreadable', `${id} ${hash.slice(0, 12)}`)
    }
    let files: PackageFiles
    try {
      files = fileSchema.parse(JSON.parse(text)).files
    } catch {
      throw new StoreError('invalid', `${id} ${hash.slice(0, 12)}`)
    }
    let checked: CheckedPackage
    try {
      checked = checkPackage(files)
    } catch (error) {
      throw new StoreError('invalid', error instanceof PackageError ? error.rule : 'package')
    }
    if (checked.adapterHash !== hash) throw new StoreError('hash-mismatch', `${id} ${hash.slice(0, 12)}`)
    if (checked.manifest.id !== id) throw new StoreError('id-mismatch', `${id} ${hash.slice(0, 12)}`)
    return checked
  }

  /**
   * Stores a checked package (if its hash isn't stored already) and records it in the history.
   * Refuses the draft source until the sandbox exists (B's review, point 1): describing a draft runs
   * code nobody has approved in a full Node process. Returns the new state.
   */
  put(checked: CheckedPackage, options: PutOptions): Promise<AdapterState> {
    if (options.source === 'draft')
      return Promise.reject(
        new StoreError('draft-unsandboxed', 'drafts install only once the sandbox exists'),
      )
    return this.serial(async () => {
      const id = checked.manifest.id
      checkId(id)
      const folder = join(this.dir, id)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const hash = checked.adapterHash
      const current = await this.state(id).catch(() => null)
      const stored = current?.versions.find((v) => v.hash === hash)
      // Always written: the content is fixed by the hash, so writing it again repairs a damaged
      // file when the same package is installed again (or a built-in heals).
      await writeFileAtomic(join(folder, `${hash}.json`), JSON.stringify({ format: 1, files: checked.files }))
      const entry: StoredVersion = stored ?? {
        hash,
        packageHash: checked.packageHash,
        version: checked.manifest.version,
        source: options.source,
        installedAt: options.now.toISOString(),
        build: options.build,
      }
      const activate = options.activate ?? true
      const active = activate || current === null ? hash : current.active
      const pinned = activate ? (options.pin ?? options.source !== 'builtin') : (current?.pinned ?? false)
      const others = (current?.versions ?? []).filter((v) => v.hash !== hash)
      const keep = new Set([active, ...(options.keep ?? [])])
      const versions = trim([...others, entry], keep, active)
      const dropped = (current?.versions ?? []).filter((v) => !versions.some((w) => w.hash === v.hash))
      const state: AdapterState = { active, pinned, versions }
      await this.writeState(id, state)
      for (const old of dropped) await rm(join(folder, `${old.hash}.json`), { force: true })
      return state
    })
  }

  /** Makes a stored version active (a rollback), or sets pinning. Throws StoreError('missing'). */
  activate(id: string, hash: string, pinned: boolean): Promise<AdapterState> {
    return this.serial(async () => {
      const current = await this.state(id)
      if (current === null || !current.versions.some((v) => v.hash === hash))
        throw new StoreError('missing', `${id} ${hash.slice(0, 12)}`)
      const state: AdapterState = { ...current, active: hash, pinned }
      await this.writeState(id, state)
      return state
    })
  }

  private async writeState(id: string, state: AdapterState): Promise<void> {
    await writeFileAtomic(
      join(this.dir, id, 'state.json'),
      `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`,
    )
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }
}

/** Oldest first; drops the oldest that isn't kept until within MAX_VERSIONS. */
function trim(versions: StoredVersion[], keep: ReadonlySet<string>, active: string): StoredVersion[] {
  const out = [...versions]
  while (out.length > MAX_VERSIONS) {
    const index = out.findIndex((v) => !keep.has(v.hash))
    if (index === -1) break
    out.splice(index, 1)
  }
  // Kept versions may hold the count above MAX_VERSIONS, but never past what state.json may hold:
  // past that the oldest kept one goes too (its grants then name a version no longer stored).
  while (out.length > MAX_VERSIONS * 2) {
    const index = out.findIndex((v) => v.hash !== active)
    if (index === -1) break
    out.splice(index, 1)
  }
  return out
}

function checkId(id: string): void {
  if (!ADAPTER_ID.test(id)) throw new StoreError('invalid', 'adapter id')
}
