// The app's side of adapter packages (docs/adapter-packages.md): the built-ins seeded into the
// store at launch, every active version loaded from the store (re-checked, re-hashed, compiled and
// described each time), installs and rollbacks. Electron-free; app.ts gives it the tool process.

import {
  type AdapterStore,
  type BuildRecord,
  LoadError,
  type LoadedPackage,
  loadPackage,
  type PackageRuntime,
  type PackageSource,
  type AdapterState as StoredState,
  StoreError,
} from '@valet/adapter-store'
import {
  type AuditRecord,
  type AuditSink,
  type CheckedPackage,
  checkPackage,
  PackageError,
  type PackageFiles,
} from '@valet/core'
import { type BuiltinAdapter, builtinAdapter } from './registry'

/** A loaded version, as the service registers it, with where it came from. */
export interface InstalledAdapter extends BuiltinAdapter {
  readonly source: PackageSource
}

/** A version checked, compiled and described, not yet stored. */
export interface PreparedInstall {
  readonly loaded: LoadedPackage
  readonly source: PackageSource
  readonly adapter: InstalledAdapter
}

/** Hashes the store must not drop for an adapter: the approved one and any with grants. */
export type KeepHashes = (adapterId: string) => Promise<ReadonlySet<string>>

export interface PackageManagerOptions {
  readonly store: AdapterStore
  readonly runtime: PackageRuntime
  readonly build: BuildRecord
  readonly audit: AuditSink
  readonly now: () => Date
  readonly keep: KeepHashes
}

/** Why an install was refused, in words for the person or their agent. Never file contents. */
export class InstallError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'InstallError'
  }
}

export class PackageManager {
  constructor(private readonly options: PackageManagerOptions) {}

  private readonly shippedHashes = new Map<string, string>()

  /**
   * Whether this is the hash this app ships for the adapter: the only thing that makes an adapter
   * built in. A stored version's source tag is a plain file anyone can write, so it never does.
   */
  isShipped(adapterId: string, adapterHash: string): boolean {
    return this.shippedHashes.get(adapterId) === adapterHash
  }

  /**
   * Seeds each built-in that isn't stored yet (active unless the person pinned another version),
   * then loads every stored adapter's active version. A version that fails its checks is audited
   * as adapter-refused and not run; a built-in then falls back to the app's own copy, which is
   * written back if it was the one damaged.
   */
  async boot(builtins: readonly PackageFiles[]): Promise<InstalledAdapter[]> {
    const { store } = this.options
    const shipped = new Map<string, CheckedPackage>()
    for (const files of builtins) {
      const checked = checkPackage(files)
      shipped.set(checked.manifest.id, checked)
      this.shippedHashes.set(checked.manifest.id, checked.adapterHash)
      const state = await store.state(checked.manifest.id).catch(() => null)
      if (state?.versions.some((v) => v.hash === checked.adapterHash) === true) continue
      await this.put(checked, 'builtin', { activate: state === null || !state.pinned, pin: false }, state)
    }
    const loaded: InstalledAdapter[] = []
    for (const id of await store.ids()) {
      const builtin = shipped.get(id)
      const adapter = await this.loadActive(id, builtin)
      if (adapter !== null) loaded.push(adapter)
    }
    // Built-ins first, in the order the app ships them, then anything else by id.
    const order = [...shipped.keys()]
    const rank = (a: InstalledAdapter): number => {
      const index = order.indexOf(a.definition.manifest.id)
      return index === -1 ? order.length : index
    }
    return loaded.sort((a, b) => rank(a) - rank(b))
  }

  /**
   * Checks, compiles and describes `files`, storing nothing: the caller swaps the result in and
   * only then commits it. Throws InstallError with the first problem. Describing runs the package's
   * code, in the sandbox for every source (the app's runtime.start, docs/sandbox.md), so a draft
   * nobody has approved yet runs nowhere else.
   */
  async prepare(files: PackageFiles, source: PackageSource): Promise<PreparedInstall> {
    let loaded: LoadedPackage
    try {
      loaded = await loadPackage(files, this.options.runtime)
    } catch (error) {
      throw new InstallError(describeFailure(error))
    }
    return this.prepared(loaded, source)
  }

  /** A package already checked and described (a draft's check), ready to install or stage. */
  prepared(loaded: LoadedPackage, source: PackageSource): PreparedInstall {
    // The contract refuses these too; a second line, until Apple Events are typed operations.
    const sandbox = loaded.manifest.sandbox
    if (sandbox?.mode === 'sandboxed' && sandbox.exceptions.some((e) => e.kind === 'app'))
      throw new InstallError('Apple Events exceptions aren’t supported yet.')
    return { loaded, source, adapter: toInstalled(loaded, source) }
  }

  /** Stores a prepared version and makes it active, auditing adapter-installed. */
  async commit(prepared: PreparedInstall): Promise<void> {
    const state = await this.options.store.state(prepared.loaded.manifest.id).catch(() => null)
    await this.put(prepared.loaded, prepared.source, { activate: true }, state)
  }

  /**
   * Stores a prepared version without making it active: a draft submitted as an update waits here
   * while the installed version keeps serving (docs/authoring-tools.md#submitting). Its approval's
   * apply loads and activates it, as a rollback does. Not audited as installed until then.
   */
  async stage(prepared: PreparedInstall): Promise<void> {
    const state = await this.options.store.state(prepared.loaded.manifest.id).catch(() => null)
    if (state === null)
      throw new InstallError('A first install isn’t staged; it is installed and waits for approval.')
    await this.put(prepared.loaded, prepared.source, { activate: false }, state)
  }

  /** Drops a staged version nobody needs any more (see AdapterStore.discard). */
  discard(adapterId: string, hash: string): Promise<boolean> {
    return this.options.store.discard(adapterId, hash)
  }

  /** Whether this app ships an adapter with this id: it comes back at every launch. */
  isBuiltinId(adapterId: string): boolean {
    return this.shippedHashes.has(adapterId)
  }

  /** Removes every stored version of a site that isn't built in. */
  remove(adapterId: string): Promise<boolean> {
    if (this.isBuiltinId(adapterId))
      return Promise.reject(new InstallError('A built-in site can’t be removed.'))
    return this.options.store.remove(adapterId)
  }

  /** The adapter's history, or null. */
  versions(adapterId: string): Promise<StoredState | null> {
    return this.options.store.state(adapterId).catch(() => null)
  }

  /** Loads a stored version without activating it (a rollback's target). Throws InstallError. */
  /**
   * Every file of a stored version, its manifest, tests and fixtures as well as its code, for a
   * draft that starts from it. Null when the store doesn't hold that version.
   */
  async files(adapterId: string, hash: string): Promise<PackageFiles | null> {
    return (await this.options.store.read(adapterId, hash).catch(() => null))?.files ?? null
  }

  async load(adapterId: string, hash: string): Promise<InstalledAdapter> {
    const state = await this.options.store.state(adapterId)
    const entry = state?.versions.find((v) => v.hash === hash)
    if (entry === undefined) throw new InstallError('That version is not stored.')
    try {
      const checked = await this.options.store.read(adapterId, hash)
      return toInstalled(await loadPackage(checked.files, this.options.runtime), entry.source)
    } catch (error) {
      await this.refused(adapterId, hash, error)
      throw new InstallError(describeFailure(error))
    }
  }

  /** Makes a stored version the active one, pinned. */
  async activate(adapterId: string, hash: string): Promise<void> {
    await this.options.store.activate(adapterId, hash, true)
  }

  private async loadActive(
    id: string,
    builtin: CheckedPackage | undefined,
  ): Promise<InstalledAdapter | null> {
    const { store } = this.options
    const state = await store.state(id).catch(() => null)
    let damaged = state === null
    if (state !== null) {
      const entry = state.versions.find((v) => v.hash === state.active)
      try {
        const checked = await store.read(id, state.active)
        return toInstalled(await this.loadRetrying(checked.files), entry?.source ?? 'folder')
      } catch (error) {
        await this.refused(id, state.active, error)
        // Only a stored version that is missing or isn't what its hash says is damaged. A compile
        // or describe that failed (a slow launch, say) leaves the person's choice as it is.
        damaged = error instanceof StoreError
      }
    }
    if (builtin === undefined) return null
    // The app's own copy. If the stored one was damaged it is written back and made active,
    // unpinned; otherwise it serves for this launch only. Either way it needs approval again only
    // if its hash isn't the approved one.
    if (damaged) await this.put(builtin, 'builtin', { activate: true, pin: false }, state)
    try {
      return toInstalled(await loadPackage(builtin.files, this.options.runtime), 'builtin')
    } catch (error) {
      await this.refused(id, builtin.adapterHash, error)
      return null
    }
  }

  private async put(
    checked: CheckedPackage,
    source: PackageSource,
    how: { readonly activate: boolean; readonly pin?: boolean },
    before: StoredState | null,
  ): Promise<void> {
    const id = checked.manifest.id
    await this.options.store.put(checked, {
      source,
      build: this.options.build,
      now: this.options.now(),
      activate: how.activate,
      ...(how.pin === undefined ? {} : { pin: how.pin }),
      keep: await this.options.keep(id),
    })
    if (!how.activate) return
    const previousHash = before?.active ?? null
    if (previousHash === checked.adapterHash) return
    await this.options.audit.append({
      type: 'adapter-installed',
      adapterId: id,
      adapterHash: checked.adapterHash,
      version: checked.manifest.version,
      source,
      previousHash,
      ...this.options.build,
    })
  }

  /** Loads, once more after a failure that isn't the package's own (the tool process, a timeout). */
  private async loadRetrying(files: PackageFiles): Promise<LoadedPackage> {
    try {
      return await loadPackage(files, this.options.runtime)
    } catch (error) {
      if (!(error instanceof LoadError) || error.stage !== 'describe') throw error
      return loadPackage(files, this.options.runtime)
    }
  }

  private async refused(adapterId: string, adapterHash: string, error: unknown): Promise<void> {
    const reason =
      error instanceof StoreError ? error.problem : error instanceof LoadError ? error.stage : 'invalid'
    await this.options.audit
      .append({ type: 'adapter-refused', adapterId, adapterHash, reason })
      .catch(() => undefined)
  }
}

/** Development builds: asks the person for a folder (a picker in the main process) and reads it. */
export interface FolderInstall {
  /** The package's files, or null if the person cancelled. Throws InstallError if it can't be read. */
  pick(): Promise<PackageFiles | null>
}

/**
 * The hashes of `adapterId` a rollback may go to: each one whose latest decision in the audit log
 * is adapter-approved, so a version rejected after it was approved never comes back.
 */
export function rollbackEligible(records: readonly AuditRecord[], adapterId: string): Set<string> {
  const last = new Map<string, 'approved' | 'rejected'>()
  for (const { event } of records) {
    if (event.type !== 'adapter-approved' && event.type !== 'adapter-rejected') continue
    if (event.adapterId !== adapterId) continue
    last.set(event.adapterHash, event.type === 'adapter-approved' ? 'approved' : 'rejected')
  }
  return new Set([...last].filter(([, decision]) => decision === 'approved').map(([hash]) => hash))
}

function toInstalled(loaded: LoadedPackage, source: PackageSource): InstalledAdapter {
  const sources: Record<string, string> = {}
  for (const [path, text] of Object.entries(loaded.files)) if (path.startsWith('src/')) sources[path] = text
  const adapter = builtinAdapter(loaded.definition, sources, loaded.script)
  // The same formula; a mismatch would mean approvals keyed by one hash running another's code.
  if (adapter.hash !== loaded.adapterHash) throw new InstallError('The package hash did not match.')
  return { ...adapter, source }
}

/** An install's failure in words for the person, from any error the install path throws. */
export function installReason(error: unknown): string {
  return describeFailure(error)
}

function describeFailure(error: unknown): string {
  if (error instanceof PackageError) return `The package breaks a rule (${error.rule}): ${error.detail}`
  if (error instanceof LoadError) return `The package did not load (${error.stage}): ${error.detail}`
  if (error instanceof StoreError) return `The stored version can't be used (${error.problem}).`
  if (error instanceof InstallError) return error.detail
  return 'The package could not be installed.'
}
