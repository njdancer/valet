// Turns a manifest's OTP sender into the exact Messages handle it must come from. Anyone can message
// the person, so a sender only counts when the handle is the same one, not one that contains it:
// "fake.woolworths@icloud.com" must not pass for "Woolworths".

export type SenderKind = 'phone' | 'short-code' | 'alphanumeric' | 'email'

export interface OtpSender {
  readonly kind: SenderKind
  /** The handle as Messages stores it: E.164 and short codes as digits, the rest lowercased. */
  readonly handle: string
  /** Messages services a code from this sender may arrive over. */
  readonly services: readonly string[]
}

// E.164: a plus, then up to 15 digits. Messages stores SMS numbers this way.
const E164 = /^\+[1-9]\d{6,14}$/
const SHORT_CODE = /^\d{3,8}$/
// GSM alphanumeric sender IDs: at most 11 characters, with at least one letter.
const ALPHANUMERIC = /^(?=.*[a-z])[a-z0-9][a-z0-9 .&_-]{0,10}$/
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/
// Phone numbers are often written with spaces, dashes or brackets.
const PHONE_PUNCTUATION = /[\s()-]/g

// Numbers, short codes and sender IDs reach the phone as SMS (or RCS). An email handle is iMessage.
const CARRIER_SERVICES = ['SMS', 'RCS']
const EMAIL_SERVICES = ['iMessage']

/** The exact handle for `sender`, or null when it is not a phone number, short code, sender ID or email. */
export function parseOtpSender(sender: string): OtpSender | null {
  const trimmed = sender.trim()
  const phone = trimmed.replace(PHONE_PUNCTUATION, '')
  if (E164.test(phone)) return { kind: 'phone', handle: phone, services: CARRIER_SERVICES }
  if (SHORT_CODE.test(phone)) return { kind: 'short-code', handle: phone, services: CARRIER_SERVICES }
  const lower = trimmed.toLowerCase()
  if (EMAIL.test(lower)) return { kind: 'email', handle: lower, services: EMAIL_SERVICES }
  if (ALPHANUMERIC.test(lower)) return { kind: 'alphanumeric', handle: lower, services: CARRIER_SERVICES }
  return null
}
