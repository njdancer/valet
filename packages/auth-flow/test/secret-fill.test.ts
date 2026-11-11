import {
  CredentialError,
  type Grant,
  MESSAGES_SECRET,
  parseManifest,
  type ResolveFailure,
  type SecretValue,
} from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import {
  CANARY,
  EVIL,
  GRANT,
  HASH,
  ITEM,
  LOGIN,
  LOGIN_PAGE,
  MANIFEST,
  manifestWithSteps,
  SENDER,
  WWW,
  world,
} from './fixtures'

const FILL_PASSWORD = manifestWithSteps([
  { op: 'goto', url: LOGIN_PAGE },
  { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
])

const FILL_USERNAME = manifestWithSteps([
  { op: 'goto', url: LOGIN_PAGE },
  { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
])

/** Asserts that the guard stopped the fill before any secret was fetched or typed. */
function expectNothingReleased(w: ReturnType<typeof world>): void {
  expect(w.provider.calls).toEqual([])
  expect(w.page.typed).toEqual([])
  expect(w.audit.events.filter((e) => e.type === 'secret-used')).toEqual([])
}

// These flows fill and stop. Every flow finishes with the probe, so tests that expect ok start with
// the auth partition's session cookie already set.
describe('a secret fill that passes every guard', () => {
  it('types the password as a SecretValue with the typing delay, only on the allowed origins', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed).toEqual([
      {
        selector: '#password',
        url: LOGIN_PAGE,
        text: CANARY.password,
        secret: true,
        delayMs: 40,
        allowedOrigins: [LOGIN],
      },
    ])
  })

  it('fetches the value from the granted item, just in time', async () => {
    const w = world()
    w.input.manifest = FILL_PASSWORD
    await runAuthFlow(w.input)
    expect(w.provider.calls).toEqual([{ itemRef: ITEM, field: 'password' }])
  })

  it('disposes the value after typing it', async () => {
    const w = world()
    w.input.manifest = FILL_PASSWORD
    await runAuthFlow(w.input)
    expect(w.provider.issued).toHaveLength(1)
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('does not require a username field to belong to a form', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.page.site[LOGIN_PAGE] = { elements: { '#email': { inputType: 'email' } } }
    w.input.manifest = FILL_USERNAME
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('accepts a login form inside a frame on a granted origin, on a page of that origin', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.page.site[LOGIN_PAGE] = {
      frames: { sso: LOGIN },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'sso', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })
})

describe('guard: the grant', () => {
  it('refuses when there is no grant', async () => {
    const w = world()
    w.grants.grants.length = 0
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'not-granted',
    })
    expectNothingReleased(w)
  })

  it('refuses a grant made for an earlier version of the adapter', async () => {
    const w = world()
    w.grants.grants[0] = { ...GRANT, adapterHash: 'a-different-hash' }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
    expectNothingReleased(w)
  })

  it('refuses a grant for another adapter, even from a store that returns it', async () => {
    const w = world()
    vi.spyOn(w.grants, 'find').mockResolvedValue({ ...GRANT, adapterId: 'other-shop' })
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
    expectNothingReleased(w)
  })

  it('refuses a grant for another hash, even from a store that returns it', async () => {
    const w = world()
    vi.spyOn(w.grants, 'find').mockResolvedValue({ ...GRANT, adapterHash: 'other' })
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
    expectNothingReleased(w)
  })

  it('refuses a grant for another secret, even from a store that returns it', async () => {
    const w = world()
    vi.spyOn(w.grants, 'find').mockResolvedValue({ ...GRANT, secret: 'bank' })
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
    expectNothingReleased(w)
  })

  it('reports a grant store that throws as grant: internal', async () => {
    const w = world()
    vi.spyOn(w.grants, 'find').mockRejectedValue(new Error('SQLITE_CORRUPT'))
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'grant', errorClass: 'internal' })
    expectNothingReleased(w)
  })
})

describe('guard: the manifest request', () => {
  it('refuses a field the manifest secret does not request', async () => {
    const w = world()
    const manifest = FILL_PASSWORD
    w.input.manifest = {
      ...manifest,
      secrets: { login: { description: 'Shop account', fields: ['username'], origins: [LOGIN] } },
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'invalid',
    })
    expectNothingReleased(w)
  })

  it('refuses a secret the manifest does not declare at all', async () => {
    const w = world()
    w.input.manifest = { ...FILL_PASSWORD, secrets: {} }
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'invalid' })
    expectNothingReleased(w)
  })

  it('does not mistake an inherited property for a declared secret', async () => {
    const w = world()
    w.grants.grants[0] = { ...GRANT, secret: 'constructor' }
    w.input.manifest = {
      ...FILL_PASSWORD,
      auth: {
        steps: [
          { op: 'goto', url: LOGIN_PAGE },
          { op: 'fill', selector: '#password', value: { secret: 'constructor', field: 'password' } },
        ],
        frameOrigins: [],
      },
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'invalid',
    })
    expectNothingReleased(w)
  })
})

describe('guard: the element exists and is visible', () => {
  it('refuses a missing element', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#nope', value: { secret: 'login', field: 'password' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'element-missing',
    })
    expectNothingReleased(w)
  })

  it('refuses a hidden element, where a typed secret would go unseen', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', form: 'login', visible: false } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-missing' })
    expectNothingReleased(w)
  })

  it('reports a page that throws while inspecting as secret-fill: internal', async () => {
    const w = world()
    w.input.manifest = FILL_PASSWORD
    vi.spyOn(w.page, 'inspect').mockRejectedValue(new Error('frame detached'))
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'internal',
    })
    expectNothingReleased(w)
  })
})

describe('guard: origins', () => {
  it('refuses an element in a third-party frame on the login page', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { ad: EVIL },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'ad', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expectNothingReleased(w)
  })

  it('refuses a frame on an origin the adapter may navigate to but the secret is not for', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { shop: WWW },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'shop', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses an origin the person granted but the manifest did not request', async () => {
    const w = world()
    w.grants.grants[0] = { ...GRANT, origins: [LOGIN, WWW] }
    w.page.site[`${WWW}/login`] = {
      forms: { login: WWW },
      elements: { '#password': { inputType: 'password', form: 'login' } },
    }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: `${WWW}/login` },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses an origin the manifest requested but the person did not grant', async () => {
    const w = world()
    const input = structuredClone(MANIFEST)
    input.secrets = {
      login: { description: 'Shop account', fields: ['username', 'password', 'otp'], origins: [LOGIN, WWW] },
    }
    input.auth = {
      steps: [
        { op: 'goto', url: `${WWW}/login` },
        { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
      ],
    }
    w.input.manifest = parseManifest(input)
    w.page.site[`${WWW}/login`] = {
      forms: { login: WWW },
      elements: { '#password': { inputType: 'password', form: 'login' } },
    }
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses a granted-origin frame embedded in a page of another origin', async () => {
    const w = world()
    w.page.site[`${WWW}/embed`] = {
      frames: { sso: LOGIN },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'sso', form: 'login' } },
    }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: `${WWW}/embed` },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expectNothingReleased(w)
  })

  it('refuses a sandboxed frame with an opaque origin', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { sandboxed: 'null' },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'sandboxed', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses a frame served over plain http from the granted host', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { insecure: 'http://login.shop.test' },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'insecure', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses a frame on a lookalike subdomain of the granted host', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { lookalike: 'https://login.shop.test.evil.test' },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'lookalike', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses a grant whose origins are not bare origins', async () => {
    const w = world()
    w.grants.grants[0] = { ...GRANT, origins: ['https://login.shop.test/login'] }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expectNothingReleased(w)
  })
})

describe('guard: the element suits the field', () => {
  it('refuses to type a password into the email field', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#email', value: { secret: 'login', field: 'password' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'element-unsuitable',
    })
    expectNothingReleased(w)
  })

  it('refuses to type a password into a search box on the login page', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      forms: { search: LOGIN },
      elements: { '#search': { inputType: 'search', form: 'search' } },
    }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#search', value: { secret: 'login', field: 'password' } },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
    expectNothingReleased(w)
  })

  it('refuses to type a username into a password field', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'username' } },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
    expectNothingReleased(w)
  })

  it('refuses to type a username into a search box', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = { elements: { '#search': { inputType: 'search' } } }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#search', value: { secret: 'login', field: 'username' } },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
    expectNothingReleased(w)
  })

  it('refuses a contenteditable div dressed up as a password field', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      forms: { login: LOGIN },
      elements: { '#password': { tagName: 'div', inputType: 'password', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
    expectNothingReleased(w)
  })
})

describe('guard: a password goes only into a form that posts to an allowed origin', () => {
  it('refuses a password field that belongs to no form', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = { elements: { '#password': { inputType: 'password' } } }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'form-action-mismatch',
    })
    expectNothingReleased(w)
  })

  it('refuses a form that posts to another host', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      forms: { login: EVIL },
      elements: { '#password': { inputType: 'password', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'form-action-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses a form that posts to an origin on the navigation allowlist but not granted', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      forms: { login: WWW },
      elements: { '#password': { inputType: 'password', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'form-action-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses a form that posts over plain http', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      forms: { login: 'http://login.shop.test' },
      elements: { '#password': { inputType: 'password', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'form-action-mismatch' })
    expectNothingReleased(w)
  })
})

describe('guard order', () => {
  it('checks the grant before the manifest request', async () => {
    const w = world()
    w.grants.grants.length = 0
    w.input.manifest = { ...FILL_PASSWORD, secrets: {} }
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
  })

  it('checks the manifest request before the element', async () => {
    const w = world()
    w.input.manifest = { ...FILL_PASSWORD, secrets: {} }
    w.page.site[LOGIN_PAGE] = {}
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'invalid' })
  })

  it('checks that the element exists before its origin', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { ad: EVIL },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'ad', form: 'login', visible: false } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-missing' })
  })

  it('checks the origin before the element type', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { ad: EVIL },
      elements: { '#password': { inputType: 'search', frame: 'ad' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
  })

  it('checks the frame origin before the page origin', async () => {
    const w = world()
    w.page.site[`${WWW}/embed`] = {
      frames: { ad: EVIL },
      elements: { '#password': { inputType: 'password', frame: 'ad' } },
    }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: `${WWW}/embed` },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
    ])
    const inspect = vi.spyOn(w.page, 'currentUrl')
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    // The page URL is only read for the fill guard after the frame check passes, so it is not read here.
    expect(inspect).not.toHaveBeenCalled()
  })

  it('checks the element type before the form action', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      forms: { search: EVIL },
      elements: { '#password': { inputType: 'search', form: 'search' } },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
  })

  it('checks every guard before resolving, so a refused fill never wakes the provider', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      forms: { login: EVIL },
      elements: { '#password': { inputType: 'password', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    await runAuthFlow(w.input)
    expect(w.provider.calls).toEqual([])
  })
})

describe('resolving the value', () => {
  it('reports a missing provider as credential: unavailable', async () => {
    const w = world()
    w.input.providers = {}
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'credential',
      errorClass: 'unavailable',
    })
    expect(w.page.typed).toEqual([])
  })

  it('uses the provider the grant names, not any other', async () => {
    const w = world()
    w.grants.grants[0] = { ...GRANT, provider: 'onepassword-cli' }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'credential', errorClass: 'unavailable' })
    expect(w.provider.calls).toEqual([])
  })

  it('reports a missing item as credential: not-found', async () => {
    const w = world()
    delete w.provider.items[ITEM]
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'credential',
      errorClass: 'not-found',
    })
  })

  it('reports a missing field as credential: field-missing', async () => {
    const w = world()
    w.provider.items[ITEM] = { username: CANARY.username }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'credential',
      errorClass: 'field-missing',
    })
  })

  for (const failure of ['locked', 'unavailable'] as ResolveFailure[]) {
    it(`reports a ${failure} provider as credential: ${failure}`, async () => {
      const w = world()
      vi.spyOn(w.provider, 'resolve').mockRejectedValue(new CredentialError(failure))
      w.input.manifest = FILL_PASSWORD
      expect(await runAuthFlow(w.input)).toEqual({
        status: 'failed',
        stage: 'credential',
        errorClass: failure,
      })
    })
  }

  it('does not trust a CredentialError whose failure is outside the vocabulary', async () => {
    const w = world()
    vi.spyOn(w.provider, 'resolve').mockRejectedValue(new CredentialError('hunter2' as ResolveFailure))
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'credential',
      errorClass: 'internal',
    })
  })

  it('reports any other provider error as credential: internal', async () => {
    const w = world()
    vi.spyOn(w.provider, 'resolve').mockRejectedValue(new Error('op: item "Shop" has password hunter2'))
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'credential',
      errorClass: 'internal',
    })
  })

  it('refuses a provider that hands back a plain string', async () => {
    const w = world()
    vi.spyOn(w.provider, 'resolve').mockResolvedValue(CANARY.password as unknown as SecretValue)
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'credential',
      errorClass: 'internal',
    })
    expect(w.page.typed).toEqual([])
  })
})

describe('checking again after resolving', () => {
  it('refuses when the page left the allowlist while the person approved Touch ID', async () => {
    const w = world()
    w.page.site[`${EVIL}/login`] = structuredClone(w.page.site[LOGIN_PAGE]!)
    w.provider.beforeResolve = () => w.page.navigate(`${EVIL}/login`)
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'navigation-escaped',
    })
    expect(w.page.typed).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('refuses when the page bounced through another host and came back while resolving', async () => {
    const w = world()
    w.provider.beforeResolve = () => {
      w.page.navigate(`${EVIL}/x`)
      w.page.navigate(LOGIN_PAGE)
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'navigation-escaped',
    })
    expect(w.page.url).toBe(LOGIN_PAGE)
    expect(w.page.typed).toEqual([])
    expect(w.audit.events.filter((e) => e.type === 'secret-used')).toEqual([])
    expect(w.provider.issued).toHaveLength(1)
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('stops when the page became a block page while resolving', async () => {
    const w = world()
    w.page.site[`${LOGIN}/denied`] = { ...structuredClone(w.page.site[LOGIN_PAGE]!), blocked: true }
    w.provider.beforeResolve = () => w.page.navigate(`${LOGIN}/denied`)
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
    expect(w.page.typed).toEqual([])
    expect(w.audit.events.filter((e) => e.type === 'secret-used')).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('refuses when the page moved to an allowed origin the secret was not granted for', async () => {
    const w = world()
    w.page.site[`${WWW}/login`] = structuredClone(w.page.site[LOGIN_PAGE]!)
    w.provider.beforeResolve = () => w.page.navigate(`${WWW}/login`)
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expect(w.page.typed).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('checks the navigation history before resolving, so an escaped page costs no Touch ID', async () => {
    const w = world()
    vi.spyOn(w.page, 'goto').mockImplementation(async (url) => {
      w.page.navigate(`${EVIL}/x`)
      w.page.navigate(url)
    })
    // Hide the history from the two after-step checks so that only the fill's own check can see it.
    let calls = 0
    const committed = w.page.committedUrls.bind(w.page)
    vi.spyOn(w.page, 'committedUrls').mockImplementation(() => (++calls <= 2 ? [] : committed()))
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'navigation-escaped',
    })
    expect(w.provider.calls).toEqual([])
  })

  it('refuses when the field was swapped for an unsuitable one while resolving', async () => {
    const w = world()
    w.provider.beforeResolve = () => {
      w.page.site[LOGIN_PAGE] = {
        forms: { login: LOGIN },
        elements: { '#password': { inputType: 'text', form: 'login' } },
      }
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
    expect(w.page.typed).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('refuses when the form was repointed at another host while resolving', async () => {
    const w = world()
    w.provider.beforeResolve = () => {
      w.page.site[LOGIN_PAGE] = {
        forms: { login: EVIL },
        elements: { '#password': { inputType: 'password', form: 'login' } },
      }
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'form-action-mismatch' })
    expect(w.page.typed).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })
})

describe('typing and auditing', () => {
  it('audits the use before typing, and types nothing when the audit log fails', async () => {
    const w = world()
    w.audit.failOn = 'secret-used'
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'internal',
    })
    expect(w.page.typed).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('focuses the element before typing', async () => {
    const w = world()
    w.input.manifest = FILL_PASSWORD
    await runAuthFlow(w.input)
    expect(w.page.typed[0]?.selector).toBe('#password')
  })

  it('disposes the value when focusing fails', async () => {
    const w = world()
    vi.spyOn(w.page, 'focus').mockRejectedValue(new Error('detached'))
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'internal',
    })
    expect(w.page.typed).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('disposes the value when typing fails', async () => {
    const w = world()
    vi.spyOn(w.page, 'type').mockRejectedValue(new Error('webContents destroyed'))
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'internal',
    })
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('records the frame origin, the secret and the field, and never the value', async () => {
    const w = world()
    w.input.manifest = FILL_PASSWORD
    await runAuthFlow(w.input)
    const used = w.audit.events.filter((e) => e.type === 'secret-used')
    expect(used).toEqual([
      {
        type: 'secret-used',
        adapterId: 'shop',
        adapterHash: HASH,
        secret: 'login',
        field: 'password',
        origin: LOGIN,
        callId: 'call-1',
      },
    ])
  })

  it('records a frame origin written with a trailing slash in its normal form', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { sso: 'https://login.shop.test/' },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'sso', form: 'login' } },
    }
    w.input.manifest = FILL_PASSWORD
    await runAuthFlow(w.input)
    expect(w.audit.events.find((e) => e.type === 'secret-used')).toMatchObject({ origin: LOGIN })
  })
})

describe('grants for other secrets', () => {
  it('a grant for one secret does not open another', async () => {
    const w = world()
    const bankGrant: Grant = { ...GRANT, secret: 'bank' }
    w.grants.grants[0] = bankGrant
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
  })

  it('refuses a grant whose provider is messages, which names a sender rather than an item', async () => {
    const w = world()
    w.grants.grants[0] = { ...GRANT, provider: 'messages' }
    w.input.providers = { ...w.input.providers, messages: w.provider }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'not-granted',
    })
    expectNothingReleased(w)
  })

  it('refuses to fill the reserved messages secret from a provider, even if a manifest declares it', async () => {
    const w = world()
    w.grants.grants[0] = { ...GRANT, secret: MESSAGES_SECRET }
    const manifest = parseManifest(structuredClone(MANIFEST))
    w.input.manifest = {
      ...manifest,
      secrets: { [MESSAGES_SECRET]: { description: 'Codes', fields: ['password'], origins: [LOGIN] } },
      auth: {
        steps: [
          { op: 'goto', url: LOGIN_PAGE },
          { op: 'fill', selector: '#password', value: { secret: MESSAGES_SECRET, field: 'password' } },
        ],
        frameOrigins: [],
      },
    }
    const find = vi.spyOn(w.grants, 'find')
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'invalid',
    })
    expect(find).not.toHaveBeenCalled()
    expectNothingReleased(w)
  })
})

describe('guard: trusted input can reach the element', () => {
  it('refuses an element in an out-of-process frame on a granted origin, before resolving', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { sso: LOGIN },
      forms: { login: LOGIN },
      elements: {
        '#password': { inputType: 'password', frame: 'sso', form: 'login', inputReachable: false },
      },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'input-unreachable',
    })
    expectNothingReleased(w)
  })

  it('treats a driver that does not say whether input is reachable as unreachable', async () => {
    const w = world()
    const inspect = w.page.inspect.bind(w.page)
    vi.spyOn(w.page, 'inspect').mockImplementation(async (selector) => {
      const element = await inspect(selector)
      if (element === null) return null
      const { inputReachable: _, ...rest } = element
      return rest as unknown as typeof element
    })
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'input-unreachable' })
    expectNothingReleased(w)
  })

  it('reports a foreign frame as an origin mismatch, not as unreachable', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { ad: EVIL },
      forms: { login: LOGIN },
      elements: {
        '#password': { inputType: 'password', frame: 'ad', form: 'login', inputReachable: false },
      },
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expectNothingReleased(w)
  })

  it('refuses when the field moved into an out-of-process frame while resolving', async () => {
    const w = world()
    w.provider.beforeResolve = () => {
      w.page.site[LOGIN_PAGE] = {
        forms: { login: LOGIN },
        elements: { '#password': { inputType: 'password', form: 'login', inputReachable: false } },
      }
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'input-unreachable',
    })
    expect(w.page.typed).toEqual([])
    expect(w.remembered).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })
})

describe('auth frame origins', () => {
  it('never lets a secret into a frame the manifest allows only as a subframe, such as a CAPTCHA', async () => {
    const w = world()
    const captcha = 'https://captcha.example.com'
    const manifest = parseManifest({
      ...structuredClone(MANIFEST),
      auth: { steps: structuredClone(MANIFEST.auth?.steps ?? []), frameOrigins: [captcha] },
    })
    w.input.manifest = { ...manifest, auth: { ...manifest.auth, steps: FILL_PASSWORD.auth.steps } }
    w.grants.grants[0] = { ...GRANT, origins: [LOGIN, captcha] }
    w.page.site[LOGIN_PAGE] = {
      frames: { challenge: captcha },
      forms: { login: captcha },
      elements: { '#password': { inputType: 'password', frame: 'challenge', form: 'login' } },
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expectNothingReleased(w)
  })
})

describe('the driver holds typing to the allowed origins', () => {
  it('passes only origins both granted and requested, not every granted one', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.grants.grants[0] = { ...GRANT, origins: [LOGIN, WWW, EVIL] }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed.map((typed) => typed.allowedOrigins)).toEqual([[LOGIN]])
  })

  it('stops mid-secret when the page navigates to another allowed origin while typing', async () => {
    const w = world()
    w.page.site[`${WWW}/login`] = structuredClone(w.page.site[LOGIN_PAGE]!)
    w.page.beforeKeystroke = (index) => {
      if (index === 3) w.page.navigate(`${WWW}/login`)
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expect(w.page.typed.map((typed) => typed.text)).toEqual([CANARY.password.slice(0, 3)])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('stops mid-secret when the page moves focus into a foreign frame while typing', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      ...structuredClone(w.page.site[LOGIN_PAGE]!),
      frames: { ad: EVIL },
      elements: {
        ...structuredClone(w.page.site[LOGIN_PAGE]!.elements),
        '#ad-input': { inputType: 'text', frame: 'ad' },
      },
    }
    w.page.beforeKeystroke = (index) => {
      if (index === 5) w.page.focused = '#ad-input'
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(w.page.typed.map((typed) => typed.text)).toEqual([CANARY.password.slice(0, 5)])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })
})

// The threat the form-action guard exists for: the secret ending up in a same-origin field it
// would have refused, because the page changed under the typing. The driver types only into the
// element focus() targeted, so none of these get past it.
describe('the driver types only into the element it focused', () => {
  it('stops mid-secret when the page moves focus to a same-origin search box', async () => {
    const w = world()
    w.page.beforeKeystroke = (index) => {
      if (index === 4) w.page.focused = '#search'
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    // The four characters went to the password field; the search box got nothing.
    expect(w.page.typed).toEqual([
      {
        selector: '#password',
        url: LOGIN_PAGE,
        text: CANARY.password.slice(0, 4),
        secret: true,
        delayMs: 40,
        allowedOrigins: [LOGIN],
      },
    ])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('stops mid-secret when the page navigates to another page on the same origin with a #password', async () => {
    const w = world()
    w.page.site[`${LOGIN}/again`] = structuredClone(w.page.site[LOGIN_PAGE]!)
    w.page.beforeKeystroke = (index) => {
      if (index === 2) w.page.navigate(`${LOGIN}/again`)
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(w.page.typed.map((typed) => [typed.url, typed.text])).toEqual([
      [LOGIN_PAGE, CANARY.password.slice(0, 2)],
    ])
  })

  it("stops mid-secret when the field's frame navigates, even within the same origin", async () => {
    const w = world()
    w.page.cookies.add('session')
    w.page.site[LOGIN_PAGE] = {
      frames: { sso: LOGIN },
      forms: { login: LOGIN },
      elements: { '#password': { inputType: 'password', frame: 'sso', form: 'login' } },
    }
    w.page.beforeKeystroke = (index) => {
      if (index === 6) w.page.navigateFrame('sso', LOGIN)
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(w.page.typed.map((typed) => typed.text)).toEqual([CANARY.password.slice(0, 6)])
  })

  it('stops mid-secret when a re-render replaces the field under the same selector', async () => {
    const w = world()
    w.page.beforeKeystroke = (index) => {
      if (index === 3) {
        w.page.site[LOGIN_PAGE] = {
          ...w.page.site[LOGIN_PAGE]!,
          elements: { '#password': { inputType: 'search', form: 'search' } },
        }
      }
    }
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(w.page.typed.map((typed) => typed.text)).toEqual([CANARY.password.slice(0, 3)])
  })

  it('holds a literal to the focused element too', async () => {
    const w = world()
    w.page.beforeKeystroke = (index) => {
      if (index === 1) w.page.focused = '#search'
    }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#email', value: { literal: 'shopper' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'internal',
    })
    expect(w.page.typed.map((typed) => [typed.selector, typed.text])).toEqual([['#email', 's']])
  })
})

// Between the last check and focus, an SPA may re-render. The checks run again on what focus
// landed on, before the secret is remembered, audited or typed.
describe('checking again after focusing', () => {
  /** Focuses as the driver does, then lets `change` alter the page, as a re-render on focus would. */
  function onFocus(w: ReturnType<typeof world>, change: () => void): void {
    const focus = w.page.focus.bind(w.page)
    vi.spyOn(w.page, 'focus').mockImplementation(async (selector) => {
      await focus(selector)
      change()
    })
  }

  it('refuses when the login form was swapped for a same-origin search form as focus landed', async () => {
    const w = world()
    onFocus(w, () => {
      w.page.site[LOGIN_PAGE] = {
        forms: { search: WWW },
        elements: { '#password': { inputType: 'password', form: 'search' } },
      }
    })
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'form-action-mismatch',
    })
    expect(w.page.typed).toEqual([])
    expect(w.remembered).toEqual([])
    expect(w.audit.events.filter((e) => e.type === 'secret-used')).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('refuses when the field became unsuitable as focus landed', async () => {
    const w = world()
    onFocus(w, () => {
      w.page.site[LOGIN_PAGE] = {
        forms: { login: LOGIN },
        elements: { '#password': { inputType: 'text', form: 'login' } },
      }
    })
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
    expect(w.page.typed).toEqual([])
  })

  it('refuses when focusing sent the page off the allowlist', async () => {
    const w = world()
    w.page.site[`${EVIL}/login`] = structuredClone(w.page.site[LOGIN_PAGE]!)
    onFocus(w, () => w.page.navigate(`${EVIL}/login`))
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'navigate', errorClass: 'navigation-escaped' })
    expect(w.page.typed).toEqual([])
    expect(w.remembered).toEqual([])
  })

  it('refuses a Messages code when the field moved into a foreign frame as focus landed', async () => {
    const w = world()
    onFocus(w, () => {
      w.page.site[LOGIN_PAGE] = {
        frames: { ad: EVIL },
        elements: { '#otp': { inputType: 'text', autocomplete: 'one-time-code', frame: 'ad' } },
      }
    })
    w.otpReader.messages.push({ at: w.clock.now, sender: SENDER, body: `Code ${CANARY.sms}` })
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'otp',
        selector: '#otp',
        source: { messages: { sender: SENDER, pattern: '(\\d{6})', maxAgeSeconds: 300 } },
      },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'secret-fill', errorClass: 'origin-mismatch' })
    expect(w.page.typed).toEqual([])
    expect(w.otpReader.issued[0]?.disposed).toBe(true)
  })
})

describe('the runtime keeps a copy for redaction', () => {
  it('hands over an independent copy of every secret typed, which outlives the original', async () => {
    const w = world()
    await runAuthFlow(w.input)
    expect(w.remembered).toHaveLength(2)
    expect(w.provider.issued.every((secret) => secret.disposed)).toBe(true)
    expect(w.remembered.every((secret) => !secret.disposed)).toBe(true)
    expect(w.remembered[0]?.occursIn(`echo ${CANARY.username}`)).toBe(true)
    expect(w.remembered[1]?.occursIn(`echo ${CANARY.password}`)).toBe(true)
    expect(w.remembered.some((secret) => w.provider.issued.includes(secret))).toBe(false)
  })

  it('hands over nothing for a fill refused before resolving', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#search', value: { secret: 'login', field: 'password' } },
    ])
    await runAuthFlow(w.input)
    expect(w.remembered).toEqual([])
  })

  it('types nothing, and audits no use, when the runtime cannot take its copy', async () => {
    const w = world()
    w.input.rememberSecret = () => {
      throw new Error(`redaction set full ${CANARY.password}`)
    }
    w.input.manifest = FILL_PASSWORD
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'failed', stage: 'secret-fill', errorClass: 'internal' })
    expect(JSON.stringify(outcome)).not.toContain(CANARY.password)
    expect(w.page.typed).toEqual([])
    expect(w.audit.events.filter((e) => e.type === 'secret-used')).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })
})
