// Pure checks on where a secret may be typed. See "Before a secret fill" in docs/security-model.md.

import { type ElementInfo, httpsOrigin, isBareOrigin, originAllowed, type SecretField } from '@valet/core'

/**
 * The origins a secret may be typed on: those the person granted that are also in `bound` (what
 * the manifest asked for, or for a Messages code, the navigation allowlist). A grant should already
 * be a subset, but the fill doesn't rely on that. A granted origin that isn't written as a bare,
 * normalised https origin with a DNS host is dropped rather than interpreted. The result is in the
 * URL parser's origin form, no trailing slash, as the driver compares it before each keystroke.
 */
export function allowedOrigins(granted: readonly string[], bound: readonly string[]): string[] {
  const origins = new Set<string>()
  for (const origin of granted) {
    const normalised = httpsOrigin(origin)
    if (normalised !== null && isBareOrigin(origin) && originAllowed(origin, bound)) origins.add(normalised)
  }
  return [...origins]
}

/** An input whose type attribute is absent is a text field. */
const USERNAME_TYPES: readonly (string | null)[] = ['email', 'text', 'tel', null]
const OTP_TYPES: readonly (string | null)[] = ['text', 'tel', 'number', null]
/** Fields whose contents end up in URLs, history or analytics, whatever their other attributes say. */
const NEVER_FOR_OTP: readonly (string | null)[] = ['search', 'email', 'url', 'hidden']

/** True when the element is the kind of field the secret belongs in. */
export function suitsField(element: ElementInfo, field: SecretField): boolean {
  if (element.tagName.toLowerCase() !== 'input') return false
  const type = element.inputType?.toLowerCase() ?? null
  switch (field) {
    case 'password':
      return type === 'password'
    case 'username':
      return USERNAME_TYPES.includes(type)
    case 'otp': {
      if (NEVER_FOR_OTP.includes(type)) return false
      const tokens = element.autocomplete?.toLowerCase().split(/\s+/) ?? []
      return (
        tokens.includes('one-time-code') ||
        element.inputMode?.toLowerCase() === 'numeric' ||
        OTP_TYPES.includes(type)
      )
    }
  }
}
