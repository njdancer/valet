// The person's own 1Password, through the desktop app (DesktopAuth in @1password/sdk; C7, D7).
// Creating a client makes 1Password ask the person to approve Valet, naming the calling app; the
// approval lasts until ten idle minutes pass or 1Password locks. So this provider is for attended
// moments: setting up a Keychain copy, re-syncing it, and resolving when no copy exists.
//
// KeychainCopySync is where the copy is made. It reads fields straight from the SDK into buffers
// that go to the Keychain helper's stdin, so no SecretValue is revealed on the way.

import { CredentialError, type CredentialProvider, type SecretField, SecretValue } from '@valet/core'
import { type ItemRef, parseItemRef, secretReference } from './item-ref'
import { COPYABLE_FIELDS, type CopySource, type KeychainCopyProvider } from './keychain-copy'
import {
  ACTIVE_ONLY,
  classifySdkError,
  INTEGRATION,
  type ItemStateFilter,
  listVaultItems,
  loadOnePasswordSdk,
  type OnePasswordSdkLoader,
} from './onepassword-sdk'
import { nodeTimers, type Timers } from './process'
import { SdkSession } from './sdk-session'
import { summariseItems, type VaultItemLister, type VaultItemSummary } from './vault-items'

/** The slice of the SDK client the desktop provider uses. */
export interface DesktopClient {
  readonly secrets: { resolve(secretReference: string): Promise<string> }
  readonly vaults: { list(): Promise<readonly { readonly id: string; readonly title: string }[]> }
  readonly items: {
    list(
      vaultId: string,
      ...filters: ItemStateFilter[]
    ): Promise<readonly { readonly id: string; readonly title: string; readonly updatedAt?: unknown }[]>
  }
}

/** Creates a client for one 1Password account (its name as the app shows it, or its UUID). */
export type DesktopClientFactory = (account: string) => Promise<DesktopClient>

/** A desktop-app factory over `load`'s SDK (the real one, or the fake 1Password's). */
export function desktopAuthClientFactory(load: OnePasswordSdkLoader): DesktopClientFactory {
  return async (account) => {
    const sdk = await load()
    return (await sdk.createClient({ auth: new sdk.DesktopAuth(account), ...INTEGRATION })) as DesktopClient
  }
}

export const desktopClientFactory: DesktopClientFactory = desktopAuthClientFactory(loadOnePasswordSdk)

export interface OnePasswordDesktopOptions {
  readonly account: string
  readonly clientFactory?: DesktopClientFactory
  readonly timers?: Timers
  /** Bounds one call once the client is up. */
  readonly timeoutMs?: number
  /** Bounds creating the client, which waits for the person to approve in 1Password. */
  readonly approvalTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_APPROVAL_TIMEOUT_MS = 2 * 60_000
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** An account name or UUID DesktopAuth can be given. */
export function isOnePasswordAccount(value: string): boolean {
  return value.trim() === value && value.length > 0 && value.length <= 256 && !CONTROL.test(value)
}

/**
 * The SDK error when the person turned the integration off, denied the prompt or let it lapse.
 * These need the person; anything else is unavailable.
 */
function classifyDesktopError(error: unknown): { failure: CredentialError['failure']; dropClient: boolean } {
  const classified = classifySdkError(error)
  if (classified.failure !== 'unavailable') return classified
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (/denied|declined|cancel|not authori[sz]ed|locked|integration is (not enabled|disabled)/.test(message)) {
    return { failure: 'locked', dropClient: true }
  }
  return classified
}

export class OnePasswordDesktopProvider implements CredentialProvider, VaultItemLister {
  readonly kind = 'onepassword-desktop' as const
  readonly account: string
  readonly #session: SdkSession<DesktopClient>

  constructor(options: OnePasswordDesktopOptions) {
    if (!isOnePasswordAccount(options.account)) throw new Error('not a 1Password account name')
    this.account = options.account
    const factory = options.clientFactory ?? desktopClientFactory
    const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.#session = new SdkSession(
      () => this.#session.bounded(factory(this.account), approvalTimeoutMs),
      options.timers ?? nodeTimers,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  }

  /** Whether the person's approval is up: a call now won't prompt. */
  get live(): boolean {
    return this.#session.live
  }

  async resolve(itemRef: string, field: SecretField): Promise<SecretValue> {
    return SecretValue.fromBuffer(await this.readField(itemRef, field))
  }

  /** A field's value as a buffer the caller owns and zeroes. For the copy. */
  async readField(itemRef: string, field: SecretField): Promise<Buffer> {
    const ref = parseItemRef(itemRef)
    if (ref === null) throw new CredentialError('not-found')
    const value = await this.#session.use(
      (client) => client.secrets.resolve(secretReference(ref, field, 'totp')),
      classifyDesktopError,
    )
    if (typeof value !== 'string' || value.length === 0) throw new CredentialError('field-missing')
    return Buffer.from(value, 'utf8')
  }

  /** When the item last changed (its overview's updatedAt), without reading any of its fields. */
  async updatedAt(itemRef: string): Promise<string> {
    const ref = parseItemRef(itemRef)
    if (ref === null) throw new CredentialError('not-found')
    const items = await this.#session.use(
      (client) => client.items.list(ref.vault, ACTIVE_ONLY),
      classifyDesktopError,
    )
    const item = Array.isArray(items) ? items.find((candidate) => candidate?.id === ref.item) : undefined
    if (item === undefined) throw new CredentialError('not-found')
    const at = item.updatedAt instanceof Date ? item.updatedAt : new Date(String(item.updatedAt))
    if (Number.isNaN(at.getTime())) throw new CredentialError('unavailable')
    return at.toISOString()
  }

  /** The vaults the person can see: ids and titles only. */
  async listVaults(): Promise<readonly VaultItemSummary[]> {
    const vaults = await this.#session.use((client) => client.vaults.list(), classifyDesktopError)
    if (!Array.isArray(vaults)) throw new CredentialError('unavailable')
    return summariseItems(vaults)
  }

  listItems(vault: string): Promise<readonly VaultItemSummary[]> {
    return listVaultItems(this.#session, vault)
  }

  /** Forgets the approval, so the next call asks the person again. */
  reset(): void {
    this.#session.reset()
  }
}

export type SyncOutcome = 'copied' | 'current' | 'not-live'

export interface KeychainCopySyncOptions {
  readonly desktop: OnePasswordDesktopProvider
  readonly copies: KeychainCopyProvider
  readonly now?: () => Date
}

/**
 * Makes and refreshes Keychain copies from the person's 1Password (D6). Every read here goes
 * through the desktop app, so it runs only with the person there to approve, except
 * refreshIfLive(), which runs only when an approval is already up.
 */
export class KeychainCopySync {
  readonly #desktop: OnePasswordDesktopProvider
  readonly #copies: KeychainCopyProvider
  readonly #now: () => Date

  constructor(options: KeychainCopySyncOptions) {
    this.#desktop = options.desktop
    this.#copies = options.copies
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Copies `fields` of the item (setup, the settings action, or after a login failed on the
   * password). Asks the person to approve if no approval is up.
   */
  async copy(itemRef: string, fields: readonly SecretField[]): Promise<void> {
    const ref = refOrThrow(itemRef)
    const wanted = copyable(fields)
    const sourceUpdatedAt = await this.#desktop.updatedAt(itemRef)
    for (const field of wanted) {
      const value = await this.#desktop.readField(itemRef, field)
      await this.#copies.store(itemRef, value, this.#source(ref, field, sourceUpdatedAt))
    }
  }

  /**
   * When an approval is already up (so this can't prompt), refreshes the copy if the source item has
   * changed since it was made, or if a field has no copy. Never asks the person.
   */
  async refreshIfLive(itemRef: string, fields: readonly SecretField[]): Promise<SyncOutcome> {
    if (!this.#desktop.live) return 'not-live'
    const ref = refOrThrow(itemRef)
    const sourceUpdatedAt = await this.#desktop.updatedAt(itemRef)
    let changed = false
    for (const field of copyable(fields)) {
      const source = await this.#copies.source(itemRef, field)
      if (source?.sourceUpdatedAt === sourceUpdatedAt && source.account === this.#desktop.account) continue
      // The approval can lapse between calls; a lapsed one is not-live, never a prompt.
      if (!this.#desktop.live) return 'not-live'
      const value = await this.#desktop.readField(itemRef, field)
      await this.#copies.store(itemRef, value, this.#source(ref, field, sourceUpdatedAt))
      changed = true
    }
    return changed ? 'copied' : 'current'
  }

  #source(ref: ItemRef, field: SecretField, sourceUpdatedAt: string): CopySource {
    return {
      account: this.#desktop.account,
      vaultId: ref.vault,
      itemId: ref.item,
      field,
      sourceUpdatedAt,
      copiedAt: this.#now().toISOString(),
    }
  }
}

function refOrThrow(itemRef: string): ItemRef {
  const ref = parseItemRef(itemRef)
  if (ref === null) throw new CredentialError('not-found')
  return ref
}

function copyable(fields: readonly SecretField[]): SecretField[] {
  const wanted = COPYABLE_FIELDS.filter((field) => fields.includes(field))
  // A grant that asks for a field the copy can't hold (a TOTP secret) can't be served from a copy.
  if (wanted.length !== new Set(fields).size) throw new CredentialError('field-missing')
  return wanted
}
