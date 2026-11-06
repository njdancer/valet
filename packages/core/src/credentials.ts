// Credential providers and grants. A manifest requests a secret; a grant, made by the person, binds
// that request to a credential item for one exact adapter content hash.

import type { SecretField } from './manifest'
import type { SecretValue } from './secret'

export type ProviderKind = 'onepassword-service-account' | 'onepassword-cli' | 'fake'

export interface Grant {
  readonly adapterId: string
  readonly adapterHash: string
  readonly secret: string
  readonly provider: ProviderKind
  /** Provider-specific item reference, e.g. op://siteadapter/Woolworths. Never shown to adapter code. */
  readonly itemRef: string
  /** Origins the person allowed this secret on: a subset of what the manifest asked for. */
  readonly origins: readonly string[]
  readonly grantedAt: string
}

export type ResolveFailure =
  | 'locked' // provider needs the person, e.g. Touch ID or an unlocked app
  | 'not-found'
  | 'field-missing'
  | 'unavailable' // provider not installed or not configured

export class CredentialError extends Error {
  constructor(readonly failure: ResolveFailure) {
    super(`credential ${failure}`)
    this.name = 'CredentialError'
  }
}

export interface CredentialProvider {
  readonly kind: ProviderKind
  /** Fetches one field just in time. Throws CredentialError. The caller disposes the value. */
  resolve(itemRef: string, field: SecretField): Promise<SecretValue>
}

export interface GrantStore {
  find(adapterId: string, adapterHash: string, secret: string): Promise<Grant | null>
  list(): Promise<readonly Grant[]>
  put(grant: Grant): Promise<void>
  revoke(adapterId: string, secret: string): Promise<void>
}
