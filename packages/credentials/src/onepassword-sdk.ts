// Resolves secrets with a 1Password service account through @1password/sdk. The client is created
// lazily from a token the TokenSource hands out, cached, and dropped when 1Password rejects its auth.
// The SDK is reached only through an injected factory, so tests never load it.

import {
  CredentialError,
  type CredentialProvider,
  type SecretField,
  SecretValue,
  type TokenSource,
} from '@valet/core'
import { parseItemRef, secretReference } from './item-ref'
import { nodeTimers, type Timers } from './process'
import { SdkSession } from './sdk-session'
import { isVaultName, summariseItems, type VaultItemLister, type VaultItemSummary } from './vault-items'

/** The SDK's item filter, as `items.list` takes it. */
export interface ItemStateFilter {
  readonly type: 'ByState'
  readonly content: { readonly active: boolean; readonly archived: boolean }
}

/** The slice of the SDK client this provider uses. */
export interface SecretsClient {
  readonly secrets: { resolve(secretReference: string): Promise<string> }
  /** Vault overviews: id, title and counts. Never item contents. */
  readonly vaults: { list(): Promise<readonly { readonly id: string; readonly title: string }[]> }
  /** Item overviews (id, title, category, websites, tags, dates). Never field values. */
  readonly items: {
    list(
      vaultId: string,
      ...filters: ItemStateFilter[]
    ): Promise<readonly { readonly id: string; readonly title: string }[]>
  }
}

// Only items the person can use: archived and deleted ones can't be resolved.
export const ACTIVE_ONLY: ItemStateFilter = { type: 'ByState', content: { active: true, archived: false } }

/** Creates a client from a token. The provider disposes the token once this settles. */
export type SecretsClientFactory = (token: SecretValue) => Promise<SecretsClient>

/**
 * The real factory. The SDK takes its token as a string, so this is one of the few places outside
 * the privileged filler that reveals a secret; the plaintext goes straight to the SDK.
 */
export const sdkClientFactory: SecretsClientFactory = async (token) => {
  const sdk = await import('@1password/sdk')
  return token.reveal((plaintext) =>
    sdk.createClient({ auth: plaintext, integrationName: 'valet', integrationVersion: '0.0.0' }),
  )
}

export interface OnePasswordServiceAccountOptions {
  readonly tokenSource: TokenSource
  readonly clientFactory?: SecretsClientFactory
  readonly timers?: Timers
  /** Bounds one resolve, which is a network round trip to 1Password. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export class OnePasswordServiceAccountProvider implements CredentialProvider, VaultItemLister {
  readonly kind = 'onepassword-service-account' as const
  readonly #tokenSource: TokenSource
  readonly #clientFactory: SecretsClientFactory
  readonly #session: SdkSession<SecretsClient>

  constructor(options: OnePasswordServiceAccountOptions) {
    this.#tokenSource = options.tokenSource
    this.#clientFactory = options.clientFactory ?? sdkClientFactory
    this.#session = new SdkSession(
      () => this.#createClient(),
      options.timers ?? nodeTimers,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  }

  async resolve(itemRef: string, field: SecretField): Promise<SecretValue> {
    const ref = parseItemRef(itemRef)
    if (ref === null) throw new CredentialError('not-found')
    const reference = secretReference(ref, field, 'totp')
    const value = await this.#session.use((client) => client.secrets.resolve(reference), classifySdkError)
    if (value.length === 0) throw new CredentialError('field-missing')
    return SecretValue.fromString(value)
  }

  /**
   * Lists the vault's active items through the same client resolve uses, so the token goes nowhere
   * but sdkClientFactory. `vault` is matched against the vaults the account can see, by exact id or
   * exact title; none, or more than one, is not-found. Only ids and titles leave this method.
   */
  listItems(vault: string): Promise<readonly VaultItemSummary[]> {
    return listVaultItems(this.#session, vault)
  }

  async #createClient(): Promise<SecretsClient> {
    let token: SecretValue
    try {
      token = await this.#tokenSource.token()
    } catch (error) {
      // The token is the provider's own configuration, not the grant's item. A missing token means the
      // service account isn't set up, which re-granting the item would not fix, so it is unavailable.
      const locked = error instanceof CredentialError && error.failure === 'locked'
      throw new CredentialError(locked ? 'locked' : 'unavailable')
    }
    try {
      return await this.#session.bounded(this.#clientFactory(token))
    } finally {
      token.dispose()
    }
  }
}

/** A vault's active items, by the vault's exact id or title, through `session`'s client. */
export async function listVaultItems(
  session: SdkSession<Pick<SecretsClient, 'vaults' | 'items'>>,
  vault: string,
): Promise<readonly VaultItemSummary[]> {
  if (!isVaultName(vault)) throw new CredentialError('not-found')
  const listed = await session.use(
    async (client) => {
      const vaults = await session.bounded(client.vaults.list())
      const matches = Array.isArray(vaults) ? vaults.filter((v) => v?.id === vault || v?.title === vault) : []
      const only = matches.length === 1 ? matches[0] : undefined
      if (only === undefined || typeof only.id !== 'string') throw new CredentialError('not-found')
      return (await client.items.list(only.id, ACTIVE_ONLY)) as unknown
    },
    (error) => {
      const classified = classifySdkError(error)
      // A listing has no field to miss.
      return classified.failure === 'field-missing' ? { ...classified, failure: 'unavailable' } : classified
    },
  )
  if (!Array.isArray(listed)) throw new CredentialError('unavailable')
  return summariseItems(listed)
}

// The SDK's messages, from its error strings. Matched as phrases because only the class name of
// the three typed errors is stable.
const AUTH =
  /invalid service account token|bad service account token|service account token base64|service account deserialization|you are not authenticated|auth(entication)? (has )?expired/
const FIELD_MISSING =
  /field cannot be found|no section matched|more than one field matched|totp attribute can only be applied|totp code could not be generated/
const NOT_FOUND =
  /no vault matched|no item matched|more than one (vault|item) matched|item is not in an active state|resource not found|you don't have the right permissions|secret reference could not be parsed|secret reference (is not prefixed|has invalid)|invalid character in secret reference/

/** Maps an SDK error to a failure, and says whether the cached client must be dropped. */
export function classifySdkError(error: unknown): {
  failure: CredentialError['failure']
  dropClient: boolean
} {
  const { name, message } = describeError(error)
  if (name === 'DesktopSessionExpiredError') return { failure: 'locked', dropClient: true }
  if (name === 'AuthExpiredError' || AUTH.test(message)) return { failure: 'unavailable', dropClient: true }
  if (FIELD_MISSING.test(message)) return { failure: 'field-missing', dropClient: false }
  if (NOT_FOUND.test(message)) return { failure: 'not-found', dropClient: false }
  return { failure: 'unavailable', dropClient: false }
}

/** The class name and lowercased message of anything thrown, without ever throwing itself. */
function describeError(error: unknown): { name: unknown; message: string } {
  try {
    const name =
      typeof error === 'object' && error !== null
        ? (error as { constructor?: { name?: unknown } }).constructor?.name
        : undefined
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
    return { name, message }
  } catch {
    // A null-prototype object can't be stringified, and a getter can throw; neither is a known error.
    return { name: undefined, message: '' }
  }
}
