// The Woolworths manifest. The origins are parameters so that tests and the e2e harness can point
// the same adapter at the fake site (https://www.woolworths.test and https://auth.woolworths.test).
//
// Verified live (anonymous probe, 2026-11-07): the API paths, the egress hosts, and the login's
// shape: www's /auth/login hands off to Auth0 Universal Login on auth.woolworths.com.au, whose
// first page asks for the email (input[name=username]). Assumed: Auth0's standard markup for
// everything after that (the password page, MFA, errors, the CAPTCHA and its frame), the Messages
// sender, and the bootstrap probe. See README.md.
//
// Every way the login can stall ends in needsUser, never in a timeout: docs/security-model.md
// sends challenges and unexpected prompts to the person, and never solves them automatically.

import {
  type AdapterManifest,
  type AuthStep,
  type Condition,
  type NeedsUserReason,
  parseManifest,
  type SecretField,
} from '@valet/core'
import { CART_PAGE } from './site'

export const REAL_ORIGIN = 'https://www.woolworths.com.au'
export const REAL_AUTH_ORIGIN = 'https://auth.woolworths.com.au'

/** Hosts the live probe found the site cannot work without, beyond its own www host. */
const REAL_EXTRA_EGRESS = ['cdn0.woolworths.media', 'acs.woolworths.com.au']

/** Auth0 Universal Login's elements. Only `username` was seen live; the rest is Auth0's standard markup. */
export const SELECTORS = {
  username: 'input[name="username"]',
  password: 'input#password[name="password"]',
  code: 'input#code[name="code"]',
  /** The primary button on every Auth0 page, not the passkey, Everyday, resend or other-method ones. */
  submit: 'button[type="submit"][name="action"][value="default"]',
  /** Only while unticked: a click on a ticked box would untick it. */
  rememberDevice: 'input[type="checkbox"][name="rememberBrowser"]:not(:checked)',
  captcha: '.ulp-captcha-container',
  /** The container every Universal Login page renders into, error pages included. */
  auth0Widget: 'main._widget',
  fieldError: '.ulp-input-error-message',
  accountBlocked: '[data-error-code="user-blocked"]',
} as const

/** Paths on the auth origin. Conditions see only a URL's path and query, never its host. */
export const AUTH_PATHS = {
  identifier: '/u/login/identifier',
  password: '/u/login/password',
  smsChallenge: '/u/mfa-sms-challenge',
  otpChallenge: '/u/mfa-otp-challenge',
} as const

/**
 * Who sends the SMS code, as Messages shows the sender. TO BE CONFIRMED: a placeholder until Nick
 * receives a Woolworths code. The person approves the real sender when granting Messages access.
 */
export const MESSAGES_SENDER = 'Woolworths'

/** The live site's login link: www's /auth/login, which redirects to Auth0 and back to `path`. */
export function loginUrl(origin: string): string {
  return `${origin}/auth/login?redirect_uri=${origin}/auth/callback&path=/`
}

/**
 * The pauses between looks while waiting for each page change in the login, 10 s in all. The wait
 * never fails, and that is the point: a waitFor that timed out would end the flow as
 * condition-timeout, and the person would never see the challenge or prompt that stalled it. Kept
 * short so that four of them, plus the wait for an SMS, end inside the runtime's tool timeout
 * (README, "Timing").
 */
export const SETTLE_PAUSES_MS = [500, 1000, 1500, 2000, 2500, 2500] as const

/**
 * Steps that wait for `condition` and return as soon as it holds, or after every pause has run.
 * Built from nested `when`s because the step vocabulary has no loop, and its only waits that check
 * a condition (waitFor) fail on timeout.
 */
export function settle(condition: Condition, pauses: readonly number[] = SETTLE_PAUSES_MS): AuthStep[] {
  const [first, ...rest] = pauses
  if (first === undefined) return []
  return [
    {
      op: 'when',
      condition: { not: condition },
      steps: [{ op: 'pause', ms: first }, ...settle(condition, rest)],
    },
  ]
}

/** On a page the flow knows, by its path and its field, so a lookalike path alone doesn't count. */
const ON_IDENTIFIER: Condition = {
  all: [{ urlContains: AUTH_PATHS.identifier }, { visible: SELECTORS.username }],
}
const ON_PASSWORD: Condition = {
  all: [{ urlContains: AUTH_PATHS.password }, { visible: SELECTORS.password }],
}
const ON_CHALLENGE: Condition = {
  all: [{ urlRegex: '^/u/mfa-(sms|email|otp)-challenge' }, { visible: SELECTORS.code }],
}
/**
 * Off every login page, on either origin: Auth0's /u/, /authorize, /login and /continue, and www's
 * /auth/* hand-off paths and its "not logged in" page. Where it then is, assertLoggedIn decides.
 */
const LEFT_LOGIN: Condition = {
  not: { urlRegex: '^/(u|authorize|login|continue|auth|shop/securelogin)([/?]|$)' },
}
/** Auth0's own pages for new terms or consent, which only the person may accept. */
const TERMS: Condition = { urlRegex: '^/u/(terms|consent)([/?]|$)' }
const CAPTCHA: Condition = { visible: SELECTORS.captcha }
const FIELD_ERROR: Condition = { visible: SELECTORS.fieldError }

/** Why the login stopped, for the person. Shown only in the app, never sent to the MCP client. */
export const NOTES = {
  captcha: 'Woolworths is showing a CAPTCHA. Solve it in this window to finish signing in.',
  noLoginPage:
    'The Woolworths sign-in page did not appear. The site may be showing a check first, or the page has changed.',
  emailRefused:
    'Woolworths did not move past the email address. Check the 1Password item, then sign in here.',
  passwordRefused:
    'Woolworths did not accept the password from 1Password. It was typed once and not retried. Check the item, then sign in here.',
  accountBlocked:
    'Woolworths says the account is blocked after too many attempts. Unblock it (Woolworths usually emails how), then sign in here.',
  emailCode: 'Woolworths sent a code by email, which the adapter cannot read. Type it here.',
  authenticatorCode:
    'Woolworths asks for an authenticator-app code, and this adapter is not set up with one. Type it here.',
  codeRefused: 'Woolworths did not accept the one-time code. Type a new one here.',
  terms: 'Woolworths is asking you to accept new terms before signing in. Read and accept them here.',
  unknownPage:
    'Woolworths stopped on a sign-in page the adapter does not know, such as a prompt to add a phone number or an error page.',
} as const

function needsUser(reason: NeedsUserReason, note: keyof typeof NOTES): AuthStep {
  return { op: 'needsUser', reason, note: NOTES[note] }
}

export interface ManifestOptions {
  readonly origin?: string
  /** Defaults to the real Auth0 origin for the real site, else `origin` with "www." swapped for "auth.". */
  readonly authOrigin?: string
  /**
   * Fill Auth0's authenticator-app challenge from an OTP field on the `login` 1Password item. Off
   * by default: only if Nick's account uses an authenticator (decision D4). Off, that challenge is
   * handed to the person, and the manifest doesn't ask for an OTP field it would never use.
   */
  readonly totp?: boolean
  /**
   * Origins the CAPTCHA's iframe loads from, for auth.frameOrigins. Empty for the real site until
   * the provider is confirmed live (README, open questions): with none, the driver refuses the
   * challenge's frame and the person can't solve it in the login window.
   */
  readonly captchaFrameOrigins?: readonly string[]
  /**
   * Hold every tool until the person has chosen a store (D69). On for a fake origin. Off for the
   * real site until a live session has confirmed the two store requests (README, "Store"): they
   * have never been seen live, and a required setting whose requests are wrong would hold every
   * tool with no way through. Off, the tools run on the site's own choice of store until the
   * person picks one, and a store that can't be applied can be cleared again.
   */
  readonly storeRequired?: boolean
}

/** How long a write tool may rest on the last "logged in" probe before probing again. */
export const PROBE_TRUST_SECONDS = 60
/** How long a search or product answer is reused. Prices and specials change daily, not by the minute. */
export const CATALOGUE_CACHE_SECONDS = 900
/** How long the trolley an add starts from is reused. Short: the person's own browser can change it. */
export const TROLLEY_CACHE_SECONDS = 120

/** The most requests Valet sends the site in an hour. A call that would start past it is refused. */
export const REQUESTS_PER_HOUR = 100

export function createManifest({
  origin = REAL_ORIGIN,
  authOrigin = defaultAuthOrigin(origin),
  totp = false,
  captchaFrameOrigins = [],
  storeRequired = origin !== REAL_ORIGIN,
}: ManifestOptions = {}): AdapterManifest {
  const host = new URL(origin).hostname
  // A cookie set for ".woolworths.com.au" is stored against the bare host, so copy both. Auth0's
  // own cookies are host-only on the auth origin, so neither domain matches them.
  const bareHost = host.startsWith('www.') ? host.slice(4) : host
  const cookieDomains = bareHost === host ? [host] : [bareHost, host]
  const egress = origin === REAL_ORIGIN ? [host, ...REAL_EXTRA_EGRESS] : [host]
  const fields: SecretField[] = totp ? ['username', 'password', 'otp'] : ['username', 'password']

  return parseManifest({
    schemaVersion: 1,
    id: 'woolworths',
    name: 'Woolworths',
    version: '0.3.0',
    description: 'Search Woolworths (Australia) products and manage the online shopping cart.',
    home: `${origin}/`,
    // Opened in the person's own browser to check out: Valet never places orders.
    cartUrl: `${origin}${CART_PAGE}`,
    // The tool partition never needs the auth origin: Auth0's session stays in the auth partition.
    navigation: [origin, authOrigin],
    egress,
    secrets: {
      login: {
        description: totp
          ? 'Woolworths account email and password, plus its authenticator-app code'
          : 'Woolworths account email and password',
        fields,
        // Both fields are typed on Auth0's pages, and both forms post there.
        origins: [authOrigin],
      },
    },
    session: {
      cookieDomains,
      // Anonymous visitors already get wow-auth-token cookies, so a cookie probe would lie.
      // The runtime makes this probe in the tool partition, inside the tool's run, and core v2's
      // driver holds every request there to the request surface. Bootstrap is deliberately not on
      // it, so the probe depends on a runtime-probe allowance core doesn't have yet (README, core
      // change requests). Until then every cart tool's ensure() is refused at the probe.
      probe: {
        kind: 'fetch',
        path: '/api/ui/v2/bootstrap',
        expectStatus: 200,
        loggedOutStatuses: [401],
        jsonPath: 'ShopperDetails.IsLoggedIn',
        equals: true,
        // A third of a shop's requests were this probe, one before every cart call. A write may
        // now rest on a "logged in" answer for a minute; get_cart, a read, always probes. An
        // assumption, not a decision of Nick's (docs/findings/2026-11-10-shop-benchmark.md).
        trustSeconds: PROBE_TRUST_SECONDS,
      },
    },
    auth: { steps: authSteps(origin, totp), frameOrigins: [...captchaFrameOrigins] },
    // Exactly the calls the tools make, so a later version can't read anything new (bootstrap's
    // ShopperDetails, say) without a new permission. The login probe isn't listed, so tool code
    // can't make it; see session.probe for what that costs under core v2.
    // D28's session read cache: search and product answers are kept a while; the trolley only
    // briefly, since the person can change it from their own browser, and a cart write's own reply
    // replaces it.
    requests: [
      {
        method: 'POST',
        path: '/apis/ui/Search/products',
        purpose: 'read',
        cacheSeconds: CATALOGUE_CACHE_SECONDS,
      },
      {
        method: 'GET',
        path: '/apis/ui/product/detail/:stockcode',
        purpose: 'read',
        cacheSeconds: CATALOGUE_CACHE_SECONDS,
      },
      { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read', cacheSeconds: TROLLEY_CACHE_SECONDS },
      { method: 'POST', path: '/api/v3/ui/trolley/update', purpose: 'write', refreshes: '/apis/ui/Trolley' },
      // The store setting's two calls (stores.ts). Assumed paths, never seen live.
      { method: 'GET', path: '/api/v3/ui/fulfilment/stores', purpose: 'read' },
      { method: 'POST', path: '/api/v3/ui/fulfilment', purpose: 'write' },
    ],
    tools: [
      {
        name: 'search_products',
        title: 'Search products',
        description:
          'Search the Woolworths range by keyword. Returns prices, unit (cup) prices, specials and availability. Does not need a login.',
        sideEffect: 'read',
      },
      {
        name: 'get_product',
        title: 'Get product details',
        description:
          'Full details for one product by stockcode: description, ingredients, allergens, nutrition per 100 g or mL, and category.',
        sideEffect: 'read',
      },
      {
        name: 'get_cart',
        title: 'Get cart',
        description:
          'The items in the Woolworths cart, with quantities, line totals, subtotal and savings, and cartUrl: the trolley page where the person checks out in their own browser. This adapter never places orders.',
        sideEffect: 'read',
      },
      {
        name: 'add_to_cart',
        title: 'Add to cart',
        description:
          'Adds a quantity of a product to the cart, on top of any already there. Does not check out.',
        sideEffect: 'write',
        // Only adds, but advertised destructive until Nick answers D30 (docs/plan.md). Not
        // idempotent: a second call adds again.
        destructive: true,
        idempotent: false,
      },
      {
        name: 'set_cart_quantity',
        title: 'Set cart quantity',
        description: 'Sets the exact quantity of a product in the cart. Quantity 0 removes it.',
        sideEffect: 'write',
        // Lowers quantities and removes lines; the same quantity twice is the same cart (AC3).
        destructive: true,
        idempotent: true,
      },
      {
        name: 'remove_from_cart',
        title: 'Remove from cart',
        description: 'Removes a product from the cart entirely.',
        sideEffect: 'write',
        // A second removal finds nothing left to remove.
        destructive: true,
        idempotent: true,
      },
      // The store setting's tools. The runtime runs them; no MCP client can list or call them.
      {
        name: 'find_stores',
        title: 'Find stores',
        description: 'Lists the Woolworths pick-up stores in a postcode, for you to choose one in Valet.',
        sideEffect: 'read',
      },
      {
        name: 'apply_store',
        title: 'Shop at your store',
        description:
          'Tells Woolworths which pick-up store this session shops at: the one you chose in Valet.',
        sideEffect: 'write',
        // Replaces the session's store with the chosen one; the same store twice is the same session.
        destructive: true,
        idempotent: true,
      },
    ],
    // D69: prices, specials and stock follow the store. Where it is required, the tools don't run
    // until one is chosen.
    settings: {
      store: {
        title: 'Store',
        description:
          'The Woolworths pick-up store your agents shop at. Prices, specials and what is in stock are that store’s.',
        required: storeRequired,
        choices: { tool: 'find_stores', queryLabel: 'Postcode' },
        apply: { tool: 'apply_store' },
      },
    },
    // Every tool needs at most two site calls. The live site flagged scripted calls 2.5 s apart
    // within minutes (docs/findings/2026-11-07-woolworths-live-probe.md), so the gap is D28's 10 s.
    // D28 asked for at most 60 requests an hour, which the thirty-item shop (73 requests, more with
    // a login) can't fit. 100 holds one whole shop with room to check and correct it. An
    // assumption, not Nick's decision (docs/findings/2026-11-10-shop-benchmark.md).
    // D28's 4 a minute and its jitter: each gap is 10 to 15 s, never less than 10.
    limits: {
      requestsPerRun: 6,
      minGapMs: 10_000,
      gapJitterPercent: 50,
      requestsPerMinute: 4,
      requestsPerHour: REQUESTS_PER_HOUR,
    },
  })
}

/**
 * The login. Each page is waited for with `settle`, then handled only if it is the page expected,
 * so the same steps serve a full login, a remembered device (no MFA), and a silent re-login, where
 * Auth0's session in the auth partition sends the browser straight back to www with no page and no
 * secret typed. Each secret is typed at most once per run.
 */
function authSteps(origin: string, totp: boolean): AuthStep[] {
  return [
    { op: 'goto', url: loginUrl(origin) },
    ...settle({ any: [ON_IDENTIFIER, ON_PASSWORD, LEFT_LOGIN, CAPTCHA] }),
    { op: 'when', condition: CAPTCHA, steps: [needsUser('captcha', 'captcha')] },

    // Page 1, the identifier. Auth0 skips it when it remembers who is signing in.
    {
      op: 'when',
      condition: ON_IDENTIFIER,
      steps: [
        { op: 'fill', selector: SELECTORS.username, value: { secret: 'login', field: 'username' } },
        { op: 'click', selector: SELECTORS.submit },
        ...settle({ any: [ON_PASSWORD, LEFT_LOGIN, FIELD_ERROR, CAPTCHA] }),
        { op: 'when', condition: CAPTCHA, steps: [needsUser('captcha', 'captcha')] },
        {
          op: 'when',
          condition: { urlContains: AUTH_PATHS.identifier },
          steps: [needsUser('login-required', 'emailRefused')],
        },
      ],
    },

    // Page 2, the password: typed once, and never again in this run whatever comes back.
    {
      op: 'when',
      condition: ON_PASSWORD,
      steps: [
        { op: 'when', condition: CAPTCHA, steps: [needsUser('captcha', 'captcha')] },
        { op: 'fill', selector: SELECTORS.password, value: { secret: 'login', field: 'password' } },
        { op: 'click', selector: SELECTORS.submit },
        ...settle({ any: [ON_CHALLENGE, LEFT_LOGIN, FIELD_ERROR, CAPTCHA] }),
        {
          op: 'when',
          condition: { urlContains: AUTH_PATHS.password },
          steps: [
            {
              op: 'when',
              condition: { visible: SELECTORS.accountBlocked },
              steps: [needsUser('account-locked', 'accountBlocked')],
            },
            { op: 'when', condition: CAPTCHA, steps: [needsUser('captcha', 'captcha')] },
            needsUser('login-required', 'passwordRefused'),
          ],
        },
      ],
    },

    // MFA, when Auth0 asks and the device isn't remembered: the code, "remember this device", submit.
    {
      op: 'when',
      condition: ON_CHALLENGE,
      steps: [
        {
          op: 'when',
          condition: { urlContains: AUTH_PATHS.otpChallenge },
          steps: totp
            ? [{ op: 'otp', selector: SELECTORS.code, source: { secret: 'login' } }]
            : [needsUser('otp-required', 'authenticatorCode')],
          otherwise: [
            {
              op: 'when',
              condition: { urlContains: AUTH_PATHS.smsChallenge },
              steps: [
                {
                  op: 'otp',
                  selector: SELECTORS.code,
                  source: {
                    messages: { sender: MESSAGES_SENDER, pattern: '\\b(\\d{6})\\b', maxAgeSeconds: 300 },
                  },
                },
              ],
              otherwise: [needsUser('otp-required', 'emailCode')],
            },
          ],
        },
        {
          op: 'when',
          condition: { visible: SELECTORS.rememberDevice },
          steps: [{ op: 'click', selector: SELECTORS.rememberDevice }],
        },
        { op: 'click', selector: SELECTORS.submit },
        ...settle({ any: [LEFT_LOGIN, FIELD_ERROR] }),
        { op: 'when', condition: { not: LEFT_LOGIN }, steps: [needsUser('otp-required', 'codeRefused')] },
      ],
    },

    // Anything else still on a login page: new terms, no page loaded, or one nobody scripted. The
    // site has changed under the adapter, which the client should not retry.
    {
      op: 'when',
      condition: { not: LEFT_LOGIN },
      steps: [
        {
          op: 'when',
          condition: TERMS,
          steps: [needsUser('terms-update', 'terms')],
          otherwise: [
            {
              op: 'when',
              condition: { urlRegex: '^/u/' },
              steps: [needsUser('site-changed', 'unknownPage')],
              otherwise: [needsUser('site-changed', 'noLoginPage')],
            },
          ],
        },
      ],
    },
    // Off the login paths but still on an Auth0 page, such as a tenant error page: conditions can't
    // see the host, so Auth0's own container is what tells it apart from www.
    {
      op: 'when',
      condition: { visible: SELECTORS.auth0Widget },
      steps: [needsUser('site-changed', 'unknownPage')],
    },
    { op: 'assertLoggedIn' },
  ]
}

function defaultAuthOrigin(origin: string): string {
  if (origin === REAL_ORIGIN) return REAL_AUTH_ORIGIN
  const url = new URL(origin)
  url.hostname = `auth.${url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname}`
  return url.origin
}

export default createManifest()
