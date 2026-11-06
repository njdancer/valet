// The fake auth.woolworths.com.au: Auth0 Universal Login on its own origin, as the live probe found
// (run 3). www's /auth/login sends the browser to /authorize; an identifier page, a password page
// and, for MFA accounts, a challenge page follow; then the browser goes back to www's callback with
// a one-time code. Auth0 keeps its own session cookie here, so a later /authorize while it lives
// goes straight back to the callback (silent re-login), and a remember-device cookie that skips
// MFA. Nothing here is behind the Akamai simulation: that is www's.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { type AccountState, type AccountStore, type MfaChannel, newToken } from './accounts'
import {
  captchaFramePage,
  ERRORS,
  errorPage,
  type FieldError,
  framedPage,
  identifierPage,
  mfaPage,
  passwordPage,
} from './auth-pages'
import {
  parseCookies,
  parseTarget,
  type RecordedRequest,
  readBody,
  recordRequest,
  serializeCookie,
} from './http'
import type { LoginBroker } from './logins'

/** Auth0's session cookie on the auth origin. */
export const AUTH0_SESSION_COOKIE = 'auth0'
/** "Remember this device": skips MFA for the account it was set for. */
export const REMEMBER_DEVICE_COOKIE = 'auth0-mf'
/** Auth0 remembers a device for 30 days. */
export const REMEMBER_DEVICE_MAX_AGE = 30 * 24 * 60 * 60
/** Wrong codes allowed before the half-finished login is thrown away. */
export const MAX_MFA_FAILURES = 3
/** How long one Universal Login transaction lives. */
export const TRANSACTION_TTL_MS = 30 * 60_000
/** An analytics cookie the login pages set for the whole parent domain, so www gets it too. */
export const AUTH_ANALYTICS_COOKIE = '_ga'
/** Where the CAPTCHA's iframe document is served, on the provider's hostname. */
export const CAPTCHA_FRAME_PATH = '/captcha/frame'

/** A code the fake "sent" by SMS or email, for a test's stand-in for the Messages reader. */
export interface SentMessage {
  readonly channel: 'sms' | 'email'
  readonly username: string
  readonly text: string
  readonly at: number
}

export interface AuthHostile {
  /** Where the password form posts instead, e.g. the exfil sink's origin. */
  readonly loginFormAction?: string
  /** Accept any redirect_uri at /authorize, not only www's callback. */
  readonly openRedirectAfterLogin?: boolean
  /**
   * Once the login is done, send the browser to `to` on the site's own initiative, whatever the
   * request asked for: from Auth0, in place of www's callback and carrying the code ('auth'), or
   * from www's callback once it has set the session ('callback').
   */
  readonly redirectAfterLogin?: { readonly from: 'auth' | 'callback'; readonly to: string }
  /**
   * Serve the identifier and password forms inside an iframe from this other hostname (this
   * server's port), so the form's frame is cross-origin to the page. The caller maps it to 127.0.0.1.
   */
  readonly loginInFrame?: string
  readonly passwordInputType?: string
  readonly codeInputType?: string
}

export interface FakeAuth0Options {
  readonly store: AccountStore
  readonly broker: LoginBroker
  readonly now: () => number
  readonly secure: boolean
  /** www's /auth/callback. A function because the www port is known only once it listens. */
  readonly callbackUrl: () => string
  /** The origin a hostname is served on from this server's port, for the iframe variant. */
  readonly originOf: (hostname: string) => string
  readonly hostile: AuthHostile
  /** Whether bot detection starts on. */
  readonly captcha: boolean
  /** The hostname the CAPTCHA's iframe loads from (on this server's port), a third party's in real life. */
  readonly captchaFrameHostname: string
  /** The parent domain to set AUTH_ANALYTICS_COOKIE on, or null for none (no hostname to share). */
  readonly cookieDomain: string | null
}

interface Transaction {
  readonly id: string
  readonly wwwState: string
  readonly redirectUri: string
  username: string | null
  /** Set once the password was right while a second factor is still due. */
  mfaFor: AccountState | null
  mfaFailures: number
  readonly expiresAt: number
}

/** One request in flight. */
interface Exchange {
  readonly response: ServerResponse
  readonly method: string
  readonly path: string
  readonly params: URLSearchParams
  readonly cookies: Map<string, string>
  readonly form: URLSearchParams
  readonly setCookies: string[]
}

type Sent = 'sent'

const HTML_TYPE = 'text/html; charset=utf-8'
const CHALLENGE = /^\/u\/mfa-(sms|email|otp)-challenge$/

export class FakeAuth0 {
  readonly requests: RecordedRequest[] = []
  readonly outbox: SentMessage[] = []
  private readonly transactions = new Map<string, Transaction>()
  /** Auth0 session token to the username it signed in. */
  private readonly sessions = new Map<string, string>()
  /** Remember-device token to the username it was set for. */
  private readonly devices = new Map<string, string>()
  /** Whether bot detection shows a CAPTCHA, which the fake never accepts. */
  captcha: boolean

  constructor(private readonly options: FakeAuth0Options) {
    this.captcha = options.captcha
  }

  /** Ends every Auth0 session, so the next login asks for the password again. Devices survive. */
  expireSessions(): void {
    this.sessions.clear()
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<Sent> {
    const body = await readBody(request)
    this.requests.push(recordRequest(request, body.text, this.options.now()))
    const target = parseTarget(request.url ?? '/')
    const exchange: Exchange = {
      response,
      method: (request.method ?? 'GET').toUpperCase(),
      path: target.path,
      params: target.params,
      cookies: parseCookies(request.headers.cookie),
      form: new URLSearchParams(body.text),
      setCookies: [],
    }
    if (body.truncated) return this.html(exchange, 413, errorPage('too-large', 'Payload Too Large'))
    return this.route(exchange)
  }

  private route(exchange: Exchange): Sent {
    const { method, path } = exchange
    if (method === 'GET' && path === CAPTCHA_FRAME_PATH) return this.html(exchange, 200, captchaFramePage())
    if (method === 'GET' && path === '/authorize') {
      this.setAnalyticsCookie(exchange)
      return this.authorize(exchange)
    }
    const framed = this.options.hostile.loginInFrame !== undefined
    if (path === '/u/login/identifier' || (framed && path === '/u/login/identifier/frame')) {
      if (method === 'GET') return this.withTransaction(exchange, (t) => this.showIdentifier(exchange, t))
      if (method === 'POST') return this.withTransaction(exchange, (t) => this.identifier(exchange, t))
    }
    if (path === '/u/login/password' || (framed && path === '/u/login/password/frame')) {
      if (method === 'GET') return this.withTransaction(exchange, (t) => this.showPassword(exchange, t))
      if (method === 'POST') return this.withTransaction(exchange, (t) => this.password(exchange, t))
    }
    const challenge = CHALLENGE.exec(path)
    if (challenge !== null && (method === 'GET' || method === 'POST')) {
      const channel = challenge[1] as MfaChannel
      return this.withTransaction(exchange, (t) => this.mfa(exchange, t, channel))
    }
    return this.html(exchange, 404, errorPage('not-found', 'Not found'))
  }

  private authorize(exchange: Exchange): Sent {
    const redirectUri = exchange.params.get('redirect_uri') ?? ''
    const wwwState = exchange.params.get('state') ?? ''
    const allowed =
      this.options.hostile.openRedirectAfterLogin === true || redirectUri === this.options.callbackUrl()
    if (!allowed || !/^https?:\/\//.test(redirectUri)) {
      return this.html(exchange, 400, errorPage('invalid-callback', 'Callback URL mismatch.'))
    }
    if (wwwState === '') return this.html(exchange, 400, errorPage('invalid-request', 'Missing state.'))
    const session = exchange.cookies.get(AUTH0_SESSION_COOKIE)
    const signedIn = session === undefined ? undefined : this.sessions.get(session)
    if (signedIn !== undefined) return this.redirect(exchange, this.callback(redirectUri, wwwState, signedIn))
    const transaction: Transaction = {
      id: newToken(),
      wwwState,
      redirectUri,
      username: null,
      mfaFor: null,
      mfaFailures: 0,
      expiresAt: this.options.now() + TRANSACTION_TTL_MS,
    }
    this.transactions.set(transaction.id, transaction)
    return this.redirect(exchange, this.pagePath('/u/login/identifier', transaction))
  }

  private withTransaction(exchange: Exchange, use: (transaction: Transaction) => Sent): Sent {
    const id = exchange.params.get('state') ?? ''
    const transaction = this.transactions.get(id)
    if (transaction === undefined || this.options.now() >= transaction.expiresAt) {
      this.transactions.delete(id)
      return this.html(exchange, 400, errorPage('invalid-state', 'This login has expired. Start again.'))
    }
    return use(transaction)
  }

  private showIdentifier(
    exchange: Exchange,
    transaction: Transaction,
    error: FieldError | null = null,
  ): Sent {
    if (this.shouldFrame(exchange))
      return this.framed(exchange, 'Log in | Woolworths', '/u/login/identifier', transaction)
    const page = identifierPage({
      state: transaction.id,
      error,
      captcha: this.captcha,
      captchaFrameSrc: this.captchaFrameSrc(),
    })
    return this.html(exchange, error === null ? 200 : 400, page)
  }

  private identifier(exchange: Exchange, transaction: Transaction): Sent {
    const { form } = exchange
    if (form.get('action') !== 'default') {
      return this.html(exchange, 400, errorPage('unsupported', 'This sign-in method is not available here.'))
    }
    if (this.captcha) return this.showIdentifier(exchange, transaction, ERRORS.invalidCaptcha)
    const username = form.get('username') ?? ''
    if (username === '') return this.showIdentifier(exchange, transaction, ERRORS.missingUsername)
    // Auth0 asks for the password whether or not the account exists, so as not to reveal which do.
    transaction.username = username
    transaction.mfaFor = null
    return this.redirect(exchange, this.pagePath('/u/login/password', transaction))
  }

  private showPassword(exchange: Exchange, transaction: Transaction, error: FieldError | null = null): Sent {
    if (transaction.username === null)
      return this.redirect(exchange, this.pagePath('/u/login/identifier', transaction))
    if (this.shouldFrame(exchange)) {
      return this.framed(exchange, 'Enter your password | Woolworths', '/u/login/password', transaction)
    }
    const { hostile } = this.options
    const page = passwordPage({
      state: transaction.id,
      error,
      captcha: this.captcha,
      captchaFrameSrc: this.captchaFrameSrc(),
      ...(hostile.loginFormAction === undefined ? {} : { action: hostile.loginFormAction }),
      ...(hostile.passwordInputType === undefined ? {} : { passwordType: hostile.passwordInputType }),
    })
    return this.html(exchange, error === null ? 200 : 400, page)
  }

  private password(exchange: Exchange, transaction: Transaction): Sent {
    const username = transaction.username
    if (username === null) return this.redirect(exchange, this.pagePath('/u/login/identifier', transaction))
    if (this.captcha) return this.showPassword(exchange, transaction, ERRORS.invalidCaptcha)
    const state = this.options.store.authenticate(username, exchange.form.get('password') ?? '')
    if (state === null) return this.showPassword(exchange, transaction, ERRORS.wrongCredentials)
    if (state.account.blocked === true) return this.showPassword(exchange, transaction, ERRORS.userBlocked)
    const remembered = this.devices.get(exchange.cookies.get(REMEMBER_DEVICE_COOKIE) ?? '') === username
    if (state.account.otpCode === undefined || remembered)
      return this.complete(exchange, transaction, username)
    transaction.mfaFor = state
    transaction.mfaFailures = 0
    const channel = state.account.mfa ?? 'sms'
    this.send(channel, state)
    return this.redirect(exchange, this.pagePath(`/u/mfa-${channel}-challenge`, transaction))
  }

  private mfa(exchange: Exchange, transaction: Transaction, channel: MfaChannel): Sent {
    const state = transaction.mfaFor
    if (state === null || (state.account.mfa ?? 'sms') !== channel) {
      return this.html(exchange, 400, errorPage('invalid-state', 'This login has expired. Start again.'))
    }
    const codeType = this.options.hostile.codeInputType
    const render = (status: number, error: FieldError | null): Sent =>
      this.html(
        exchange,
        status,
        mfaPage({ channel, state: transaction.id, error, ...(codeType === undefined ? {} : { codeType }) }),
      )
    if (exchange.method === 'GET') return render(200, null)
    const action = exchange.form.get('action')
    if (action === 'resend-code' && channel !== 'otp') {
      this.send(channel, state)
      return render(200, null)
    }
    if (action !== 'default') {
      return this.html(exchange, 400, errorPage('unsupported', 'This sign-in method is not available here.'))
    }
    if (exchange.form.get('code') === state.account.otpCode) {
      if (exchange.form.get('rememberBrowser') === 'true') {
        const device = newToken()
        this.devices.set(device, state.account.username)
        exchange.setCookies.push(
          serializeCookie(REMEMBER_DEVICE_COOKIE, device, {
            httpOnly: true,
            secure: this.options.secure,
            maxAge: REMEMBER_DEVICE_MAX_AGE,
          }),
        )
      }
      return this.complete(exchange, transaction, state.account.username)
    }
    transaction.mfaFailures += 1
    if (transaction.mfaFailures >= MAX_MFA_FAILURES) {
      this.transactions.delete(transaction.id)
      return this.html(
        exchange,
        400,
        errorPage('too-many-failures', 'Too many failed attempts. Start again.'),
      )
    }
    return render(400, ERRORS.invalidCode)
  }

  /** Signs `username` in to Auth0 and sends the browser back to www with a one-time code. */
  private complete(exchange: Exchange, transaction: Transaction, username: string): Sent {
    this.transactions.delete(transaction.id)
    const session = newToken()
    this.sessions.set(session, username)
    exchange.setCookies.push(
      serializeCookie(AUTH0_SESSION_COOKIE, session, { httpOnly: true, secure: this.options.secure }),
    )
    return this.redirect(exchange, this.callback(transaction.redirectUri, transaction.wwwState, username))
  }

  private callback(redirectUri: string, wwwState: string, username: string): string {
    const hijack = this.options.hostile.redirectAfterLogin
    const url = new URL(hijack?.from === 'auth' ? hijack.to : redirectUri)
    url.searchParams.set('code', this.options.broker.issueCode(wwwState, username))
    url.searchParams.set('state', wwwState)
    return url.toString()
  }

  private send(channel: MfaChannel, state: AccountState): void {
    if (channel === 'otp') return
    const text = `Your Woolworths verification code is ${state.account.otpCode}. It expires in 5 minutes.`
    this.outbox.push({ channel, username: state.account.username, text, at: this.options.now() })
  }

  private pagePath(path: string, transaction: Transaction): string {
    return `${path}?state=${encodeURIComponent(transaction.id)}`
  }

  private captchaFrameSrc(): string {
    return `${this.options.originOf(this.options.captchaFrameHostname)}${CAPTCHA_FRAME_PATH}`
  }

  private setAnalyticsCookie(exchange: Exchange): void {
    const domain = this.options.cookieDomain
    if (domain === null || exchange.cookies.has(AUTH_ANALYTICS_COOKIE)) return
    exchange.setCookies.push(
      serializeCookie(AUTH_ANALYTICS_COOKIE, `GA1.2.${newToken()}`, {
        httpOnly: false,
        secure: this.options.secure,
        domain,
      }),
    )
  }

  /** The iframe variant wraps the top-level page; the frame's own request ends in /frame. */
  private shouldFrame(exchange: Exchange): boolean {
    return this.options.hostile.loginInFrame !== undefined && !exchange.path.endsWith('/frame')
  }

  private framed(exchange: Exchange, title: string, path: string, transaction: Transaction): Sent {
    const frameHost = this.options.hostile.loginInFrame as string
    const src = `${this.options.originOf(frameHost)}${this.pagePath(`${path}/frame`, transaction)}`
    return this.html(exchange, 200, framedPage(title, src))
  }

  private html(exchange: Exchange, status: number, body: string): Sent {
    const headers: Record<string, string | string[]> = {
      'content-type': HTML_TYPE,
      'cache-control': 'no-store',
    }
    if (exchange.setCookies.length > 0) headers['set-cookie'] = exchange.setCookies
    exchange.response.writeHead(status, headers).end(body)
    return 'sent'
  }

  private redirect(exchange: Exchange, location: string): Sent {
    exchange.response.setHeader('location', location)
    return this.html(exchange, 302, '')
  }
}
