// Resolves secrets with a 1Password service account through @1password/sdk. The client is created
// lazily from a token the TokenSource hands out, cached, and dropped when 1Password rejects its auth.
// The SDK is reached only through an injected factory, so tests never load it.

import {
  CredentialError,
  type CredentialProvider,
  type SecretField,
  SecretValue,
  type TokenSource,
} from '@siteadapter/core'
import { parseItemRef, secretReference } from './item-ref'
import { nodeTimers, type Timers } from './process'

/** The slice of the SDK client this provider uses. */
export interface SecretsClient {
  readonly secrets: { resolve(secretReference: string): Promise<string> }
}

/** Creates a client from a token. The provider disposes the token once this settles. */
export type SecretsClientFactory = (token: SecretValue) => Promise<SecretsClient>

/**
 * The real factory. The SDK takes its token as a string, so this is one of the few places outside
 * the privileged filler that reveals a secret; the plaintext goes straight to the SDK.
 */
export const sdkClientFactory: SecretsClientFactory = async (token) => {
  const sdk = await import('@1password/sdk')
  return token.reveal((plaintext) =>
    sdk.createClient({ auth: plaintext, integrationName: 'siteadapter', integrationVersion: '0.0.0' }),
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

export class OnePasswordServiceAccountProvider implements CredentialProvider {
  readonly kind = 'onepassword-service-account' as const
  readonly #tokenSource: TokenSource
  readonly #clientFactory: SecretsClientFactory
  readonly #timers: Timers
  readonly #timeoutMs: number
  #client: Promise<SecretsClient> | null = null

  constructor(options: OnePasswordServiceAccountOptions) {
    this.#tokenSource = options.tokenSource
    this.#clientFactory = options.clientFactory ?? sdkClientFactory
    this.#timers = options.timers ?? nodeTimers
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async resolve(itemRef: string, field: SecretField): Promise<SecretValue> {
    const ref = parseItemRef(itemRef)
    if (ref === null) throw new CredentialError('not-found')
    const reference = secretReference(ref, field, 'totp')
    const pending = this.#currentClient()
    let value: string
    try {
      const client = await pending
      value = await this.#bounded(client.secrets.resolve(reference))
    } catch (error) {
      if (error instanceof CredentialError) throw new CredentialError(error.failure)
      const { failure, dropClient } = classifySdkError(error)
      if (dropClient) this.#drop(pending)
      throw new CredentialError(failure)
    }
    if (value.length === 0) throw new CredentialError('field-missing')
    return SecretValue.fromString(value)
  }

  #currentClient(): Promise<SecretsClient> {
    if (this.#client === null) {
      const created = this.#createClient()
      this.#client = created
      // A client that failed to come up is never cached.
      created.catch(() => this.#drop(created))
    }
    return this.#client
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
      return await this.#bounded(this.#clientFactory(token))
    } finally {
      token.dispose()
    }
  }

  #drop(client: Promise<SecretsClient>): void {
    if (this.#client === client) this.#client = null
  }

  #bounded<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => reject(new CredentialError('unavailable')), this.#timeoutMs)
      work.then(
        (value) => {
          this.#timers.clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          this.#timers.clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
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
