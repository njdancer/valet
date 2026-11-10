// The fake woolworths.com.au: real HTTP(S) on 127.0.0.1, routing every request the adapter,
// runtime and browser driver touch. Two servers, as two origins: www (the shop, its API and the
// Akamai simulation) and auth (Auth0 Universal Login, auth-server.ts). See fixtures/README.md for
// which behaviour is captured and which is assumed.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { AccountStore, type FakeAccount, SESSION_COOKIE, type Visitor } from './accounts'
import { accessDeniedHtml, newSensorValue, SENSOR_COOKIE } from './akamai'
import { type AuthHostile, FakeAuth0, type SentMessage } from './auth-server'
import { beaconScript, type PageBeacon, validBeacon } from './beacon'
import { applyShapeDrift, SHAPE_DRIFTS, type ShapeDrift } from './drift'
import {
  closeServer,
  createServer,
  listen,
  originFor,
  parseCookies,
  parseTarget,
  type RecordedRequest,
  readBody,
  recordRequest,
  serializeCookie,
  type TlsOptions,
} from './http'
import { LoginBroker } from './logins'
import {
  homePage,
  loginFailedPage,
  myAccountPage,
  notFoundPage,
  notLoggedInPage,
  type PageContext,
  searchPage,
} from './pages'
import { type RateLimit, RateLimiter } from './rate-limit'
import { routePath } from './route-path'
import {
  MAX_PAGE_SIZE,
  productDetailResponse,
  productNotFoundResponse,
  searchCatalogue,
  searchQueryFromJson,
  searchQueryFromParams,
  searchResponse,
} from './search'
import { applyTrolleyUpdate, type TrolleyLine, trolleyLines, trolleyResponse } from './trolley'

export interface FakeWoolworthsOptions {
  readonly accounts?: readonly FakeAccount[]
  /** Off unless given. */
  readonly rateLimit?: RateLimit
  /** Serve both origins over HTTPS with this key and certificate; otherwise plain HTTP. */
  readonly tls?: TlsOptions
  /** The hostname reported in `origin`. Both servers always listen on 127.0.0.1. */
  readonly hostname?: string
  /**
   * The hostname reported in `authOrigin`. Defaults to `hostname` with "www." swapped for "auth."
   * (or "auth." prefixed), or 127.0.0.1 when there is no hostname.
   */
  readonly authHostname?: string
  /** Defaults to 0, a free port. */
  readonly port?: number
  /** The auth origin's port. Defaults to 0, a free port. */
  readonly authPort?: number
  /** The clock for rate limiting, login expiry and request timestamps. */
  readonly now?: () => number
  /** Auth0's bot detection: a CAPTCHA on the identifier and password pages that refuses every submit. */
  readonly captcha?: boolean
  /**
   * What Akamai does with an `_abck` it never issued (one from an earlier run of the fake, say):
   * `'reissue'`, the default, sets a fresh one and lets the request through, as the real one tends
   * to; `'deny'` answers Access Denied. An API request with no `_abck` at all is denied either way.
   */
  readonly unknownSensor?: UnknownSensor
  /**
   * The hostname the CAPTCHA's iframe loads from, on the auth server's port. Defaults to
   * challenges.captcha.test; the caller maps it to 127.0.0.1.
   */
  readonly captchaFrameHostname?: string
  /**
   * Hostile variants, for testing the auth interpreter's guards. Each one makes the site behave
   * like a compromised or careless one. All are off by default. `openRedirectAfterLogin` also makes
   * www's callback redirect to the login's `path` unchecked, e.g. https://evil.test/.
   */
  readonly hostile?: Hostile
}

/** See FakeWoolworthsOptions.unknownSensor. */
export type UnknownSensor = 'reissue' | 'deny'

/** The hostile variants: Auth0's, plus those on www. */
export interface Hostile extends AuthHostile {
  /** www answers every request for `path` (any method, after Akamai) with a 302 to `to`. */
  readonly wwwRedirect?: { readonly path: string; readonly to: string }
  /** Every www page carries a script that sends document.cookie to this host (beacon.ts). */
  readonly pageBeacon?: PageBeacon
}

export interface FakeWoolworths {
  /** www, e.g. https://www.woolworths.test:<port>. */
  readonly origin: string
  readonly port: number
  /** The Auth0 origin, e.g. https://auth.woolworths.test:<port>. */
  readonly authOrigin: string
  readonly authPort: number
  /** Where the CAPTCHA's iframe loads from, e.g. https://challenges.captcha.test:<authPort>. */
  readonly captchaFrameOrigin: string
  /** Every request www received, in arrival order, including blocked ones. Live: it keeps growing. */
  readonly requests: readonly RecordedRequest[]
  /** Every request the auth origin received. Live. */
  readonly authRequests: readonly RecordedRequest[]
  /** Codes sent by SMS or email for MFA, oldest first. Live. */
  readonly outbox: readonly SentMessage[]
  close(): Promise<void>
  /** What is in an account's trolley. Throws for an unknown username. */
  trolleyFor(username: string): readonly TrolleyLine[]
  /** Replaces the rate limit (null turns it off) and lifts any current blocks. */
  setRateLimit(limit: RateLimit | null): void
  /** While on, every www request gets the Access Denied page, as if the client's IP were blocked. */
  blockAll(on: boolean): void
  /** Logs every www visitor out. Auth0 sessions and remembered devices survive. */
  expireSessions(): void
  /** Ends every Auth0 session, so the next login asks for the password. Remembered devices survive. */
  expireAuthSessions(): void
  /** Turns Auth0's CAPTCHA on or off. */
  setCaptcha(on: boolean): void
  /** While on, Auth0 refuses every password as wrong. */
  rejectPasswords(on: boolean): void
  /** Starts (or, with null, stops) the hostile page beacon on www pages served from now on. */
  setPageBeacon(beacon: PageBeacon | null): void
  /** Switches what Akamai does with an `_abck` it never issued; see the option. */
  setUnknownSensor(mode: UnknownSensor): void
  /** Changes the shape of product-bearing API responses from now on (drift.ts); null restores it. */
  setShapeDrift(drift: ShapeDrift | null): void
}

/** The path and query of the live site's login link: www's /auth/login, back to `path` after. */
export function loginHref(origin: string, path = '/'): string {
  return `/auth/login?redirect_uri=${origin}/auth/callback&path=${path}`
}

/** A path on this site, or "/" for anything that would leave it ("//evil", "/\\evil", "https:"). */
export function sitePath(path: string): string {
  return /^\/(?![/\\])/.test(path) ? path : '/'
}

/** The default hostname of the CAPTCHA provider's frame. */
export const CAPTCHA_FRAME_HOSTNAME = 'challenges.captcha.test'
/** Akamai Bot Manager's cookie, which it sets for the whole parent domain. */
export const BOT_MANAGER_COOKIE = 'bm_sz'
/** The cart API paths, which answer 401 to a logged-in session the site has expired. */
const CART_PATHS = new Set(['/apis/ui/trolley', '/api/v3/ui/trolley/update'])

/** The domain www and auth share, for cookies set on both: woolworths.test for www.woolworths.test. */
export function parentDomainOf(hostname: string | undefined): string | null {
  return hostname?.startsWith('www.') === true ? hostname.slice(4) : null
}

const JSON_TYPE = 'application/json; charset=utf-8'
const HTML_TYPE = 'text/html; charset=utf-8'
const INVALID_REQUEST = { Message: 'The request is invalid.' }
const NO_RESOURCE = { Message: 'No HTTP resource was found that matches the request URI.' }

/** Returned by everything that writes a response, so the compiler checks every route answers. */
type Sent = 'sent'

/** One request in flight: what arrived, plus the cookies the response will set. */
interface Exchange {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly method: string
  /** Lower-cased: the site's paths are case-insensitive. */
  readonly path: string
  readonly params: URLSearchParams
  readonly cookies: Map<string, string>
  readonly body: string
  readonly setCookies: string[]
  visitor: Visitor
}

export async function startFakeWoolworths(options: FakeWoolworthsOptions = {}): Promise<FakeWoolworths> {
  const now = options.now ?? Date.now
  const secure = options.tls !== undefined
  const store = new AccountStore(options.accounts ?? [])
  const broker = new LoginBroker(now)
  const limiter = new RateLimiter(options.rateLimit ?? null, now)
  const issuedSensors = new Set<string>()
  const requests: RecordedRequest[] = []
  let unknownSensor: UnknownSensor = sensorMode(options.unknownSensor ?? 'reissue')
  let pageScript = options.hostile?.pageBeacon === undefined ? '' : beaconScript(options.hostile.pageBeacon)
  let blockingAll = false
  let shapeDrift: ShapeDrift | null = null
  let deniedCount = 0
  let nextOrderId = 100_000_001

  const send = (exchange: Exchange, status: number, type: string, body: string): Sent => {
    const headers: Record<string, string | string[]> = { 'content-type': type, 'cache-control': 'no-store' }
    if (exchange.setCookies.length > 0) headers['set-cookie'] = exchange.setCookies
    exchange.response.writeHead(status, headers).end(body)
    return 'sent'
  }
  const json = (exchange: Exchange, status: number, body: unknown): Sent =>
    send(exchange, status, JSON_TYPE, JSON.stringify(body))
  const html = (exchange: Exchange, status: number, body: string): Sent =>
    send(exchange, status, HTML_TYPE, body)
  const redirect = (exchange: Exchange, location: string): Sent => {
    exchange.response.setHeader('location', location)
    return send(exchange, 302, HTML_TYPE, '')
  }

  /**
   * Akamai's view of a client: its sensor cookie (script-readable, so tool code can drop it) and
   * its session cookie (httpOnly, so it can't). Counting and blocking under both means a blocked
   * client can't get out by deleting `_abck` and fetching a new one.
   */
  const clientKeys = (sensor: string | null, sessionToken: string | undefined): string[] => {
    const keys: string[] = []
    if (sensor !== null) keys.push(`sensor:${sensor}`)
    if (sessionToken !== undefined) keys.push(`session:${sessionToken}`)
    return keys
  }
  /** Blocks every key once one is blocked. Returns whether the client is blocked. */
  const blocked = (keys: readonly string[]): boolean => {
    const blockedKey = keys.find((key) => limiter.isBlocked(key))
    if (blockedKey === undefined) return false
    for (const key of keys) limiter.extendBlock(key, blockedKey)
    return true
  }
  /** Counts an API request under every key. Returns whether it tipped the client into a block. */
  const tipped = (keys: readonly string[]): boolean => {
    const results = keys.map((key) => limiter.hit(key))
    return results.some((hit) => hit) && blocked(keys)
  }

  /** Akamai answers before the site does, so no site cookies are set on a denial. */
  const deny = (request: IncomingMessage, response: ServerResponse): Sent => {
    deniedCount += 1
    const reference = `18.${(0xa66e0000 + deniedCount).toString(16)}.${Math.floor(now() / 1000)}.${deniedCount.toString(16).padStart(8, '0')}`
    response
      .writeHead(403, { 'content-type': 'text/html', server: 'AkamaiGHost', 'mime-version': '1.0' })
      .end(accessDeniedHtml(request.headers.host ?? 'localhost', request.url ?? '/', reference))
    return 'sent'
  }

  const page = (exchange: Exchange): PageContext => {
    const sensorValue = newSensorValue()
    issuedSensors.add(sensorValue)
    return { sensorValue, shopper: store.firstNameOf(exchange.visitor), pageScript }
  }

  const switchVisitor = (exchange: Exchange, username: string | null): void => {
    exchange.visitor = store.startVisitor(username, exchange.visitor)
    exchange.setCookies.push(
      serializeCookie(SESSION_COOKIE, exchange.visitor.token, { httpOnly: true, secure }),
    )
  }

  const hostile = options.hostile ?? {}
  const openRedirect = hostile.openRedirectAfterLogin === true
  const cookieDomain = parentDomainOf(options.hostname)
  const captchaFrameHostname = options.captchaFrameHostname ?? CAPTCHA_FRAME_HOSTNAME
  let origin = ''
  let authOrigin = ''

  /** www's /auth/login: remembers the login for this browser and sends it to Auth0. */
  const startLogin = (exchange: Exchange): Sent => {
    const redirectUri = exchange.params.get('redirect_uri') ?? `${origin}/auth/callback`
    const state = broker.begin(exchange.visitor.token, exchange.params.get('path') ?? '/')
    const authorize = new URL('/authorize', authOrigin)
    authorize.searchParams.set('client_id', 'fake-woolworths')
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('scope', 'openid profile email')
    authorize.searchParams.set('redirect_uri', redirectUri)
    authorize.searchParams.set('state', state)
    return redirect(exchange, authorize.toString())
  }

  /** www's /auth/callback: a code Auth0 issued for a login this browser started, then its path. */
  const finishLogin = (exchange: Exchange): Sent => {
    const done = broker.complete(
      exchange.params.get('state') ?? '',
      exchange.params.get('code') ?? '',
      exchange.visitor.token,
    )
    if (done === null) return html(exchange, 403, loginFailedPage(page(exchange)))
    switchVisitor(exchange, done.username)
    const hijack = hostile.redirectAfterLogin
    if (hijack?.from === 'callback') return redirect(exchange, hijack.to)
    return redirect(exchange, openRedirect ? done.path : sitePath(done.path))
  }

  const parseJson = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  /** A product-bearing API response, drifted while setShapeDrift() is on. */
  const productJson = (exchange: Exchange, status: number, body: unknown): Sent =>
    json(exchange, status, shapeDrift === null ? body : applyShapeDrift(body, shapeDrift))

  const api = (exchange: Exchange): Sent => {
    const { method, path } = exchange
    const trolley = store.trolleyOf(exchange.visitor)
    if (method === 'GET' && path === '/api/ui/v2/bootstrap') {
      const firstName = store.firstNameOf(exchange.visitor)
      return json(exchange, 200, { ShopperDetails: { IsLoggedIn: firstName !== null, FirstName: firstName } })
    }
    if (path === '/apis/ui/search/products' && (method === 'GET' || method === 'POST')) {
      const query =
        method === 'GET'
          ? searchQueryFromParams(exchange.params)
          : searchQueryFromJson(parseJson(exchange.body))
      if (query === null) return json(exchange, 400, INVALID_REQUEST)
      return productJson(exchange, 200, searchResponse(query, trolley))
    }
    const detail = /^\/apis\/ui\/product\/detail\/([^/]+)$/.exec(path)
    if (method === 'GET' && detail !== null) {
      const code = detail[1] ?? ''
      const body = /^\d{1,9}$/.test(code) ? productDetailResponse(Number(code), trolley) : null
      return body === null ? json(exchange, 404, productNotFoundResponse()) : productJson(exchange, 200, body)
    }
    if (method === 'GET' && path === '/apis/ui/trolley')
      return productJson(exchange, 200, trolleyResponse(trolley))
    if (method === 'POST' && path === '/api/v3/ui/trolley/update') {
      const outcome = applyTrolleyUpdate(trolley, parseJson(exchange.body))
      if (!outcome.ok) return json(exchange, 400, INVALID_REQUEST)
      return productJson(exchange, 200, trolleyResponse(trolley))
    }
    if (method === 'POST' && path === '/api/v3/ui/checkout/order') {
      // Exists only so tests can prove the runtime never lets a request reach it.
      const orderId = nextOrderId
      nextOrderId += 1
      trolley.clear()
      return json(exchange, 200, { OrderId: orderId })
    }
    return json(exchange, 404, NO_RESOURCE)
  }

  const site = (exchange: Exchange): Sent => {
    const { method, path } = exchange
    const loggedIn = exchange.visitor.username !== null
    if (method === 'GET' && path === '/') return html(exchange, 200, homePage(page(exchange)))
    if (method === 'GET' && path === '/shop/securelogin') {
      if (loggedIn) return redirect(exchange, '/shop/myaccount')
      return html(exchange, 200, notLoggedInPage(page(exchange), loginHref(origin, '/shop/myaccount')))
    }
    if (method === 'GET' && path === '/auth/login') return startLogin(exchange)
    if (method === 'GET' && path === '/auth/callback') return finishLogin(exchange)
    if (method === 'GET' && path === '/shop/myaccount') {
      if (!loggedIn) return redirect(exchange, '/shop/securelogin')
      return html(exchange, 200, myAccountPage(page(exchange)))
    }
    if ((method === 'GET' || method === 'POST') && path === '/auth/logout') {
      switchVisitor(exchange, null)
      return redirect(exchange, '/')
    }
    if (method === 'GET' && path === '/shop/search/products') {
      const term = exchange.params.get('searchTerm') ?? ''
      const products = searchCatalogue({
        term,
        pageSize: MAX_PAGE_SIZE,
        pageNumber: 1,
        sort: 'TraderRelevance',
        specialsOnly: false,
      }).slice(0, MAX_PAGE_SIZE)
      return html(exchange, 200, searchPage(page(exchange), term, products))
    }
    return html(exchange, 404, notFoundPage(page(exchange)))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<Sent> => {
    const body = await readBody(request)
    requests.push(recordRequest(request, body.text, now()))
    if (body.truncated) {
      response.writeHead(413, { 'content-type': 'text/plain', connection: 'close' }).end('Payload Too Large')
      return 'sent'
    }
    const target = parseTarget(request.url ?? '/')
    const path = routePath(target.path)
    const cookies = parseCookies(request.headers.cookie)

    // The bot-protection layer, in front of everything.
    const presented = cookies.get(SENSOR_COOKIE)
    let sensor = presented !== undefined && issuedSensors.has(presented) ? presented : null
    const keys = clientKeys(sensor, cookies.get(SESSION_COOKIE))
    if (blockingAll || blocked(keys)) return deny(request, response)
    // A sensor cookie it never issued gets a fresh one rather than a denial, unless told otherwise.
    // Checked after the block, so a blocked session can't get out with a made-up cookie.
    let reissued: string | null = null
    if (presented !== undefined && sensor === null && unknownSensor === 'reissue') {
      reissued = newSensorValue()
      issuedSensors.add(reissued)
      sensor = reissued
      keys.unshift(`sensor:${reissued}`)
    }
    const isApi = path.startsWith('/api/') || path.startsWith('/apis/')
    if (isApi && (sensor === null || tipped(keys))) return deny(request, response)

    const moved = hostile.wwwRedirect
    if (moved !== undefined && path === moved.path.toLowerCase()) {
      response.writeHead(302, { location: moved.to, 'content-type': HTML_TYPE }).end()
      return 'sent'
    }
    // A cart call on a login the site has expired is refused (assumed: README), not served as a
    // new anonymous trolley, so the client can tell it must log in again.
    const token = cookies.get(SESSION_COOKIE)
    if (CART_PATHS.has(path) && store.visitor(token) === null && store.wasExpired(token)) {
      response.writeHead(401, { 'content-type': JSON_TYPE }).end(JSON.stringify({ Message: 'Unauthorized' }))
      return 'sent'
    }

    // Every visitor gets a session token, logged in or not, as on the live site, and Akamai a
    // cookie on the parent domain when there is one.
    const setCookies: string[] = []
    if (reissued !== null) {
      // Script-readable, as the sensor script's own is.
      setCookies.push(
        serializeCookie(SENSOR_COOKIE, reissued, { httpOnly: false, secure, maxAge: SENSOR_MAX_AGE_SECONDS }),
      )
    }
    let visitor = store.visitor(token)
    if (visitor === null) {
      visitor = store.startVisitor()
      setCookies.push(serializeCookie(SESSION_COOKIE, visitor.token, { httpOnly: true, secure }))
      if (cookieDomain !== null && !cookies.has(BOT_MANAGER_COOKIE)) {
        setCookies.push(
          serializeCookie(BOT_MANAGER_COOKIE, newSensorValue(), {
            httpOnly: false,
            secure,
            domain: cookieDomain,
          }),
        )
      }
    }
    const exchange: Exchange = {
      request,
      response,
      method: (request.method ?? 'GET').toUpperCase(),
      path,
      params: target.params,
      cookies,
      body: body.text,
      setCookies,
      visitor,
    }
    return isApi ? api(exchange) : site(exchange)
  }

  const auth0 = new FakeAuth0({
    store,
    broker,
    now,
    secure,
    callbackUrl: () => `${origin}/auth/callback`,
    originOf: (hostname) => originFor(options.tls, hostname, authPort),
    hostile,
    captcha: options.captcha === true,
    captchaFrameHostname,
    cookieDomain,
  })

  const server = createServer(options.tls)
  const authServer = createServer(options.tls)
  for (const [target, handler] of [
    [server, handle],
    [authServer, (request: IncomingMessage, response: ServerResponse) => auth0.handle(request, response)],
  ] as const) {
    target.on('request', (request: IncomingMessage, response: ServerResponse) => {
      handler(request, response).catch(
        /* v8 ignore next 4 */ () => {
          if (!response.headersSent) response.writeHead(500)
          response.end()
        },
      )
    })
  }
  const port = await listen(server, options.port ?? 0)
  let authPort = 0
  try {
    authPort = await listen(authServer, options.authPort ?? 0)
  } catch (error) {
    await closeServer(server)
    throw error
  }
  origin = originFor(options.tls, options.hostname ?? '127.0.0.1', port)
  authOrigin = originFor(options.tls, options.authHostname ?? authHostnameFor(options.hostname), authPort)

  return {
    origin,
    port,
    authOrigin,
    authPort,
    captchaFrameOrigin: originFor(options.tls, captchaFrameHostname, authPort),
    requests,
    authRequests: auth0.requests,
    outbox: auth0.outbox,
    close: async () => {
      await Promise.all([closeServer(server), closeServer(authServer)])
    },
    trolleyFor(username) {
      const state = store.account(username)
      if (state === null) throw new Error('no such fake account')
      return trolleyLines(state.trolley)
    },
    setRateLimit(limit) {
      limiter.setLimit(limit)
    },
    blockAll(on) {
      blockingAll = on
    },
    expireSessions() {
      store.expireSessions()
    },
    expireAuthSessions() {
      auth0.expireSessions()
    },
    setCaptcha(on) {
      auth0.captcha = on
    },
    rejectPasswords(on) {
      store.passwordsRejected = on === true
    },
    setPageBeacon(beacon) {
      pageScript = beacon === null ? '' : beaconScript(validBeacon(beacon))
    },
    setUnknownSensor(mode) {
      unknownSensor = sensorMode(mode)
    },
    setShapeDrift(drift) {
      if (drift !== null && !SHAPE_DRIFTS.includes(drift)) throw new Error('unknown shape drift')
      shapeDrift = drift
    },
  }
}

/** The sensor cookie's lifetime, as the sensor script sets it: a year. */
const SENSOR_MAX_AGE_SECONDS = 31_536_000

function sensorMode(mode: UnknownSensor): UnknownSensor {
  if (mode !== 'reissue' && mode !== 'deny') throw new Error("unknownSensor must be 'reissue' or 'deny'")
  return mode
}

/** auth.woolworths.test for www.woolworths.test; 127.0.0.1 when there is no hostname. */
export function authHostnameFor(hostname: string | undefined): string {
  if (hostname === undefined) return '127.0.0.1'
  return `auth.${hostname.startsWith('www.') ? hostname.slice(4) : hostname}`
}
