// An in-memory KeychainStore with the helper's rules, for demo mode and tests: demo mode's Keychain
// copies live here (and, through `persist`, in a file in its own userData), never in the real
// Keychain. Like FakeCredentialProvider, it holds only test values.

import { CredentialError, SecretValue } from '@valet/core'
import { checkKeychainItem, isKeychainService, type KeychainStore } from './keychain-helper'

/** One stored item, as `persist` and `items` hand it over. */
export interface MemoryKeychainItem {
  readonly service: string
  readonly account: string
  readonly secret: string
  readonly comment: string
}

export interface MemoryKeychainOptions {
  /** Items to start with (a demo's saved copies). Any the helper would refuse are dropped. */
  readonly items?: readonly MemoryKeychainItem[]
  /** Called with every item after each change. */
  readonly persist?: (items: readonly MemoryKeychainItem[]) => void
}

const MAX_SECRET_BYTES = 16 * 1024

export class MemoryKeychain implements KeychainStore {
  readonly #items = new Map<string, { secret: Buffer; comment: string; service: string; account: string }>()
  readonly #persist: ((items: readonly MemoryKeychainItem[]) => void) | undefined

  constructor(options: MemoryKeychainOptions = {}) {
    this.#persist = options.persist
    for (const item of options.items ?? []) {
      try {
        checkKeychainItem(item.service, item.account)
      } catch {
        continue
      }
      if (typeof item.secret !== 'string' || typeof item.comment !== 'string' || item.secret === '') continue
      this.#items.set(key(item.service, item.account), {
        service: item.service,
        account: item.account,
        secret: Buffer.from(item.secret, 'utf8'),
        comment: item.comment,
      })
    }
  }

  async read(service: string, account: string): Promise<SecretValue> {
    checkKeychainItem(service, account)
    const item = this.#items.get(key(service, account))
    if (item === undefined) throw new CredentialError('not-found')
    return SecretValue.fromBuffer(Buffer.from(item.secret))
  }

  async info(service: string, account: string): Promise<string | null> {
    checkKeychainItem(service, account)
    return this.#items.get(key(service, account))?.comment ?? null
  }

  async write(service: string, account: string, secret: Buffer, comment: string): Promise<void> {
    try {
      checkKeychainItem(service, account)
      if (secret.length === 0 || secret.length > MAX_SECRET_BYTES) throw new CredentialError('unavailable')
      this.#items.set(key(service, account), { service, account, secret: Buffer.from(secret), comment })
    } finally {
      secret.fill(0)
    }
    this.#changed()
  }

  async delete(service: string, account: string): Promise<void> {
    checkKeychainItem(service, account)
    if (this.#items.delete(key(service, account))) this.#changed()
  }

  async purge(service: string): Promise<void> {
    if (!isKeychainService(service)) throw new CredentialError('not-found')
    let changed = false
    for (const [name, item] of this.#items) {
      if (item.service === service) changed = this.#items.delete(name) || changed
    }
    if (changed) this.#changed()
  }

  /** Every item, secrets included: test values only. */
  items(): MemoryKeychainItem[] {
    return [...this.#items.values()].map((item) => ({
      service: item.service,
      account: item.account,
      secret: item.secret.toString('utf8'),
      comment: item.comment,
    }))
  }

  #changed(): void {
    this.#persist?.(this.items())
  }
}

function key(service: string, account: string): string {
  return `${service}\u0000${account}`
}
