// Cookie selection and copying for the auth-to-tool handoff. The mapping keeps every attribute the
// site set, because a cookie that loses hostOnly or sameSite behaves differently on the next request
// and bot-protection cookies are checked against exactly that.

import { hostAllowed } from '@siteadapter/core'
import type { CookieRecord, CookieSetDetails } from './platform'

/** The host a cookie belongs to: its domain without the leading dot Chromium adds. */
export function cookieHost(cookie: CookieRecord): string | null {
  const domain = cookie.domain?.replace(/^\./, '')
  return domain === undefined || domain.length === 0 ? null : domain.toLowerCase()
}

export function cookiesForDomains(
  cookies: readonly CookieRecord[],
  cookieDomains: readonly string[],
): CookieRecord[] {
  return cookies.filter((cookie) => {
    const host = cookieHost(cookie)
    return host !== null && hostAllowed(host, cookieDomains)
  })
}

/**
 * The details that recreate `cookie` in another session. A host-only cookie must be set without a
 * domain, or Chromium widens it to subdomains; a session cookie must be set without an expiry.
 */
export function cookieSetDetails(cookie: CookieRecord): CookieSetDetails {
  const host = cookieHost(cookie)
  if (host === null) throw new Error('cookie has no domain')
  const path = cookie.path ?? '/'
  return {
    url: `https://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path,
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    ...(cookie.session || cookie.expirationDate === undefined
      ? {}
      : { expirationDate: cookie.expirationDate }),
  }
}
