// The auth partition's session probe: a GET the driver makes from the main process with the
// partition's cookies, never from page script. These are its decisions, free of Electron: where it
// may go (the manifest's navigation origins, every hop of the way), what it sends, how much it reads
// and how the answer is read.
//
// What it sends is what the auth page's own fetch(url, { credentials: 'include' }) would: the same
// headers, in the same order and case, with the same fetch metadata (cors mode, empty destination)
// and the Referer strict-origin-when-cross-origin gives from the page's URL. The e2e suite diffs the
// two on the wire. Redirects are taken one hop at a time, so that each hop is checked before
// anything is sent there and is worded as Chrome would word it after that redirect.

import { type FetchResult, urlOriginAllowed, ValetError } from '@valet/core'
import type { HeaderList, PartitionSession, SessionFetchResponse } from './platform'

/** The most body a probe reads. A login probe's answer is small; anything bigger is not one. */
export const MAX_PROBE_BYTES = 1024 * 1024

/** Redirects a probe follows, each on the navigation origins, before it gives up. */
export const MAX_PROBE_REDIRECTS = 5

/** What a page's own fetch() sends as Accept by default. */
export const PROBE_ACCEPT = '*/*'

/**
 * The URL a probe may GET: absolute https, with no credentials in it, on one of the navigation
 * origins. Throws probe/host-not-allowed for anything else, and probe/invalid for a URL that
 * carries a username or password, which would be sent as HTTP authentication.
 */
export function probeTarget(url: string, navigation: readonly string[]): string {
  if (typeof url !== 'string') throw new ValetError('probe', 'invalid')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ValetError('probe', 'host-not-allowed')
  }
  if (parsed.protocol !== 'https:' || !urlOriginAllowed(parsed.href, navigation)) {
    throw new ValetError('probe', 'host-not-allowed')
  }
  if (parsed.username !== '' || parsed.password !== '') throw new ValetError('probe', 'invalid')
  // The fragment never reaches the network; dropping it keeps it out of anything logged.
  parsed.hash = ''
  return parsed.href
}

/**
 * Decides each redirect of one probe: followed only while it stays on the navigation origins (the
 * same rule as the main frame's navigation guard) and within MAX_PROBE_REDIRECTS. Remembers why it
 * last refused.
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

/** What one probe needs besides its URL. */
export interface ProbeRequest {
  /** The manifest's navigation origins: every hop must stay on them. */
  readonly navigation: readonly string[]
  /**
   * The headers the page's requests carry ahead of Accept, in Chrome's order and case: the client
   * hints, the UA and Accept-Language, as the driver presents the partition. Empty for Electron's
   * own UA, which the network stack fills in itself.
   */
  readonly identity: HeaderList
  /** The auth page's document URL, which the request is made on behalf of. */
  readonly pageUrl: string
  readonly maxBytes: number
  readonly signal: AbortSignal
}

/**
 * GETs `url` through `session` as the page's own fetch() would, one hop at a time: each redirect is
 * put to ProbeRedirects before anything is sent to it. Resolves with core's FetchResult, and throws
 * a probe error that says nothing about the response otherwise.
 */
export async function sessionProbe(
  session: Pick<PartitionSession, 'fetch'>,
  url: string,
  request: ProbeRequest,
): Promise<FetchResult> {
  let current = new URL(probeTarget(url, request.navigation))
  const page = pageDocument(request.pageUrl, request.navigation)
  // From a page that isn't on the navigation origins (none loaded yet), as if from the target's own.
  const initiator = page?.origin ?? current.origin
  const redirects = new ProbeRedirects(request.navigation)
  const chain: ChainState = { crossed: false, tainted: false }
  let redirected = false
  for (;;) {
    if (current.origin !== initiator) chain.crossed = true
    const response = await session.fetch({
      url: current.href,
      initiator,
      headers: hopHeaders(request.identity, initiator, chain),
      referrer: page === null ? null : referrerFor(page, current),
      maxBytes: request.maxBytes,
      signal: request.signal,
    })
    if (response.kind === 'response') {
      const result = probeResult(response)
      return redirected ? { ...result, redirected: true } : result
    }
    if (response.kind === 'failed') throw probeFailure(response.failure)
    if (!redirects.allow(response.location)) {
      throw new ValetError('probe', redirects.refusal ?? 'host-not-allowed')
    }
    if (request.signal.aborted) throw new ValetError('probe', 'aborted')
    const next = new URL(response.location)
    next.hash = ''
    // The fetch spec's tainted origin: a redirect to another origin from one that isn't the page's.
    if (next.origin !== current.origin && current.origin !== initiator) chain.tainted = true
    current = next
    redirected = true
  }
}

/** What the redirects so far mean for the next hop's Origin header. */
export interface ChainState {
  /** Some hop was cross-origin to the page, so the request is CORS from here on. */
  crossed: boolean
  /** A redirect went from one foreign origin to another: Origin is "null" from here on. */
  tainted: boolean
}

/**
 * The headers of one hop, in the order Chrome sends a page's fetch(): the identity headers, Accept,
 * Origin once the request has gone cross-origin, then the fetch metadata. The network stack adds
 * the Referer, Accept-Encoding and the cookies after these.
 *
 * Sec-Fetch-Site is a placeholder that holds the header's place: Chromium overwrites whatever value
 * it is given with its own reckoning of the initiator against the URL, the public suffix list and
 * all (seen on Electron 44, both ways; the e2e diff would catch it stopping). Chromium also strips
 * a Sec-Fetch-Storage-Access header given to it, so the one a page's cross-site fetch() carries
 * can't be restated: see the README.
 */
export function hopHeaders(identity: HeaderList, initiator: string, chain: Readonly<ChainState>): HeaderList {
  return [
    ...identity,
    ['Accept', PROBE_ACCEPT],
    ...(chain.crossed ? [['Origin', chain.tainted ? 'null' : initiator] as const] : []),
    ['Sec-Fetch-Site', 'same-origin'],
    ['Sec-Fetch-Mode', 'cors'],
    ['Sec-Fetch-Dest', 'empty'],
  ]
}

/** The page's document, when it is one the probe may be made on behalf of: https, on the list. */
function pageDocument(pageUrl: string, navigation: readonly string[]): URL | null {
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !urlOriginAllowed(parsed.href, navigation)) return null
  return parsed
}

/**
 * The Referer strict-origin-when-cross-origin sends from `page` to `target`: the page's URL, less
 * its fragment and any credentials, to its own origin, and its origin alone anywhere else. Both are
 * https, so there is no downgrade to leave it out for.
 */
export function referrerFor(page: URL, target: URL): string {
  if (page.origin !== target.origin) return `${page.origin}/`
  const referrer = new URL(page.href)
  referrer.hash = ''
  referrer.username = ''
  referrer.password = ''
  return referrer.href
}

/**
 * The FetchResult core describes: the status, the content type, and the body parsed as JSON when
 * the content type says JSON and it parses, otherwise the text, or null when there is none.
 */
export function probeResult(response: Extract<SessionFetchResponse, { kind: 'response' }>): FetchResult {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new ValetError('probe', 'unavailable')
  }
  const contentType = response.contentType === null ? null : response.contentType.slice(0, 200)
  return { status: response.status, contentType, body: parseBody(contentType, response.body) }
}

/** A failed hop as a probe error that says nothing about the response. */
export function probeFailure(
  failure: Extract<SessionFetchResponse, { kind: 'failed' }>['failure'],
): ValetError {
  switch (failure) {
    case 'too-large':
      return new ValetError('probe', 'unexpected-shape')
    case 'aborted':
      return new ValetError('probe', 'aborted')
    default:
      return new ValetError('probe', 'unavailable')
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
