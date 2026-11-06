// The auth partition's session probe: a GET the driver makes from the main process with the
// partition's cookies, never from page script. These are its decisions, free of Electron: where it
// may go (the manifest's navigation origins, every hop of the way), what it sends, how much it reads
// and how the answer is read.

import { type FetchResult, SiteAdapterError, urlOriginAllowed } from '@siteadapter/core'
import type { SessionFetchResponse } from './platform'

/** The most body a probe reads. A login probe's answer is small; anything bigger is not one. */
export const MAX_PROBE_BYTES = 1024 * 1024

/** Redirects a probe follows, each on the navigation origins, before it gives up. */
export const MAX_PROBE_REDIRECTS = 5

/**
 * What a page's own fetch() sends by default. The session adds the cookies; the UA and language
 * are restated by the driver, so they match the page's whichever way Electron fills them in.
 */
export const PROBE_ACCEPT = '*/*'

/**
 * The URL a probe may GET: absolute https, with no credentials in it, on one of the navigation
 * origins. Throws probe/host-not-allowed for anything else, and probe/invalid for a URL that
 * carries a username or password, which would be sent as HTTP authentication.
 */
export function probeTarget(url: string, navigation: readonly string[]): string {
  if (typeof url !== 'string') throw new SiteAdapterError('probe', 'invalid')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SiteAdapterError('probe', 'host-not-allowed')
  }
  if (parsed.protocol !== 'https:' || !urlOriginAllowed(parsed.href, navigation)) {
    throw new SiteAdapterError('probe', 'host-not-allowed')
  }
  if (parsed.username !== '' || parsed.password !== '') throw new SiteAdapterError('probe', 'invalid')
  // The fragment never reaches the network; dropping it keeps it out of anything logged.
  parsed.hash = ''
  return parsed.href
}

/**
 * Decides each redirect of one probe: followed only while it stays on the navigation origins (the
 * same rule as the main frame's navigation guard) and within MAX_PROBE_REDIRECTS. Remembers why it
 * last refused, for probeFailure().
 */
export class ProbeRedirects {
  private hops = 0
  /** Why the last refused redirect was refused, or null if none was. */
  refusal: 'host-not-allowed' | 'unavailable' | null = null

  constructor(private readonly navigation: readonly string[]) {}

  readonly allow = (url: string): boolean => {
    let allowed = false
    try {
      allowed = new URL(url).protocol === 'https:' && urlOriginAllowed(url, this.navigation)
    } catch {
      allowed = false
    }
    if (!allowed) {
      this.refusal = 'host-not-allowed'
      return false
    }
    if (++this.hops > MAX_PROBE_REDIRECTS) {
      this.refusal = 'unavailable'
      return false
    }
    return true
  }
}

/**
 * The FetchResult core describes: the status, the content type, and the body parsed as JSON when
 * the content type says JSON and it parses, otherwise the text, or null when there is none. A
 * failed fetch throws a probe error that says nothing about the response.
 */
export function probeResult(response: SessionFetchResponse, redirects: ProbeRedirects): FetchResult {
  if (!response.ok) throw probeFailure(response.failure, redirects)
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new SiteAdapterError('probe', 'unavailable')
  }
  const contentType = response.contentType === null ? null : response.contentType.slice(0, 200)
  return { status: response.status, contentType, body: parseBody(contentType, response.body) }
}

function probeFailure(
  failure: Extract<SessionFetchResponse, { ok: false }>['failure'],
  redirects: ProbeRedirects,
): SiteAdapterError {
  switch (failure) {
    case 'redirect-refused':
      return new SiteAdapterError('probe', redirects.refusal ?? 'host-not-allowed')
    case 'too-large':
      return new SiteAdapterError('probe', 'unexpected-shape')
    case 'aborted':
      return new SiteAdapterError('probe', 'aborted')
    default:
      return new SiteAdapterError('probe', 'unavailable')
  }
}

const JSON_TYPE = /^[^;]*[/+]json\s*(?:;|$)/i
const CHARSET = /;\s*charset\s*=\s*"?([\w.:-]+)"?/i

function parseBody(contentType: string | null, bytes: Uint8Array): unknown {
  const text = decode(bytes, contentType)
  if (text.length === 0) return null
  if (contentType !== null && JSON_TYPE.test(contentType)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/** Decodes with the declared charset when the platform knows it, and as UTF-8 otherwise. */
function decode(bytes: Uint8Array, contentType: string | null): string {
  const charset = contentType === null ? undefined : CHARSET.exec(contentType)?.[1]
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      // An unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}
