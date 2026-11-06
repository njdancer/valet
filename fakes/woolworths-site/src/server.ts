// The fake woolworths.com.au: real HTTP(S) on 127.0.0.1, routing every request the adapter,
// runtime and browser driver touch. See fixtures/README.md for which behaviour is captured and
// which is assumed.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AccountStore,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE,
  type FakeAccount,
  MAX_VERIFY_FAILURES,
  SESSION_COOKIE,
  type Visitor,
} from './accounts'
import { accessDeniedHtml, newSensorValue, SENSOR_COOKIE } from './akamai'
import {
  closeServer,
  createServer,
  listen,
  originFor,
  parseCookies,
  type RecordedRequest,
  readBody,
  recordRequest,
  serializeCookie,
  type TlsOptions,
} from './http'
import {
  homePage,
  loginPage,
  myAccountPage,
  notFoundPage,
  type PageContext,
  searchPage,
  verifyPage,
} from './pages'
import { type RateLimit, RateLimiter } from './rate-limit'
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
  /** Serve HTTPS with this key and certificate; otherwise plain HTTP. */
  readonly tls?: TlsOptions
  /** The hostname reported in `origin`. The server itself always listens on 127.0.0.1. */
  readonly hostname?: string
  /** Defaults to 0, a free port. */
  readonly port?: number
  /** The clock for rate limiting and request timestamps. */
  readonly now?: () => number
  /**
   * Hostile variants, for testing the auth interpreter's guards. Each one makes the site behave
   * like a compromised or careless one. All are off by default.
   */
  readonly hostile?: {
    /** Where the login form posts instead of /auth/login, e.g. the exfil sink's origin. */
    readonly loginFormAction?: string
    /** After a correct password (no 2FA), redirect to the `returnUrl` query parameter unchecked. */
    readonly openRedirectAfterLogin?: boolean
  }
}

export interface FakeWoolworths {
  readonly origin: string
  readonly port: number
  /** Every request received, in arrival order, including blocked ones. Live: it keeps growing. */
  readonly requests: readonly RecordedRequest[]
  close(): Promise<void>
  /** What is in an account's trolley. Throws for an unknown username. */
  trolleyFor(username: string): readonly TrolleyLine[]
  /** Replaces the rate limit (null turns it off) and lifts any current blocks. */
  setRateLimit(limit: RateLimit | null): void
  /** While on, every request gets the Access Denied page, as if the client's IP were blocked. */
  blockAll(on: boolean): void
  /** Logs every visitor out. Remembered devices survive. */
  expireSessions(): void
}

const JSON_TYPE = 'application/json; charset=utf-8'
const HTML_TYPE = 'text/html; charset=utf-8'
const INVALID_REQUEST = { Message: 'The request is invalid.' }
const NO_RESOURCE = { Message: 'No HTTP resource was found that matches the request URI.' }
const WRONG_CREDENTIALS = 'Your email address or password is incorrect. Please try again.'
const WRONG_CODE = 'The code you entered is incorrect. Please try again.'

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
  const limiter = new RateLimiter(options.rateLimit ?? null, now)
  const issuedSensors = new Set<string>()
  const requests: RecordedRequest[] = []
  let blockingAll = false
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
    return { sensorValue, shopper: store.firstNameOf(exchange.visitor) }
  }

  const switchVisitor = (
    exchange: Exchange,
    state: { username?: string; pendingUsername?: string },
  ): void => {
    exchange.visitor = store.startVisitor(state, exchange.visitor)
    exchange.setCookies.push(
      serializeCookie(SESSION_COOKIE, exchange.visitor.token, { httpOnly: true, secure }),
    )
  }

  const hostile = options.hostile ?? {}
  const openRedirect = hostile.openRedirectAfterLogin === true

  /** The login form's action: normally /auth/login, carrying returnUrl only for the open-redirect variant. */
  const loginAction = (exchange: Exchange): string => {
    if (hostile.loginFormAction !== undefined) return hostile.loginFormAction
    const returnUrl = exchange.params.get('returnUrl')
    if (!openRedirect || returnUrl === null) return '/auth/login'
    return `/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`
  }

  const login = (exchange: Exchange): Sent => {
    const form = new URLSearchParams(exchange.body)
    const username = form.get('email') ?? ''
    const state = store.authenticate(username, form.get('password') ?? '')
    if (state === null) {
      return html(exchange, 200, loginPage(page(exchange), WRONG_CREDENTIALS, loginAction(exchange)))
    }
    const needsCode =
      state.account.otpCode !== undefined &&
      !store.deviceRemembered(exchange.cookies.get(DEVICE_COOKIE), username)
    if (needsCode) {
      switchVisitor(exchange, { pendingUsername: username })
      return redirect(exchange, '/auth/verify')
    }
    switchVisitor(exchange, { username })
    return redirect(exchange, (openRedirect ? exchange.params.get('returnUrl') : null) ?? '/shop/myaccount')
  }

  const verify = (exchange: Exchange): Sent => {
    const pending = exchange.visitor.pendingUsername
    const state = pending === null ? null : store.account(pending)
    if (pending === null || state === null) return redirect(exchange, '/shop/securelogin')
    if (exchange.method === 'GET') return html(exchange, 200, verifyPage(page(exchange), null))
    const form = new URLSearchParams(exchange.body)
    if (form.get('code') === state.account.otpCode) {
      switchVisitor(exchange, { username: pending })
      if (form.get('rememberDevice') === 'true') {
        const device = store.rememberDevice(pending)
        exchange.setCookies.push(
          serializeCookie(DEVICE_COOKIE, device, { httpOnly: true, secure, maxAge: DEVICE_COOKIE_MAX_AGE }),
        )
      }
      return redirect(exchange, '/shop/myaccount')
    }
    exchange.visitor.verifyFailures += 1
    if (exchange.visitor.verifyFailures >= MAX_VERIFY_FAILURES) {
      switchVisitor(exchange, {})
      return redirect(exchange, '/shop/securelogin')
    }
    return html(exchange, 200, verifyPage(page(exchange), WRONG_CODE))
  }

  const parseJson = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

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
      return json(exchange, 200, searchResponse(query, trolley))
    }
    const detail = /^\/apis\/ui\/product\/detail\/([^/]+)$/.exec(path)
    if (method === 'GET' && detail !== null) {
      const code = detail[1] ?? ''
      const body = /^\d{1,9}$/.test(code) ? productDetailResponse(Number(code), trolley) : null
      return body === null ? json(exchange, 404, productNotFoundResponse()) : json(exchange, 200, body)
    }
    if (method === 'GET' && path === '/apis/ui/trolley') return json(exchange, 200, trolleyResponse(trolley))
    if (method === 'POST' && path === '/api/v3/ui/trolley/update') {
      const outcome = applyTrolleyUpdate(trolley, parseJson(exchange.body))
      if (!outcome.ok) return json(exchange, 400, INVALID_REQUEST)
      return json(exchange, 200, trolleyResponse(trolley))
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
      return html(exchange, 200, loginPage(page(exchange), null, loginAction(exchange)))
    }
    if (method === 'POST' && path === '/auth/login') return login(exchange)
    if ((method === 'GET' || method === 'POST') && path === '/auth/verify') return verify(exchange)
    if (method === 'GET' && path === '/shop/myaccount') {
      if (!loggedIn) return redirect(exchange, '/shop/securelogin')
      return html(exchange, 200, myAccountPage(page(exchange)))
    }
    if ((method === 'GET' || method === 'POST') && path === '/auth/logout') {
      switchVisitor(exchange, {})
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
    const url = new URL(request.url ?? '/', 'http://fake.invalid')
    const path = url.pathname.toLowerCase()
    const cookies = parseCookies(request.headers.cookie)

    // The bot-protection layer, in front of everything.
    const presented = cookies.get(SENSOR_COOKIE)
    const sensor = presented !== undefined && issuedSensors.has(presented) ? presented : null
    if (blockingAll || (sensor !== null && limiter.isBlocked(sensor))) return deny(request, response)
    const isApi = path.startsWith('/api/') || path.startsWith('/apis/')
    if (isApi && (sensor === null || limiter.hit(sensor))) return deny(request, response)

    // Every visitor gets a session token, logged in or not, as on the live site.
    const setCookies: string[] = []
    let visitor = store.visitor(cookies.get(SESSION_COOKIE))
    if (visitor === null) {
      visitor = store.startVisitor()
      setCookies.push(serializeCookie(SESSION_COOKIE, visitor.token, { httpOnly: true, secure }))
    }
    const exchange: Exchange = {
      request,
      response,
      method: (request.method ?? 'GET').toUpperCase(),
      path,
      params: url.searchParams,
      cookies,
      body: body.text,
      setCookies,
      visitor,
    }
    return isApi ? api(exchange) : site(exchange)
  }

  const server = createServer(options.tls)
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    handle(request, response).catch(
      /* v8 ignore next 4 */ () => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      },
    )
  })
  const port = await listen(server, options.port ?? 0)

  return {
    origin: originFor(options.tls, options.hostname ?? '127.0.0.1', port),
    port,
    requests,
    close: () => closeServer(server),
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
  }
}
