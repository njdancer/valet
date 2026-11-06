import { decideRequest, manifestSchema, secretRefsIn, touchesDeniedSegment } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { createAdapter } from '../src/adapter'
import realManifest, { createManifest, LOGIN_PATH, REAL_ORIGIN, SELECTORS } from '../src/manifest'
import { FAKE_ORIGIN } from './fake-context'

describe('the real manifest', () => {
  it('is the default export and points at the live site', () => {
    expect(realManifest.home).toBe('https://www.woolworths.com.au/')
    expect(realManifest.navigation).toEqual([REAL_ORIGIN])
    expect(manifestSchema.parse(realManifest)).toEqual(realManifest)
  })

  it('allows the hosts the live probe found the site needs, and no others', () => {
    expect(realManifest.egress).toEqual([
      'www.woolworths.com.au',
      'cdn0.woolworths.media',
      'acs.woolworths.com.au',
    ])
  })

  it('copies cookies for the bare domain (".woolworths.com.au") and the www host', () => {
    expect(realManifest.session.cookieDomains).toEqual(['woolworths.com.au', 'www.woolworths.com.au'])
  })

  it('probes login through bootstrap, not the auth cookie anonymous visitors also get', () => {
    expect(realManifest.session.probe).toEqual({
      kind: 'fetch',
      path: '/api/ui/v2/bootstrap',
      expectStatus: 200,
      jsonPath: 'ShopperDetails.IsLoggedIn',
      equals: true,
    })
  })

  it('requests the login secret only for the www origin', () => {
    expect(realManifest.secrets).toEqual({
      login: {
        description: expect.any(String),
        fields: ['username', 'password', 'otp'],
        origins: [REAL_ORIGIN],
      },
    })
  })
})

describe('createManifest with the fake origin', () => {
  const manifest = createManifest({ origin: FAKE_ORIGIN })

  it('parses, with every origin-bearing field on the fake site', () => {
    expect(manifest.home).toBe('https://www.woolworths.test/')
    expect(manifest.navigation).toEqual([FAKE_ORIGIN])
    expect(manifest.secrets).toMatchObject({ login: { origins: [FAKE_ORIGIN] } })
    expect(manifest.auth.steps[0]).toEqual({
      op: 'goto',
      url: 'https://www.woolworths.test/shop/securelogin',
    })
  })

  it('allows egress to the fake host only', () => {
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
  })

  it('copies cookies for just the host when the origin has no www', () => {
    const bare = createManifest({ origin: 'https://woolworths.test' })
    expect(bare.session.cookieDomains).toEqual(['woolworths.test'])
    expect(bare.egress).toEqual(['woolworths.test'])
  })

  it('refuses an http origin', () => {
    expect(() => createManifest({ origin: 'http://www.woolworths.test' })).toThrow()
  })
})

describe('the auth steps', () => {
  const steps = realManifest.auth.steps

  it('fill the username, password and code from the login secret, and nothing else', () => {
    expect(secretRefsIn(steps)).toEqual([
      { secret: 'login', field: 'username' },
      { secret: 'login', field: 'password' },
      { secret: 'login', field: 'otp' },
    ])
  })

  it('type the password into the password field, not the email field', () => {
    expect(steps).toContainEqual({
      op: 'fill',
      selector: '#loginForm-Password',
      value: { secret: 'login', field: 'password' },
    })
    expect(steps).toContainEqual({
      op: 'fill',
      selector: '#loginForm-Email',
      value: { secret: 'login', field: 'username' },
    })
  })

  it('only fill the one-time code when the code input appears', () => {
    const when = steps.find((step) => step.op === 'when')
    expect(when).toEqual({
      op: 'when',
      condition: { visible: SELECTORS.otp },
      steps: [{ op: 'otp', selector: 'input[autocomplete="one-time-code"]', source: { secret: 'login' } }],
    })
  })

  it('wait to leave the login page, then assert the login', () => {
    expect(steps.slice(-2)).toEqual([
      { op: 'waitFor', condition: { not: { urlMatches: LOGIN_PATH } }, timeoutMs: 30_000 },
      { op: 'assertLoggedIn' },
    ])
  })

  it('never navigate anywhere but the login page', () => {
    const gotos = steps.filter((step) => step.op === 'goto')
    expect(gotos).toEqual([{ op: 'goto', url: `${REAL_ORIGIN}/shop/securelogin` }])
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

  it('refuses checkout and payment calls on the site itself', () => {
    const attempts = [
      ['POST', `${REAL_ORIGIN}/api/v3/ui/checkout/submit`],
      ['POST', `${REAL_ORIGIN}/apis/ui/Checkout/PlaceOrder`],
      ['GET', `${REAL_ORIGIN}/api/v3/ui/payment/instruments`],
      ['POST', `${REAL_ORIGIN}/api/v3/ui/trolley/update/../checkout`],
    ] as const
    for (const [method, url] of attempts) {
      expect(decideRequest(method, url, egress, requests).allowed).toBe(false)
    }
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
