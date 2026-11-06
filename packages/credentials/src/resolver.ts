// Resolves a granted secret by handing the grant's item reference to the provider the grant names.
// This is the package's boundary: whatever a provider throws leaves as SiteAdapterError('credential').

import {
  CredentialError,
  type CredentialProvider,
  type Grant,
  type ProviderKind,
  type ResolveFailure,
  type SecretField,
  SecretValue,
  SiteAdapterError,
} from '@siteadapter/core'

const FAILURES: readonly ResolveFailure[] = ['locked', 'not-found', 'field-missing', 'unavailable']

export class CredentialResolver {
  readonly #providers: ReadonlyMap<ProviderKind, CredentialProvider>

  constructor(providers: readonly CredentialProvider[]) {
    const byKind = new Map<ProviderKind, CredentialProvider>()
    for (const provider of providers) {
      if (byKind.has(provider.kind)) throw new Error(`two credential providers of kind ${provider.kind}`)
      byKind.set(provider.kind, provider)
    }
    this.#providers = byKind
  }

  /** Fetches one field of a granted secret. The caller disposes the value. */
  async resolve(grant: Grant, field: SecretField): Promise<SecretValue> {
    const provider = this.#providers.get(grant.provider)
    if (provider === undefined) throw new SiteAdapterError('credential', 'unavailable')
    let value: unknown
    try {
      value = await provider.resolve(grant.itemRef, field)
    } catch (error) {
      // A provider bug can throw anything, message included; only a known failure class survives.
      const failure =
        error instanceof CredentialError && FAILURES.includes(error.failure) ? error.failure : 'unavailable'
      throw new SiteAdapterError('credential', failure)
    }
    // A provider that hands back a bare string has already let the secret loose; refuse it.
    if (!(value instanceof SecretValue)) throw new SiteAdapterError('credential', 'internal')
    return value
  }
}
