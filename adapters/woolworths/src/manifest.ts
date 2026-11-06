// The Woolworths manifest. The origin is a parameter so that tests and the e2e harness can point
// the same adapter at the fake site (https://www.woolworths.test).
//
// Verified live (anonymous probe, 2026-11-07): the API paths below and the egress hosts. Assumed:
// the login selectors (they are the fake site's; the real ones must be recorded with Nick present),
// the OTP step, and the bootstrap probe. See README.md.
//
// Every way the login can stall ends in needsUser, never in a timeout: docs/security-model.md
// sends challenges and unexpected prompts to the person, and never solves them automatically.

import { type AdapterManifest, type AuthStep, type Condition, parseManifest } from '@siteadapter/core'

export const REAL_ORIGIN = 'https://www.woolworths.com.au'

/** Hosts the live probe found the site cannot work without, beyond its own www host. */
const REAL_EXTRA_EGRESS = ['cdn0.woolworths.media', 'acs.woolworths.com.au']

export const SELECTORS = {
  email: '#loginForm-Email',
  password: '#loginForm-Password',
  submit: '#loginForm-Submit',
  otp: 'input[autocomplete="one-time-code"]',
} as const

export const LOGIN_PATH = '/shop/securelogin'

/**
 * The pauses between looks while waiting for each page change in the login, 20 s in all. The wait
 * never fails, and that is the point: a
 * waitFor that timed out would end the flow as condition-timeout, and the person would never see
 * the challenge or prompt that stalled it.
 */
export const SETTLE_PAUSES_MS = [1000, 2000, 3000, 4000, 5000, 5000] as const

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

const OTP_SHOWN: Condition = { visible: SELECTORS.otp }
const LEFT_LOGIN: Condition = { not: { urlMatches: LOGIN_PATH } }

/** needsUser reasons. Fixed text: the runtime shows it to the person, never to tool code. */
export const NEEDS_USER_REASONS = {
  noForm: 'The Woolworths sign-in form did not appear. The site may be showing a check first.',
  stuck: 'Woolworths did not finish signing in. It may be asking for a check, a code or a correction.',
} as const

export interface ManifestOptions {
  readonly origin?: string
}

export function createManifest({ origin = REAL_ORIGIN }: ManifestOptions = {}): AdapterManifest {
  const host = new URL(origin).hostname
  // A cookie set for ".woolworths.com.au" is stored against the bare host, so copy both.
  const bareHost = host.startsWith('www.') ? host.slice(4) : host
  const cookieDomains = bareHost === host ? [host] : [bareHost, host]
  const egress = origin === REAL_ORIGIN ? [host, ...REAL_EXTRA_EGRESS] : [host]

  return parseManifest({
    schemaVersion: 1,
    id: 'woolworths',
    name: 'Woolworths',
    version: '0.1.0',
    description: 'Search Woolworths (Australia) products and manage the online shopping cart.',
    home: `${origin}/`,
    navigation: [origin],
    egress,
    secrets: {
      login: {
        description: 'Woolworths account sign-in, plus the one-time code when the site asks for one',
        fields: ['username', 'password', 'otp'],
        origins: [origin],
      },
    },
    session: {
      cookieDomains,
      // Anonymous visitors already get wow-auth-token cookies, so a cookie probe would lie.
      probe: {
        kind: 'fetch',
        path: '/api/ui/v2/bootstrap',
        expectStatus: 200,
        jsonPath: 'ShopperDetails.IsLoggedIn',
        equals: true,
      },
    },
    auth: {
      steps: [
        { op: 'goto', url: `${origin}${LOGIN_PATH}` },
        ...settle({ visible: SELECTORS.email }),
        // An interstitial challenge, or a page the selectors don't know: show the window rather
        // than type secrets anywhere.
        { op: 'when', condition: { not: { visible: SELECTORS.email } }, steps: [needsUser('noForm')] },
        { op: 'fill', selector: SELECTORS.email, value: { secret: 'login', field: 'username' } },
        { op: 'fill', selector: SELECTORS.password, value: { secret: 'login', field: 'password' } },
        { op: 'click', selector: SELECTORS.submit },
        // The code prompt, if any, renders after the submit round trip.
        ...settle({ any: [OTP_SHOWN, LEFT_LOGIN] }),
        {
          op: 'when',
          condition: OTP_SHOWN,
          steps: [{ op: 'otp', selector: SELECTORS.otp, source: { secret: 'login' } }, ...settle(LEFT_LOGIN)],
        },
        // Still on the login page: a CAPTCHA, a rejected password, or a prompt nobody scripted.
        // The person sees it; the password is never submitted a second time.
        { op: 'when', condition: { urlMatches: LOGIN_PATH }, steps: [needsUser('stuck')] },
        { op: 'assertLoggedIn' },
      ],
    },
    // Exactly the calls the tools make, so a later version can't read anything new (bootstrap's
    // ShopperDetails, say) without a new permission. The login probe isn't listed: the runtime
    // makes it itself, outside the tool-code surface guard (runtime probe.ts).
    requests: [
      { method: 'POST', path: '/apis/ui/Search/products', purpose: 'read' },
      { method: 'GET', path: '/apis/ui/product/detail/:stockcode', purpose: 'read' },
      { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' },
      { method: 'POST', path: '/api/v3/ui/trolley/update', purpose: 'write' },
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
        description: 'The items in the Woolworths cart, with quantities, line totals, subtotal and savings.',
        sideEffect: 'read',
      },
      {
        name: 'add_to_cart',
        title: 'Add to cart',
        description:
          'Adds a quantity of a product to the cart, on top of any already there. Does not check out.',
        sideEffect: 'write',
      },
      {
        name: 'set_cart_quantity',
        title: 'Set cart quantity',
        description: 'Sets the exact quantity of a product in the cart. Quantity 0 removes it.',
        sideEffect: 'write',
      },
      {
        name: 'remove_from_cart',
        title: 'Remove from cart',
        description: 'Removes a product from the cart entirely.',
        sideEffect: 'write',
      },
    ],
    // Every tool needs at most two site calls; the live site flags bursts of scripted requests.
    limits: { requestsPerRun: 6 },
  })
}

function needsUser(reason: keyof typeof NEEDS_USER_REASONS): AuthStep {
  return { op: 'needsUser', reason: NEEDS_USER_REASONS[reason] }
}

export default createManifest()
