// Where the Mac's approval keys and the trusted ledger's anchor come from in each kind of build
// (docs/approval-broker.md#approving-at-the-mac).
//
// - A packaged app: the Secure Enclave helper (valet-approver) signs only after Touch ID, and the
//   anchor is a Keychain item. Nothing else is ever used: with the helper missing, approvals are
//   unavailable rather than signed some weaker way.
// - A dev build: the helper when it's built and works. Otherwise software keys kept in a file in
//   the data folder, with a stand-in for Touch ID (a native dialog of the main process, or yes in
//   end-to-end tests), so a dev build's identity and evidence survive a restart.

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type AnchorState, anchorStateSchema, type StoreAnchor } from '@valet/core'
import type { KeychainStore } from '@valet/credentials'
import { z } from 'zod'
import { HelperSigner } from './helper-signer'
import { KeychainAnchor } from './keychain-anchor'
import { type MacSigner, newSoftwareKeys, type SoftwareKeys, SoftwareSigner } from './signer'

/** The trusted ledger's name for its anchor. */
export const TRUSTED_STORE = 'trusted'

/** What the service is given to approve with. */
export interface MacApprovalKeys {
  readonly signer: MacSigner
  readonly anchor: StoreAnchor
  /** What signs, for the diagnostics log: never a key. */
  readonly kind: 'secure-enclave' | 'software'
  /** Removes the ledger's anchor, on a reset or an uninstall, so the new data folder opens fresh. */
  forget(): Promise<void>
}

/**
 * An anchor in a file beside the store. It only catches accidents: anything that can write the
 * store can write this too. Dev builds without the Keychain helper and tests only.
 */
export class FileAnchor implements StoreAnchor {
  constructor(private readonly path: string) {}

  async read(store: string): Promise<AnchorState | null> {
    const all = await this.all()
    const state = all[store]
    return state === undefined ? null : anchorStateSchema.parse(state)
  }

  async write(store: string, state: AnchorState): Promise<void> {
    const all = await this.all()
    all[store] = anchorStateSchema.parse(state)
    await writeAtomic(this.path, JSON.stringify(all))
  }

  async forget(): Promise<void> {
    await rm(this.path, { force: true })
  }

  private async all(): Promise<Record<string, unknown>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    return z.record(z.string(), z.unknown()).parse(JSON.parse(text))
  }
}

const softwareKeysSchema = z
  .object({
    approval: z.string().regex(/^[A-Za-z0-9_-]{1,400}$/),
    transport: z.string().regex(/^[A-Za-z0-9_-]{1,400}$/),
    agreement: z.string().regex(/^[A-Za-z0-9_-]{1,400}$/),
  })
  .strict()

/** A dev build's software keys: read from `path`, or made and written there (mode 0600) on first use. */
export async function softwareKeysAt(path: string): Promise<SoftwareKeys> {
  let text: string | null = null
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (text !== null) {
    // Never made again over a damaged file: new keys would be a new Mac, and every approval void.
    const parsed = softwareKeysSchema.safeParse(
      (() => {
        try {
          return JSON.parse(text)
        } catch {
          return null
        }
      })(),
    )
    if (!parsed.success)
      throw new Error(`the dev build's approval keys in ${path} are damaged; delete the file to start again`)
    await chmod(path, 0o600)
    return parsed.data
  }
  const keys = newSoftwareKeys()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeAtomic(path, JSON.stringify(keys))
  return keys
}

export interface MacApprovalKeysOptions {
  readonly packaged: boolean
  /** valet-approver's path, or null when this build has none. */
  readonly approverPath: string | null
  /** The Keychain through valet-keychain, or null when this build has none. */
  readonly keychain: KeychainStore | null
  /** The Keychain service the anchor is kept under (ANCHOR_SERVICE for a release build). */
  readonly anchorService: string
  /** Files a dev build keeps instead: its software keys and its anchor. */
  readonly devKeysPath: string
  readonly devAnchorPath: string
  /** A dev build's stand-in for Touch ID when it signs in software. */
  readonly devPresent: (reason: string) => boolean | Promise<boolean>
  readonly log?: (line: string) => void
}

/** An anchor that can't be read: the ledger opens locked down, and nothing it holds is honoured. */
const missingAnchor: StoreAnchor = {
  async read() {
    throw new Error('no anchor store')
  },
  async write() {
    throw new Error('no anchor store')
  },
}

export async function macApprovalKeys(options: MacApprovalKeysOptions): Promise<MacApprovalKeys> {
  const keychainAnchor =
    options.keychain === null ? null : new KeychainAnchor(options.keychain, options.anchorService)
  if (options.packaged) {
    const signer: MacSigner =
      options.approverPath === null
        ? {
            keys: () => Promise.reject(new Error('no approver')),
            signDecision: async () => null,
          }
        : new HelperSigner({ helperPath: options.approverPath })
    return {
      signer,
      anchor: keychainAnchor ?? missingAnchor,
      kind: 'secure-enclave',
      forget: async () => {
        await keychainAnchor?.forget(TRUSTED_STORE)
      },
    }
  }
  const fileAnchor = new FileAnchor(options.devAnchorPath)
  const anchor = keychainAnchor ?? fileAnchor
  const forget = async () => {
    await (keychainAnchor === null ? fileAnchor.forget() : keychainAnchor.forget(TRUSTED_STORE))
  }
  if (options.approverPath !== null) {
    const helper = new HelperSigner({ helperPath: options.approverPath })
    try {
      // An unsigned debug helper may not reach the Secure Enclave; a dev build then signs in software.
      await helper.keys()
      return { signer: helper, anchor, kind: 'secure-enclave', forget }
    } catch {
      options.log?.('approvals: the approver helper is unavailable; signing in software (dev build)')
    }
  }
  const keys = await softwareKeysAt(options.devKeysPath)
  return { signer: new SoftwareSigner(options.devPresent, keys), anchor, kind: 'software', forget }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
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
