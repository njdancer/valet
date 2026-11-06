// The two network guards' decisions, kept free of Electron so that each can be attacked in a test.
//
// - Auth partition: the main frame may only be on one of the manifest's navigation origins.
//   Subframes may load any https page, because login pages embed bot-protection and CAPTCHA frames
//   from other origins; a secret fill separately requires the target frame's origin to be granted.
// - Tool partition: every request must go to a host on the manifest's egress list.

import { hostAllowed, urlOriginAllowed } from '@siteadapter/core'
import type { PendingNavigation } from './platform'

const LOCAL_SUBFRAME_URLS = new Set(['about:blank', 'about:srcdoc'])

export function authNavigationAllowed(navigation: PendingNavigation, origins: readonly string[]): boolean {
  if (navigation.isMainFrame) return urlOriginAllowed(navigation.url, origins)
  if (LOCAL_SUBFRAME_URLS.has(navigation.url)) return true
  return parse(navigation.url)?.protocol === 'https:'
}

// Schemes that never leave the machine. Chromium rarely shows them to webRequest at all.
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:'])
const NETWORK_SCHEMES = new Set(['https:', 'wss:'])

export function egressAllowed(url: string, egress: readonly string[]): boolean {
  const parsed = parse(url)
  if (parsed === null) return false
  if (LOCAL_SCHEMES.has(parsed.protocol)) return true
  return NETWORK_SCHEMES.has(parsed.protocol) && hostAllowed(parsed.hostname, egress)
}

/** Origin and path of a URL, for reports. Query strings and fragments can carry data, so never them. */
export function requestTarget(url: string): string {
  const parsed = parse(url)
  if (parsed === null) return 'invalid-url'
  if (parsed.origin === 'null') return parsed.protocol
  return `${parsed.origin}${parsed.pathname}`
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
