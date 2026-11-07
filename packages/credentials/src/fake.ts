// An in-memory provider for tests and for the desktop app's demo mode. Values are plain strings
// because they are test data; each resolve hands out a fresh SecretValue the caller disposes.

import {
  CredentialError,
  type CredentialProvider,
  type ResolveFailure,
  type SecretField,
  SecretValue,
} from '@valet/core'

export type FakeItem = Partial<Readonly<Record<SecretField, string>>>

export interface FakeCredentialOptions {
  readonly items?: Readonly<Record<string, FakeItem>>
  /** Item refs that fail instead of resolving, e.g. to stand in for a locked 1Password. */
  readonly failures?: Readonly<Record<string, ResolveFailure>>
}

export class FakeCredentialProvider implements CredentialProvider {
  readonly kind = 'fake' as const
  /** Every resolve, in order, so tests can assert what was asked for. */
  readonly requests: { readonly itemRef: string; readonly field: SecretField }[] = []
  readonly #items: Map<string, FakeItem>
  readonly #failures: Map<string, ResolveFailure>

  constructor(options: FakeCredentialOptions = {}) {
    this.#items = new Map(Object.entries(options.items ?? {}))
    this.#failures = new Map(Object.entries(options.failures ?? {}))
  }

  async resolve(itemRef: string, field: SecretField): Promise<SecretValue> {
    this.requests.push({ itemRef, field })
    const failure = this.#failures.get(itemRef)
    if (failure !== undefined) throw new CredentialError(failure)
    const item = this.#items.get(itemRef)
    if (item === undefined) throw new CredentialError('not-found')
    const value = item[field]
    if (value === undefined) throw new CredentialError('field-missing')
    return SecretValue.fromString(value)
  }
}
