// A Keychain copy of a granted 1Password item (D6, decided 2026-11-07). At setup, with the person
// approving in 1Password (DesktopAuth), Valet copies the granted fields into Valet's own Keychain
// items; unattended runs read the copy. Each copy carries its source (account, vault and item ids,
// the field, and the item's last update time when copied) as the item's comment, so a re-sync knows
// where to read from and can tell when the source has moved on.
//
// A keychain-copy grant's itemRef is the source, op://<vault id>/<item id>, exactly as a 1Password
// grant's: the grant says which item was approved, and the copy is only where its value is kept.
// One Keychain item per field: service COPY_SERVICE, account `<itemRef>#<field>`.
//
// The copy holds username and password. A TOTP secret isn't copied yet (Woolworths sends codes by
// SMS, D4), so `otp` is field-missing.

import { CredentialError, type CredentialProvider, type SecretField, type SecretValue } from '@valet/core'
import { parseItemRef } from './item-ref'
import type { KeychainStore } from './keychain-helper'

/** The Keychain service the copies live under. The desktop app's dev build uses its own. */
export const COPY_SERVICE = 'valet.copy'

/** The fields a copy can hold. */
export const COPYABLE_FIELDS: readonly SecretField[] = ['username', 'password']

/** Where a copy came from. Not secret: it is the Keychain item's comment. */
export interface CopySource {
  /** The 1Password account DesktopAuth was given: its name as the app shows it, or its UUID. */
  readonly account: string
  readonly vaultId: string
  readonly itemId: string
  readonly field: SecretField
  /** The source item's updatedAt when it was copied, as an ISO instant. */
  readonly sourceUpdatedAt: string
  readonly copiedAt: string
}

const SOURCE_KEYS = ['v', 'account', 'vaultId', 'itemId', 'field', 'sourceUpdatedAt', 'copiedAt']
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** The Keychain account for one field of a copy, or null when `itemRef` is not op://<vault>/<item>. */
export function copyAccount(itemRef: string, field: SecretField): string | null {
  return parseItemRef(itemRef) === null ? null : `${itemRef}#${field}`
}

export function encodeCopySource(source: CopySource): string {
  return JSON.stringify({
    v: 1,
    account: source.account,
    vaultId: source.vaultId,
    itemId: source.itemId,
    field: source.field,
    sourceUpdatedAt: source.sourceUpdatedAt,
    copiedAt: source.copiedAt,
  })
}

/** The source in a copy's comment, or null for anything that isn't exactly one. */
export function parseCopySource(comment: string): CopySource | null {
  let value: unknown
  try {
    value = JSON.parse(comment)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== SOURCE_KEYS.length || !SOURCE_KEYS.every((key) => Object.hasOwn(record, key)))
    return null
  const { v, account, vaultId, itemId, field, sourceUpdatedAt, copiedAt } = record
  if (
    v !== 1 ||
    !isText(account) ||
    !isText(vaultId) ||
    !isText(itemId) ||
    parseItemRef(`op://${vaultId}/${itemId}`) === null ||
    typeof field !== 'string' ||
    !(COPYABLE_FIELDS as readonly string[]).includes(field) ||
    !isInstant(sourceUpdatedAt) ||
    !isInstant(copiedAt)
  ) {
    return null
  }
  return {
    account,
    vaultId,
    itemId,
    field: field as SecretField,
    sourceUpdatedAt,
    copiedAt,
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !CONTROL.test(value)
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value))
}

export interface KeychainCopyOptions {
  readonly keychain: KeychainStore
  readonly service?: string
}

/** Resolves keychain-copy grants from the copy. Never reaches 1Password. */
export class KeychainCopyProvider implements CredentialProvider {
  readonly kind = 'keychain-copy' as const
  readonly keychain: KeychainStore
  readonly service: string

  constructor(options: KeychainCopyOptions) {
    this.keychain = options.keychain
    this.service = options.service ?? COPY_SERVICE
  }

  async resolve(itemRef: string, field: SecretField): Promise<SecretValue> {
    const account = copyAccount(itemRef, field)
    if (account === null) throw new CredentialError('not-found')
    if (!COPYABLE_FIELDS.includes(field)) throw new CredentialError('field-missing')
    return this.keychain.read(this.service, account)
  }

  /** Where the copy of this field came from, or null when there is no copy (or its comment is bad). */
  async source(itemRef: string, field: SecretField): Promise<CopySource | null> {
    const account = copyAccount(itemRef, field)
    if (account === null) return null
    const comment = await this.keychain.info(this.service, account)
    return comment === null ? null : parseCopySource(comment)
  }

  /** Stores a field's value (taking ownership of `value`) with its source. */
  async store(itemRef: string, value: Buffer, source: CopySource): Promise<void> {
    const account = copyAccount(itemRef, source.field)
    if (account === null || !COPYABLE_FIELDS.includes(source.field)) {
      value.fill(0)
      throw new CredentialError('not-found')
    }
    await this.keychain.write(this.service, account, value, encodeCopySource(source))
  }

  /** Removes every field's copy, for a revoked grant. */
  async forget(itemRef: string): Promise<void> {
    for (const field of COPYABLE_FIELDS) {
      const account = copyAccount(itemRef, field)
      if (account !== null) await this.keychain.delete(this.service, account)
    }
  }

  /** Removes every copy this build ever made, whatever grants remain: an uninstall or a reset. */
  async forgetAll(): Promise<void> {
    await this.keychain.purge(this.service)
  }
}
