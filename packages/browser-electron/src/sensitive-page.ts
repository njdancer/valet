// Pages a browser grant never shows an agent (docs/browser-grants.md#guards): payment and card
// details, bank details and payees, password, email and two-factor settings, and closing the
// account. Spotted from the page's address and its form fields. It's a best guess: read-only
// mode is what stops a change; this keeps the agent away from the pages where one would matter
// most, and from the details they show.

/** A form field as the page script reads it: never its value. */
export interface PageField {
  readonly type: string
  readonly autocomplete: string
  readonly name: string
}

const PATH_WORDS: readonly [RegExp, string][] = [
  [/(^|[/_.-])(checkout|payments?|billing|pay|wallet|cards?|credit-?cards?)([/_.-]|$)/, 'a payment page'],
  [/(^|[/_.-])(payees?|bank(-?accounts?|-?details)?|direct-?debits?|bsb)([/_.-]|$)/, 'a bank details page'],
  [
    /(^|[/_.-])(password|passwd|change-?password|reset-?password|security|2fa|mfa|two-?factor|otp|passkeys?|authenticator)([/_.-]|$)/,
    'a password or security page',
  ],
  [
    /(^|[/_.-])(change-?email|email-?settings|delete-?account|close-?account|deactivate)([/_.-]|$)/,
    'an account settings page',
  ],
]

const FIELD_HINTS: readonly [(f: PageField) => boolean, string][] = [
  [(f) => f.autocomplete.split(/\s+/).some((t) => t.startsWith('cc-')), 'a payment page'],
  [
    (f) => /(^|[_-])(card-?number|cardnumber|ccnum|cvv|cvc|card-?cvc|expiry)([_-]|$)/.test(f.name),
    'a payment page',
  ],
  [(f) => /(^|[_-])(bsb|routing|iban|swift|account-?number)([_-]|$)/.test(f.name), 'a bank details page'],
  [(f) => f.type === 'password', 'a password or security page'],
  [(f) => f.autocomplete.split(/\s+/).includes('one-time-code'), 'a password or security page'],
]

/** Why this page is closed to the agent, or null when it isn't. */
export function sensitivePage(url: string, fields: readonly PageField[]): string | null {
  let path = ''
  try {
    const parsed = new URL(url)
    path = `${parsed.pathname}${parsed.hash}`.toLowerCase()
  } catch {
    path = ''
  }
  for (const [pattern, what] of PATH_WORDS) if (pattern.test(path)) return what
  const normal = fields.slice(0, 500).map((f) => ({
    type: f.type.toLowerCase(),
    autocomplete: f.autocomplete.toLowerCase(),
    name: f.name.toLowerCase(),
  }))
  for (const [hint, what] of FIELD_HINTS) if (normal.some(hint)) return what
  return null
}

/** The page script: the page's address, and each input's type, autocomplete and name or id (open shadow roots too). */
export const pageFieldsScript = `(() => {
  const out = []
  const walk = (root) => {
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (out.length >= 500) return
      out.push({
        type: String(el.type || el.tagName || '').slice(0, 40),
        autocomplete: String(el.getAttribute('autocomplete') || '').slice(0, 80),
        name: String(el.getAttribute('name') || el.id || '').slice(0, 80),
      })
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot)
  }
  walk(document)
  return { url: String(location.href), fields: out }
})()`
