import {
  CredentialError,
  type Grant,
  parseManifest,
  type ResolveFailure,
  type SecretValue,
} from '@siteadapter/core'
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

describe('a secret fill that passes every guard', () => {
  it('types the password as a SecretValue with the typing delay', async () => {
    const w = world()
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed).toEqual([
      { selector: '#password', url: LOGIN_PAGE, text: CANARY.password, secret: true, delayMs: 40 },
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
    w.page.site[LOGIN_PAGE] = { elements: { '#email': { inputType: 'email' } } }
    w.input.manifest = FILL_USERNAME
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('accepts a login form inside a frame on a granted origin, on a page of that origin', async () => {
    const w = world()
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
  it('refuses when the page navigated to another origin while the person approved Touch ID', async () => {
    const w = world()
    w.page.site[`${EVIL}/login`] = structuredClone(w.page.site[LOGIN_PAGE]!)
    w.provider.beforeResolve = () => w.page.navigate(`${EVIL}/login`)
    w.input.manifest = FILL_PASSWORD
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expect(w.page.typed).toEqual([])
    expect(w.provider.issued[0]?.disposed).toBe(true)
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
})
