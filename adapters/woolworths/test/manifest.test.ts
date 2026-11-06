import {
  decideRequest,
  hostAllowed,
  isScreenedPattern,
  manifestSchema,
  messagesSourcesIn,
  parseManifest,
  secretRefsIn,
  touchesDeniedSegment,
} from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { createAdapter } from '../src/adapter'
import realManifest, {
  createManifest,
  loginUrl,
  MESSAGES_SENDER,
  NOTES,
  REAL_AUTH_ORIGIN,
  REAL_ORIGIN,
  SELECTORS,
} from '../src/manifest'
import { FAKE_ORIGIN } from './fake-context'

const FAKE_AUTH_ORIGIN = 'https://auth.woolworths.test'

/** Every condition anywhere in the steps, nested ones included. */
function conditionsIn(value: unknown): any[] {
  const found: any[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
    } else if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>
      if ('urlRegex' in record || 'urlContains' in record || 'visible' in record) found.push(record)
      for (const item of Object.values(record)) visit(item)
    }
  }
  visit(value)
  return found
}

/** Every step anywhere in the steps, nested ones included. */
function stepsIn(steps: readonly unknown[]): any[] {
  const found: any[] = []
  for (const step of steps as any[]) {
    found.push(step)
    if (Array.isArray(step.steps)) found.push(...stepsIn(step.steps))
    if (Array.isArray(step.otherwise)) found.push(...stepsIn(step.otherwise))
  }
  return found
}

describe('the real manifest', () => {
  it('is the default export and points at the live site', () => {
    expect(realManifest.home).toBe('https://www.woolworths.com.au/')
    expect(realManifest.version).toBe('0.2.0')
    expect(manifestSchema.parse(realManifest)).toEqual(realManifest)
  })

  it('navigates the auth partition to www and to Auth0, which the live probe found on its own origin', () => {
    expect(realManifest.navigation).toEqual([REAL_ORIGIN, REAL_AUTH_ORIGIN])
    expect(REAL_AUTH_ORIGIN).toBe('https://auth.woolworths.com.au')
  })

  it('allows the hosts the live probe found the site needs, and no others: never the auth origin', () => {
    expect(realManifest.egress).toEqual([
      'www.woolworths.com.au',
      'cdn0.woolworths.media',
      'acs.woolworths.com.au',
    ])
    expect(hostAllowed('auth.woolworths.com.au', realManifest.egress)).toBe(false)
  })

  it('copies cookies for the bare domain (".woolworths.com.au") and the www host, never Auth0’s', () => {
    expect(realManifest.session.cookieDomains).toEqual(['woolworths.com.au', 'www.woolworths.com.au'])
    // Auth0's session cookie is host-only on the auth origin, so the hand-off never carries it.
    expect(hostAllowed('auth.woolworths.com.au', realManifest.session.cookieDomains)).toBe(false)
  })

  it('probes login through bootstrap, not the auth cookie anonymous visitors also get', () => {
    expect(realManifest.session.probe).toEqual({
      kind: 'fetch',
      path: '/api/ui/v2/bootstrap',
      expectStatus: 200,
      loggedOutStatuses: [401],
      jsonPath: 'ShopperDetails.IsLoggedIn',
      equals: true,
    })
  })

  it('requests the login secret, email and password only, for the Auth0 origin only', () => {
    expect(realManifest.secrets).toEqual({
      login: {
        description: 'Woolworths account email and password',
        fields: ['username', 'password'],
        origins: [REAL_AUTH_ORIGIN],
      },
    })
  })

  it('lets no subframe origin onto the auth page beyond the navigation list until the CAPTCHA is confirmed', () => {
    // The CAPTCHA provider's frame origin is an open question (README); see the e2e for what [] costs.
    expect(realManifest.auth.frameOrigins).toEqual([])
  })

  it('declares the CAPTCHA frame origins it is given, and only for the auth page', () => {
    const manifest = createManifest({ captchaFrameOrigins: ['https://challenges.cloudflare.com'] })
    expect(manifest.auth.frameOrigins).toEqual(['https://challenges.cloudflare.com'])
    expect(manifest.navigation).toEqual(realManifest.navigation)
    expect(manifest.egress).toEqual(realManifest.egress)
    expect(manifest.secrets['login']?.origins).toEqual([REAL_AUTH_ORIGIN])
  })

  it('refuses a CAPTCHA frame origin core would not accept as an origin', () => {
    expect(() => createManifest({ captchaFrameOrigins: ['https://*.hcaptcha.com'] })).toThrow()
    expect(() => createManifest({ captchaFrameOrigins: ['http://challenges.cloudflare.com'] })).toThrow()
  })

  it('paces requests at least 2.5 s apart, with the default breaker cool-downs', () => {
    expect(realManifest.limits).toEqual({
      requestsPerRun: 6,
      minGapMs: 2500,
      cooldownSeconds: 600,
      maxCooldownSeconds: 7200,
    })
  })
})

describe('createManifest with totp', () => {
  const manifest = createManifest({ totp: true })

  it('also asks for the OTP field of the same 1Password item', () => {
    expect(manifest.secrets['login']).toEqual({
      description: 'Woolworths account email and password, plus its authenticator-app code',
      fields: ['username', 'password', 'otp'],
      origins: [REAL_AUTH_ORIGIN],
    })
  })

  it('fills the authenticator code from it, and still reads SMS codes from Messages', () => {
    expect(secretRefsIn(manifest.auth.steps)).toEqual([
      { secret: 'login', field: 'username' },
      { secret: 'login', field: 'password' },
      { secret: 'login', field: 'otp' },
    ])
    expect(messagesSourcesIn(manifest.auth.steps)).toHaveLength(1)
  })
})

describe('createManifest with the fake origins', () => {
  const manifest = createManifest({ origin: FAKE_ORIGIN })

  it('parses, with every origin-bearing field on the fake site', () => {
    expect(manifest.home).toBe('https://www.woolworths.test/')
    expect(manifest.navigation).toEqual([FAKE_ORIGIN, FAKE_AUTH_ORIGIN])
    expect(manifest.secrets).toMatchObject({ login: { origins: [FAKE_AUTH_ORIGIN] } })
    expect(manifest.auth.steps[0]).toEqual({
      op: 'goto',
      url: 'https://www.woolworths.test/auth/login?redirect_uri=https://www.woolworths.test/auth/callback&path=/',
    })
  })

  it('derives the auth origin with its port, and takes one given', () => {
    const ported = createManifest({ origin: 'https://www.woolworths.test:8443' })
    expect(ported.navigation).toEqual([
      'https://www.woolworths.test:8443',
      'https://auth.woolworths.test:8443',
    ])
    const bare = createManifest({ origin: 'https://woolworths.test' })
    expect(bare.navigation).toEqual(['https://woolworths.test', 'https://auth.woolworths.test'])
    const given = createManifest({
      origin: 'https://www.woolworths.test:8443',
      authOrigin: 'https://auth.woolworths.test:9443',
    })
    expect(given.navigation).toEqual([
      'https://www.woolworths.test:8443',
      'https://auth.woolworths.test:9443',
    ])
    expect(given.secrets['login']?.origins).toEqual(['https://auth.woolworths.test:9443'])
  })

  it('allows egress to the fake www host only', () => {
    expect(manifest.egress).toEqual(['www.woolworths.test'])
    expect(manifest.session.cookieDomains).toEqual(['woolworths.test', 'www.woolworths.test'])
  })

  it('cannot reach the live site, so an e2e run against the fake never touches Woolworths', () => {
    const decision = decideRequest(
      'GET',
      `${REAL_ORIGIN}/apis/ui/Trolley`,
      manifest.egress,
      manifest.requests,
    )
    expect(decision).toEqual({ allowed: false, reason: 'host-not-allowed' })
    expect(manifest.navigation.some((origin) => origin.includes('woolworths.com.au'))).toBe(false)
    expect(JSON.stringify(manifest.auth.steps)).not.toContain('woolworths.com.au')
  })

  it('copies cookies for just the host when the origin has no www', () => {
    const bare = createManifest({ origin: 'https://woolworths.test' })
    expect(bare.session.cookieDomains).toEqual(['woolworths.test'])
    expect(bare.egress).toEqual(['woolworths.test'])
  })

  it('refuses an http origin, and an IP-literal one', () => {
    expect(() => createManifest({ origin: 'http://www.woolworths.test' })).toThrow()
    expect(() =>
      createManifest({ origin: 'https://127.0.0.1:8443', authOrigin: 'https://127.0.0.1:9443' }),
    ).toThrow()
  })
})

describe('the auth steps', () => {
  const steps = realManifest.auth.steps
  const all = stepsIn(steps)

  it('start at the live site’s login link', () => {
    expect(steps[0]).toEqual({ op: 'goto', url: loginUrl(REAL_ORIGIN) })
    expect(loginUrl(REAL_ORIGIN)).toBe(
      'https://www.woolworths.com.au/auth/login?redirect_uri=https://www.woolworths.com.au/auth/callback&path=/',
    )
  })

  it('never navigate anywhere else themselves', () => {
    expect(all.filter((step) => step.op === 'goto')).toEqual([steps[0]])
  })

  it('fill the username and password from the login secret, and read SMS codes from Messages', () => {
    expect(secretRefsIn(steps)).toEqual([
      { secret: 'login', field: 'username' },
      { secret: 'login', field: 'password' },
    ])
    expect(messagesSourcesIn(steps)).toEqual([
      { sender: MESSAGES_SENDER, pattern: String.raw`\b(\d{6})\b`, maxAgeSeconds: 300 },
    ])
    expect(MESSAGES_SENDER).toBe('Woolworths')
  })

  it('type the password into the password field and the email into the username field', () => {
    const fills = all.filter((step) => step.op === 'fill')
    expect(fills).toEqual([
      { op: 'fill', selector: SELECTORS.username, value: { secret: 'login', field: 'username' } },
      { op: 'fill', selector: SELECTORS.password, value: { secret: 'login', field: 'password' } },
    ])
    expect(SELECTORS.username).toBe('input[name="username"]')
  })

  it('click only Auth0’s primary button and the remember-device box, never passkey or Everyday', () => {
    const clicks = new Set(all.filter((step) => step.op === 'click').map((step) => step.selector))
    expect(clicks).toEqual(new Set([SELECTORS.submit, SELECTORS.rememberDevice]))
    expect(SELECTORS.submit).toBe('button[type="submit"][name="action"][value="default"]')
  })

  it('tick remember-device only while it is unticked', () => {
    expect(SELECTORS.rememberDevice).toContain(':not(:checked)')
    expect(all).toContainEqual({
      op: 'when',
      condition: { visible: SELECTORS.rememberDevice },
      steps: [{ op: 'click', selector: SELECTORS.rememberDevice }],
    })
  })

  it('use only urlContains and screened urlRegex conditions for URLs', () => {
    const urlConditions = conditionsIn(steps).filter((c) => 'urlRegex' in c || 'urlContains' in c)
    expect(urlConditions.length).toBeGreaterThan(0)
    for (const condition of urlConditions) {
      if ('urlRegex' in condition) expect(isScreenedPattern(condition.urlRegex as string)).toBe(true)
    }
    expect(JSON.stringify(steps)).not.toContain('urlMatches')
  })

  it('tell the login pages from www by path alone, since conditions never see the host', () => {
    const leftLogin = conditionsIn(steps).find(
      (c) => typeof c.urlRegex === 'string' && c.urlRegex.includes('authorize'),
    )
    const regex = new RegExp(leftLogin?.urlRegex as string)
    for (const onLogin of [
      '/u/login/identifier?state=x',
      '/u/mfa-sms-challenge?state=x',
      '/authorize?client_id=x',
      '/login/callback?x',
      '/continue?state=x',
      '/auth/login?redirect_uri=x',
      '/auth/callback?code=x',
      '/shop/securelogin',
    ]) {
      expect(regex.test(onLogin)).toBe(true)
    }
    for (const offLogin of ['/', '/?x=1', '/shop/myaccount', '/shop/browse/dairy', '/authors', '/users']) {
      expect(regex.test(offLogin)).toBe(false)
    }
  })

  it('contain no waitFor, whose timeout would end the flow as a failure instead of needsUser', () => {
    expect(all.some((step) => step.op === 'waitFor')).toBe(false)
  })

  it('contain no fail step: every stop is needsUser with a reason code and an in-app note', () => {
    expect(all.some((step) => step.op === 'fail')).toBe(false)
    const stops = all.filter((step) => step.op === 'needsUser')
    expect(new Set(stops.map((step) => step.reason))).toEqual(
      new Set([
        'captcha',
        'login-required',
        'account-locked',
        'otp-required',
        'terms-update',
        'site-changed',
      ]),
    )
    for (const stop of stops) expect(Object.values(NOTES)).toContain(stop.note)
    for (const note of Object.values(NOTES)) expect(note.length).toBeLessThanOrEqual(200)
  })

  it('end in assertLoggedIn', () => {
    expect(steps.at(-1)).toEqual({ op: 'assertLoggedIn' })
  })
})

describe('the request surface', () => {
  const { egress, requests } = realManifest

  it('declares nothing irreversible and no checkout or payment path', () => {
    for (const request of requests) {
      expect(request.purpose).not.toBe('irreversible')
      expect(touchesDeniedSegment(request.path)).toBe(false)
    }
  })

  it('only lets the trolley update write', () => {
    expect(requests.filter((request) => request.purpose === 'write')).toEqual([
      { method: 'POST', path: '/api/v3/ui/trolley/update', purpose: 'write' },
    ])
  })

  const CHECKOUT_ATTEMPTS = [
    ['POST', `${REAL_ORIGIN}/api/v3/ui/checkout/submit`],
    ['POST', `${REAL_ORIGIN}/apis/ui/Checkout/PlaceOrder`],
    ['GET', `${REAL_ORIGIN}/api/v3/ui/payment/instruments`],
    ['POST', `${REAL_ORIGIN}/api/v3/ui/trolley/update/../checkout`],
  ] as const

  it('refuses checkout and payment calls on the site itself, as undeclared', () => {
    for (const [method, url] of CHECKOUT_ATTEMPTS) {
      expect(decideRequest(method, url, egress, requests)).toEqual({ allowed: false, reason: 'undeclared' })
    }
  })

  it('still refuses them, as denied-path, if a later edit declares a wildcard write over them', () => {
    const broadened = parseManifest({
      ...realManifest,
      requests: [
        ...realManifest.requests,
        { method: 'POST', path: '/api/v3/ui/*', purpose: 'write' },
        { method: 'POST', path: '/apis/ui/*', purpose: 'write' },
        { method: 'GET', path: '/api/v3/ui/*', purpose: 'read' },
      ],
    })
    for (const [method, url] of CHECKOUT_ATTEMPTS) {
      expect(decideRequest(method, url, broadened.egress, broadened.requests)).toEqual({
        allowed: false,
        reason: 'denied-path',
      })
    }
    // The wildcard does match: without the deny list these would be allowed.
    expect(
      decideRequest('POST', `${REAL_ORIGIN}/api/v3/ui/trolley/clear`, broadened.egress, broadened.requests),
    ).toMatchObject({ allowed: true })
  })

  it("does not let tool code read the login probe, which can carry the shopper's details", () => {
    expect(realManifest.requests.some((request) => request.path.includes('bootstrap'))).toBe(false)
    expect(decideRequest('GET', `${REAL_ORIGIN}/api/ui/v2/bootstrap`, egress, requests)).toEqual({
      allowed: false,
      reason: 'undeclared',
    })
  })

  it('refuses a declared path with the wrong method', () => {
    expect(decideRequest('DELETE', `${REAL_ORIGIN}/apis/ui/Trolley`, egress, requests)).toEqual({
      allowed: false,
      reason: 'undeclared',
    })
    expect(decideRequest('GET', `${REAL_ORIGIN}/api/v3/ui/trolley/update`, egress, requests)).toEqual({
      allowed: false,
      reason: 'undeclared',
    })
  })

  it('refuses the API paths on a host that is not the site', () => {
    const lookalikes = [
      'https://www.woolworths.com.au.evil.example/apis/ui/Trolley',
      'https://evil.example/apis/ui/Trolley',
      'https://woolworths.com.au/apis/ui/Trolley',
      'http://www.woolworths.com.au/apis/ui/Trolley',
    ]
    for (const url of lookalikes) {
      expect(decideRequest('GET', url, egress, requests).allowed).toBe(false)
    }
  })

  it('keeps the per-run request ceiling low, because the site flags bursts', () => {
    expect(realManifest.limits.requestsPerRun).toBeLessThanOrEqual(10)
  })
})

describe('the tool declarations', () => {
  it('mark the cart tools as writes and nothing as irreversible', () => {
    const sideEffects = Object.fromEntries(realManifest.tools.map((t) => [t.name, t.sideEffect]))
    expect(sideEffects).toEqual({
      search_products: 'read',
      get_product: 'read',
      get_cart: 'read',
      add_to_cart: 'write',
      set_cart_quantity: 'write',
      remove_from_cart: 'write',
    })
  })
})

describe('createAdapter', () => {
  it('implements exactly the declared tools, for either origin', () => {
    expect(Object.keys(createAdapter().tools).sort()).toEqual(realManifest.tools.map((t) => t.name).sort())
    expect(createAdapter({ origin: FAKE_ORIGIN }).manifest.home).toBe('https://www.woolworths.test/')
  })
})
