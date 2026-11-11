// The rules of remote sign-in, apart from any screen (relay.md, "Consent happens on the Mac").

import type { RemoteConsentAnswer } from '../../../shared/api'

/** Crockford base32 without separators: what a typed code must come to (mcp-server's normaliseCode). */
export function codeReady(typed: string): boolean {
  const code = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)
}

export const ANSWER_TEXT: Readonly<Record<Exclude<RemoteConsentAnswer, 'approved'>, string>> = {
  'wrong-code': 'That code doesn’t match any waiting request. Three wrong codes cancel every request.',
  cancelled: 'Too many wrong codes. Every waiting request was cancelled; start again from your browser.',
}

/** What the tunnel forwards to: the listener's origin, without its /mcp path. */
export function tunnelTarget(url: string): string {
  return url.replace(/\/mcp$/, '')
}

/** The connector URL a cloud agent is given for a public name. */
export function connectorUrl(host: string): string {
  return `https://${host}/mcp`
}
