// Pure checks on where a secret may be typed. See "Before a secret fill" in docs/security-model.md.

import {
  type AdapterManifest,
  type ElementInfo,
  isBareOrigin,
  originAllowed,
  type SecretField,
} from '@siteadapter/core'

/**
 * The origins a secret may be typed on: those the person granted that the manifest also asked for.
 * A grant should already be a subset of the request, but the fill doesn't rely on that. A granted
 * origin that isn't written as a bare, normalised https origin is dropped rather than interpreted.
 */
export function allowedOrigins(granted: readonly string[], requested: readonly string[]): string[] {
  return granted.filter((origin) => isBareOrigin(origin) && originAllowed(origin, requested))
}

/**
 * Every origin any of the manifest's secret requests asked for. A Messages code has no request of
 * its own, so this, not the wider navigation allowlist, bounds where it may be typed.
 */
export function requestedOrigins(manifest: Pick<AdapterManifest, 'secrets'>): string[] {
  return [...new Set(Object.values(manifest.secrets).flatMap((request) => request.origins))]
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
