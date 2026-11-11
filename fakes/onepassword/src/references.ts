// Secret references, op://<vault>/<item>/[<section>/]<field>[?attribute=<attribute>], resolved the
// way 1Password does: vault and item by id or exact title, the field by its label or id, and the
// one-time password field's current code when the attribute asks for it. A failure is a ReferenceError
// with a reason; the SDK and the CLI each word it their own way.

import type { FakeItem, FakeOnePassword } from './state'

export type ReferenceFailure =
  | 'not-prefixed'
  | 'invalid-format'
  | 'no-vault'
  | 'no-item'
  | 'inactive'
  | 'no-field'
  | 'bad-attribute'

export class ReferenceFailed extends Error {
  constructor(
    readonly reason: ReferenceFailure,
    readonly vault = '',
    readonly item = '',
    readonly field = '',
  ) {
    super(reason)
  }
}

export interface ParsedReference {
  readonly vault: string
  readonly item: string
  readonly section: string | null
  readonly field: string
  readonly attribute: string | null
}

export function parseReference(reference: string): ParsedReference {
  if (!reference.startsWith('op://')) throw new ReferenceFailed('not-prefixed')
  const [path = '', query, ...rest] = reference.slice('op://'.length).split('?')
  if (rest.length > 0) throw new ReferenceFailed('invalid-format')
  const parts = path.split('/')
  if (parts.length < 3 || parts.length > 4 || parts.some((p) => p.length === 0)) {
    throw new ReferenceFailed('invalid-format')
  }
  let attribute: string | null = null
  if (query !== undefined) {
    const match = /^attribute=([a-z]+)$/.exec(query)
    if (match === null) throw new ReferenceFailed('invalid-format')
    attribute = match[1] as string
  }
  const [vault, item] = parts as [string, string]
  return {
    vault,
    item,
    section: parts.length === 4 ? (parts[2] as string) : null,
    field: parts.at(-1) as string,
    attribute,
  }
}

const OTP_LABELS = new Set(['one-time password', 'otp', 'totp'])

/**
 * The value `reference` names, for a caller that sees `vaultIds`. `otpAttributes` are the
 * attributes that ask for a one-time password's code: the SDK's `totp`, the CLI's `otp` (and `totp`).
 */
export function resolveReference(
  fake: FakeOnePassword,
  reference: string,
  vaultIds: readonly string[] | 'all',
  otpAttributes: readonly string[],
): { readonly value: string; readonly item: FakeItem } {
  const ref = parseReference(reference)
  const item = findItem(fake, ref.vault, ref.item, vaultIds)
  if (item.archived) throw new ReferenceFailed('inactive', ref.vault, ref.item)
  const label = ref.field.toLowerCase()
  if (ref.section !== null && ref.section !== 'add more') {
    throw new ReferenceFailed('no-field', ref.vault, ref.item, ref.field)
  }
  if (OTP_LABELS.has(label)) {
    const code = fake.code(item)
    if (code === undefined) throw new ReferenceFailed('no-field', ref.vault, ref.item, ref.field)
    if (ref.attribute === null)
      return { value: `otpauth://totp/${item.title}?secret=${item.totpSecret}`, item }
    if (!otpAttributes.includes(ref.attribute))
      throw new ReferenceFailed('bad-attribute', ref.vault, ref.item)
    return { value: code, item }
  }
  if (ref.attribute !== null) throw new ReferenceFailed('bad-attribute', ref.vault, ref.item)
  const value = label === 'username' ? item.username : label === 'password' ? item.password : undefined
  if (value === undefined) throw new ReferenceFailed('no-field', ref.vault, ref.item, ref.field)
  return { value, item }
}

/** A vault the caller can see, by id or exact title; exactly one, or the failure 1Password reports. */
export function findVault(
  fake: FakeOnePassword,
  vault: string,
  vaultIds: readonly string[] | 'all',
): { readonly id: string; readonly title: string } {
  const matches = fake.visibleVaults(vaultIds).filter((v) => v.id === vault || v.title === vault)
  if (matches.length !== 1) throw new ReferenceFailed('no-vault', vault)
  return matches[0] as { id: string; title: string }
}

function findItem(
  fake: FakeOnePassword,
  vault: string,
  item: string,
  vaultIds: readonly string[] | 'all',
): FakeItem {
  const found = findVault(fake, vault, vaultIds)
  const matches = fake.items.filter((i) => i.vaultId === found.id && (i.id === item || i.title === item))
  if (matches.length !== 1) throw new ReferenceFailed('no-item', vault, item)
  return matches[0] as FakeItem
}
