// One file whose hash is anchored outside it (docs/agent-run-security.md#trusted-stores). The anchor
// lives in the Keychain under the app's designated requirement, so a process that can write the
// file can't also move the anchor (in a signed build). A write is two-phase:
//
//   beginWrite (anchor names the next hash) → write, fsync, rename → commitWrite
//
// so a crash between the two leaves a state `checkAnchor` recognises (`advance`). Loading never
// hides a bad state: `interrupted` and `mismatch` are returned for the caller to fail closed on.

import { randomBytes } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import {
  type AnchorCheck,
  type AnchorState,
  abandonWrite,
  beginWrite,
  checkAnchor,
  commitWrite,
  type StoreAnchor,
  ValetError,
} from '@valet/core'

export interface AnchoredLoad {
  readonly check: AnchorCheck
  /** The file's text, or null if there is none. Only to be trusted when `check` is ok or advance. */
  readonly text: string | null
}

export interface FileOps {
  read(path: string): Promise<string | null>
  /** Writes `text` to `path` atomically (temp file, fsync, rename), mode 0600. */
  write(path: string, text: string): Promise<void>
}

export const nodeFileOps: FileOps = {
  async read(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new ValetError('config', 'unavailable')
    }
  },
  async write(path, text) {
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(text, 'utf8')
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
  },
}

export class AnchoredFile {
  constructor(
    private readonly path: string,
    /** The anchor's name for this store, e.g. "trusted". */
    readonly store: string,
    private readonly anchor: StoreAnchor,
    private readonly files: FileOps = nodeFileOps,
  ) {}

  /** Reads the file and its anchor. An `advance` is committed here, so the caller sees `ok`-like. */
  async load(): Promise<AnchoredLoad> {
    const [text, state] = await Promise.all([this.files.read(this.path), this.anchor.read(this.store)])
    const check = checkAnchor(text, state)
    if (check === 'advance' && state !== null) await this.anchor.write(this.store, commitWrite(state))
    return { check, text }
  }

  /**
   * Writes `text` as the store's new content. Throws if any phase fails; the caller must then
   * treat the change as not made. A failure before the rename leaves the old file in place, so the
   * begun write is abandoned; a failure after it (the anchor's commit) leaves `advance` for the next
   * load, which keeps the new file.
   */
  async write(text: string): Promise<void> {
    let state = await this.anchor.read(this.store)
    if (state !== null && state.next !== null) {
      // An earlier commit of ours failed after its file was in place: that file is the truth.
      const current = await this.files.read(this.path)
      if (current === null || checkAnchor(current, state) !== 'advance') {
        throw new ValetError('config', 'unavailable')
      }
      state = commitWrite(state)
      await this.anchor.write(this.store, state)
    }
    const begun = beginWrite(state, text)
    await this.anchor.write(this.store, begun)
    try {
      await this.files.write(this.path, text)
    } catch (error) {
      await this.anchor.write(this.store, abandonWrite(begun)).catch(() => undefined)
      throw error
    }
    // Once the file is in place it is the store's content, whatever happens to the commit: a
    // failed commit leaves `advance`, which the next load or write completes. So it isn't thrown.
    await this.anchor
      .write(this.store, commitWrite(begun))
      .catch(() => this.anchor.write(this.store, commitWrite(begun)))
      .catch(() => undefined)
  }

  /**
   * After an `interrupted` or `mismatch` load, once the person has been told and has chosen to
   * start again at the Mac: forget any begun write and write `text` as the new content.
   */
  async reset(text: string): Promise<void> {
    const state = await this.anchor.read(this.store)
    if (state !== null && state.next !== null) await this.anchor.write(this.store, abandonWrite(state))
    await this.write(text)
  }
}

/** An anchor in memory, for tests and for dev builds without the Keychain helper. */
export class MemoryAnchor implements StoreAnchor {
  readonly states = new Map<string, AnchorState>()

  async read(store: string): Promise<AnchorState | null> {
    return this.states.get(store) ?? null
  }

  async write(store: string, state: AnchorState): Promise<void> {
    this.states.set(store, state)
  }
}
