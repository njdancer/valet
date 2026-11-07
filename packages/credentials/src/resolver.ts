// Resolves a granted secret by handing the grant's item reference to the provider the grant names.
// This is the package's boundary: whatever a provider throws leaves as ValetError('credential').

import {
  CredentialError,
  type CredentialProvider,
  type Grant,
  type ProviderKind,
  type ResolveFailure,
  type SecretField,
  SecretValue,
  ValetError,
} from '@valet/core'

const FAILURES: readonly ResolveFailure[] = ['locked', 'not-found', 'field-missing', 'unavailable']

export class CredentialResolver {
  readonly #providers: ReadonlyMap<ProviderKind, CredentialProvider>

  constructor(providers: readonly CredentialProvider[]) {
    const byKind = new Map<ProviderKind, CredentialProvider>()
    for (const provider of providers) {
      // Codes from Messages go through the OtpReader, which holds the sender and pattern guards; a
      // provider that answered for messages grants would skip them.
      if (provider.kind === 'messages') throw new Error('messages grants are read by an OtpReader')
      if (byKind.has(provider.kind)) throw new Error(`two credential providers of kind ${provider.kind}`)
      byKind.set(provider.kind, provider)
    }
    this.#providers = byKind
  }

  /** Fetches one field of a granted secret. The caller disposes the value. */
  async resolve(grant: Grant, field: SecretField): Promise<SecretValue> {
    const provider = this.#providers.get(grant.provider)
    if (provider === undefined) throw new ValetError('credential', 'unavailable')
    let value: unknown
    try {
      value = await provider.resolve(grant.itemRef, field)
    } catch (error) {
      // A provider bug can throw anything, message included; only a known failure class survives.
      const failure =
        error instanceof CredentialError && FAILURES.includes(error.failure) ? error.failure : 'unavailable'
      throw new ValetError('credential', failure)
    }
    // A provider that hands back a bare string has already let the secret loose; refuse it.
    if (!(value instanceof SecretValue)) throw new ValetError('credential', 'internal')
    return value
  }
}
