// 1Password item references in grants: exactly op://<vault>/<item>. The field is never part of the
// grant; the runtime picks it from the manifest's secret request, so a grant can't be pointed at a
// different field, section or query attribute by smuggling one into the reference.

import type { SecretField } from '@siteadapter/core'

// Vault and item names or IDs. No "/", "?", "#", quotes or control characters, and no
// leading or trailing space, so the reference can't grow extra segments or query parameters.
const NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9 _.()-]{0,126}[A-Za-z0-9_.()-])?$/

export interface ItemRef {
  readonly vault: string
  readonly item: string
}

/** Parses `op://<vault>/<item>`, or returns null for anything else. */
export function parseItemRef(value: string): ItemRef | null {
  if (!value.startsWith('op://')) return null
  const parts = value.slice('op://'.length).split('/')
  if (parts.length !== 2) return null
  const [vault, item] = parts as [string, string]
  if (!NAME.test(vault) || !NAME.test(item)) return null
  return { vault, item }
}

/** The field part of a secret reference. `otpAttribute` differs between the CLI and the SDK. */
export function secretReference(ref: ItemRef, field: SecretField, otpAttribute: 'otp' | 'totp'): string {
  const base = `op://${ref.vault}/${ref.item}`
  switch (field) {
    case 'username':
      return `${base}/username`
    case 'password':
      return `${base}/password`
    case 'otp':
      return `${base}/one-time password?attribute=${otpAttribute}`
  }
}
