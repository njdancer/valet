// The login across two origins: www's /auth/login, Auth0's pages on the auth origin, and www's
// callback. Each test drives the redirects by hand, with one cookie-carrying client per origin,
// so every hop is visible.

import { afterEach, describe, expect, it } from 'vitest'
import type { FakeAccount } from '../src/accounts'
import { CODE_TTL_MS, PENDING_LOGIN_TTL_MS } from '../src/logins'
import {
  type FakeWoolworths,
  type FakeWoolworthsOptions,
  parentDomainOf,
  startFakeWoolworths,
} from '../src/server'
import { Client, type Reply } from './support/client'

const PLAIN: FakeAccount = { username: 'plain@example.test', password: 'plain-password', firstName: 'Pat' }
const SMS: FakeAccount = {
  username: 'sms@example.test',
  password: 'sms-password',
  otpCode: '135790',
  mfa: 'sms',
  firstName: 'Olive',
}
const EMAIL: FakeAccount = {
  username: 'email@example.test',
  password: 'email-password',
  otpCode: '246802',
  mfa: 'email',
}
const TOTP: FakeAccount = {
  username: 'totp@example.test',
  password: 'totp-password',
  otpCode: '864200',
  mfa: 'otp',
}
const BLOCKED: FakeAccount = { username: 'blocked@example.test', password: 'blocked-password', blocked: true }

const sites: FakeWoolworths[] = []
afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()))
})

async function start(options: FakeWoolworthsOptions = {}): Promise<FakeWoolworths> {
  const site = await startFakeWoolworths({ accounts: [PLAIN, SMS, EMAIL, TOTP, BLOCKED], ...options })
  sites.push(site)
  return site
}

/** One browser: a client per origin, www having loaded the homepage. */
interface Browser {
  readonly www: Client
  readonly auth: Client
}

async function browser(site: FakeWoolworths): Promise<Browser> {
  const www = new Client(site.origin)
  await www.visit('/')
  return { www, auth: new Client(site.authOrigin) }
}

function location(reply: Reply): string {
  const value = reply.headers.get('location')
  if (value === null) throw new Error(`expected a redirect, got ${reply.status}`)
  return value
}

const LOGIN = (site: FakeWoolworths, path = '/') =>
  `/auth/login?redirect_uri=${site.origin}/auth/callback&path=${path}`

/** www's /auth/login then Auth0's /authorize. Returns the identifier page's path and query. */
async function beginLogin(site: FakeWoolworths, b: Browser, path = '/'): Promise<string> {
  const authorize = location(await b.www.get(LOGIN(site, path)))
  return location(await b.auth.get(authorize))
}

function stateOf(pathAndQuery: string): string {
  return new URL(pathAndQuery, 'https://x.invalid').searchParams.get('state') ?? ''
}

/** Identifier and password. Returns the password POST's reply. */
async function signIn(
  site: FakeWoolworths,
  b: Browser,
  account: FakeAccount,
  password = account.password,
): Promise<Reply> {
  const identifier = await beginLogin(site, b)
  const state = stateOf(identifier)
  const toPassword = await b.auth.postForm(identifier, {
    state,
    username: account.username,
    action: 'default',
  })
  return b.auth.postForm(location(toPassword), { state, password, action: 'default' })
}

async function shopper(client: Client): Promise<{ IsLoggedIn: boolean; FirstName: string | null }> {
  return JSON.parse((await client.get('/api/ui/v2/bootstrap')).text).ShopperDetails
}

describe('two origins', () => {
  it('serves www and Auth0 on separate ports, recording each one’s requests separately', async () => {
    const site = await start()
    expect(site.origin).toBe(`http://127.0.0.1:${site.port}`)
    expect(site.authOrigin).toBe(`http://127.0.0.1:${site.authPort}`)
    expect(site.authPort).not.toBe(site.port)
    await new Client(site.authOrigin).get('/nowhere')
    expect(site.authRequests.map((r) => r.path)).toEqual(['/nowhere'])
    expect(site.requests).toEqual([])
  })

  it('names the auth origin after the www hostname', async () => {
    const swapped = await start({ hostname: 'www.woolworths.test' })
    expect(swapped.authOrigin).toBe(`http://auth.woolworths.test:${swapped.authPort}`)
    const prefixed = await start({ hostname: 'woolworths.test' })
    expect(prefixed.authOrigin).toBe(`http://auth.woolworths.test:${prefixed.authPort}`)
    const given = await start({ hostname: 'www.woolworths.test', authHostname: 'login.woolworths.test' })
    expect(given.authOrigin).toBe(`http://login.woolworths.test:${given.authPort}`)
  })

  it('closes both servers', async () => {
    const site = await startFakeWoolworths()
    await site.close()
    await expect(fetch(`${site.authOrigin}/authorize`)).rejects.toThrow()
  })

  it('fails to start, leaving nothing listening, when the auth port is taken', async () => {
    const site = await start()
    await expect(startFakeWoolworths({ authPort: site.authPort })).rejects.toThrow()
  })
})

describe('www before the login', () => {
  it('shows only a link at /shop/securelogin, as on the live site', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/shop/securelogin')
    expect(reply.status).toBe(200)
    expect(reply.text).toContain("Oops! You're not logged in")
    expect(reply.text).toContain(
      `href="/auth/login?redirect_uri=${site.origin}/auth/callback&amp;path=/shop/myaccount"`,
    )
    expect(reply.text).not.toContain('type="password"')
  })

  it('sends /auth/login to Auth0 with a fresh opaque state and the callback', async () => {
    const site = await start()
    const b = await browser(site)
    const first = new URL(location(await b.www.get(LOGIN(site))))
    const second = new URL(location(await b.www.get(LOGIN(site))))
    expect(first.origin).toBe(site.authOrigin)
    expect(first.pathname).toBe('/authorize')
    expect(first.searchParams.get('redirect_uri')).toBe(`${site.origin}/auth/callback`)
    expect(first.searchParams.get('response_type')).toBe('code')
    expect(first.searchParams.get('state')).toMatch(/^[\w-]{20,}$/)
    expect(first.searchParams.get('state')).not.toBe(second.searchParams.get('state'))
  })

  it('uses its own callback when /auth/login has no redirect_uri', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/auth/login')
    expect(new URL(location(reply)).searchParams.get('redirect_uri')).toBe(`${site.origin}/auth/callback`)
  })
})

describe('Auth0 /authorize', () => {
  it('starts a Universal Login transaction with its own state, not www’s', async () => {
    const site = await start()
    const b = await browser(site)
    const authorize = location(await b.www.get(LOGIN(site)))
    const identifier = location(await b.auth.get(authorize))
    expect(identifier).toMatch(/^\/u\/login\/identifier\?state=[\w-]+$/)
    expect(stateOf(identifier)).not.toBe(new URL(authorize).searchParams.get('state'))
  })

  it('refuses a callback it does not know', async () => {
    const site = await start()
    const reply = await new Client(site.authOrigin).get(
      '/authorize?state=s&redirect_uri=https%3A%2F%2Fevil.test%2Fauth%2Fcallback',
    )
    expect(reply.status).toBe(400)
    expect(reply.text).toContain('data-error-code="invalid-callback"')
  })

  it('refuses a request with no state', async () => {
    const site = await start()
    const callback = encodeURIComponent(`${site.origin}/auth/callback`)
    const reply = await new Client(site.authOrigin).get(`/authorize?redirect_uri=${callback}`)
    expect(reply.status).toBe(400)
    expect(reply.text).toContain('data-error-code="invalid-request"')
  })
})

describe('the identifier page', () => {
  it('is served for a live transaction', async () => {
    const site = await start()
    const b = await browser(site)
    const page = await b.auth.get(await beginLogin(site, b))
    expect(page.status).toBe(200)
    expect(page.text).toContain('id="username" type="email"')
  })

  it('refuses a made-up or expired transaction', async () => {
    let now = 0
    const site = await start({ now: () => now })
    const b = await browser(site)
    expect((await b.auth.get('/u/login/identifier?state=made-up')).status).toBe(400)
    const identifier = await beginLogin(site, b)
    now += 30 * 60_000
    const expired = await b.auth.get(identifier)
    expect(expired.status).toBe(400)
    expect(expired.text).toContain('data-error-code="invalid-state"')
  })

  it('moves on to the password page for any username, so it does not reveal which exist', async () => {
    const site = await start()
    const b = await browser(site)
    const identifier = await beginLogin(site, b)
    const reply = await b.auth.postForm(identifier, {
      state: stateOf(identifier),
      username: 'nobody@example.test',
      action: 'default',
    })
    expect(reply.status).toBe(302)
    expect(location(reply)).toBe(`/u/login/password?state=${stateOf(identifier)}`)
  })

  it('asks again for an empty username', async () => {
    const site = await start()
    const b = await browser(site)
    const identifier = await beginLogin(site, b)
    const reply = await b.auth.postForm(identifier, { username: '', action: 'default' })
    expect(reply.status).toBe(400)
    expect(reply.text).toContain('data-error-code="invalid-username"')
  })

  it('does not offer the passkey or Everyday sign-in here', async () => {
    const site = await start()
    const b = await browser(site)
    const identifier = await beginLogin(site, b)
    expect((await b.auth.postForm(identifier, { action: 'passkey' })).status).toBe(400)
    expect((await b.auth.postForm(identifier, { connection: 'everyday' })).status).toBe(400)
  })
})

describe('the password page', () => {
  it('sends a browser that skipped the identifier back to it', async () => {
    const site = await start()
    const b = await browser(site)
    const state = stateOf(await beginLogin(site, b))
    for (const reply of [
      await b.auth.get(`/u/login/password?state=${state}`),
      await b.auth.postForm(`/u/login/password?state=${state}`, { password: PLAIN.password }),
    ]) {
      expect(location(reply)).toBe(`/u/login/identifier?state=${state}`)
    }
  })

  it('re-renders with Auth0’s wrong-credentials error, the same for an unknown user', async () => {
    const site = await start()
    const wrong = await signIn(site, await browser(site), PLAIN, 'wrong')
    const unknown = await signIn(site, await browser(site), {
      username: 'nobody@example.test',
      password: 'x',
    })
    for (const reply of [wrong, unknown]) {
      expect(reply.status).toBe(400)
      expect(reply.text).toContain('id="error-element-password"')
      expect(reply.text).toContain('data-error-code="wrong-credentials"')
      expect(reply.setCookies).toEqual([])
    }
  })

  it('refuses the right password while passwords are rejected, and takes it again after', async () => {
    const site = await start()
    site.rejectPasswords(true)
    const refused = await signIn(site, await browser(site), PLAIN)
    expect(refused.status).toBe(400)
    expect(refused.text).toContain('data-error-code="wrong-credentials"')
    site.rejectPasswords(false)
    expect((await signIn(site, await browser(site), PLAIN)).status).not.toBe(400)
  })

  it('matches credentials exactly, not by case or prefix', async () => {
    const site = await start()
    for (const password of [
      PLAIN.password.toUpperCase(),
      `${PLAIN.password} `,
      PLAIN.password.slice(0, -1),
    ]) {
      expect((await signIn(site, await browser(site), PLAIN, password)).status).toBe(400)
    }
    const upper = { ...PLAIN, username: PLAIN.username.toUpperCase() }
    expect((await signIn(site, await browser(site), upper)).status).toBe(400)
  })

  it('refuses a blocked account even with the right password, with its own error code', async () => {
    const site = await start()
    const reply = await signIn(site, await browser(site), BLOCKED)
    expect(reply.status).toBe(400)
    expect(reply.text).toContain('data-error-code="user-blocked"')
  })

  it('does not echo the submitted credentials into any page', async () => {
    const site = await start()
    const b = await browser(site)
    const canary = { username: 'canary-user@example.test', password: 'canary-pw' }
    const reply = await signIn(site, b, canary)
    const page = await b.auth.get(
      `/u/login/password?state=${stateOf(location(await b.www.get(LOGIN(site))))}`,
    )
    for (const text of [reply.text, page.text]) {
      expect(text).not.toContain('canary-user')
      expect(text).not.toContain('canary-pw')
    }
  })
})

describe('a login without MFA', () => {
  it('signs in to Auth0 and sends the browser to www’s callback with a code and www’s state', async () => {
    const site = await start()
    const b = await browser(site)
    const authorize = new URL(location(await b.www.get(LOGIN(site))))
    const identifier = location(await b.auth.get(authorize.toString()))
    const state = stateOf(identifier)
    await b.auth.postForm(identifier, { state, username: PLAIN.username, action: 'default' })
    const reply = await b.auth.postForm(`/u/login/password?state=${state}`, {
      state,
      password: PLAIN.password,
      action: 'default',
    })
    expect(reply.status).toBe(302)
    const callback = new URL(location(reply))
    expect(`${callback.origin}${callback.pathname}`).toBe(`${site.origin}/auth/callback`)
    expect(callback.searchParams.get('state')).toBe(authorize.searchParams.get('state'))
    expect(callback.searchParams.get('code')).toMatch(/^[\w-]{20,}$/)
    expect(reply.setCookies).toHaveLength(1)
    expect(reply.setCookies[0]).toMatch(/^auth0=[\w-]+; Path=\/; SameSite=Lax; HttpOnly$/)
  })

  it('logs www in at the callback, with a new session token, and goes to the login’s path', async () => {
    const site = await start()
    const b = await browser(site)
    const before = b.www.cookies.get('wow-auth-token')
    const authorize = location(await b.www.get(LOGIN(site, '/shop/myaccount')))
    const identifier = location(await b.auth.get(authorize))
    const state = stateOf(identifier)
    await b.auth.postForm(identifier, { state, username: PLAIN.username, action: 'default' })
    const toCallback = await b.auth.postForm(`/u/login/password?state=${state}`, {
      password: PLAIN.password,
      action: 'default',
    })
    expect(await shopper(b.www)).toEqual({ IsLoggedIn: false, FirstName: null })
    const reply = await b.www.get(location(toCallback))
    expect(reply.status).toBe(302)
    expect(location(reply)).toBe('/shop/myaccount')
    expect(b.www.cookies.get('wow-auth-token')).not.toBe(before)
    expect(await shopper(b.www)).toEqual({ IsLoggedIn: true, FirstName: 'Pat' })
    expect((await b.www.get('/shop/myaccount')).text).toContain('Hi Pat')
  })

  it('never sets a www cookie from the auth origin, or an auth cookie from www', async () => {
    const site = await start()
    const b = await browser(site)
    await b.www.get(location(await signIn(site, b, PLAIN)))
    expect([...b.auth.cookies.keys()]).toEqual(['auth0'])
    expect([...b.www.cookies.keys()].sort()).toEqual(['_abck', 'wow-auth-token'])
  })

  it('does not log in the pre-login token, so a planted token cannot be upgraded', async () => {
    const site = await start()
    const victim = await browser(site)
    const planted = victim.www.cookies.get('wow-auth-token') ?? ''
    await victim.www.get(location(await signIn(site, victim, PLAIN)))
    const attacker = await browser(site)
    attacker.www.cookies.set('wow-auth-token', planted)
    expect(await shopper(attacker.www)).toEqual({ IsLoggedIn: false, FirstName: null })
  })
})

describe('www’s callback', () => {
  it('spends the code: a replay is refused', async () => {
    const site = await start()
    const b = await browser(site)
    const callback = location(await signIn(site, b, PLAIN))
    await b.www.get(callback)
    await b.www.get('/auth/logout')
    const replay = await b.www.get(callback)
    expect(replay.status).toBe(403)
    expect(replay.text).toContain('id="login-Failed"')
    expect(await shopper(b.www)).toEqual({ IsLoggedIn: false, FirstName: null })
  })

  it('refuses a code delivered to another browser, so a login cannot be injected', async () => {
    const site = await start()
    const attacker = await browser(site)
    const callback = location(await signIn(site, attacker, PLAIN))
    const victim = await browser(site)
    expect((await victim.www.get(callback)).status).toBe(403)
    expect((await shopper(victim.www)).IsLoggedIn).toBe(false)
    // Spent by the refused attempt, so the attacker can't use it either.
    expect((await attacker.www.get(callback)).status).toBe(403)
  })

  it('refuses a code issued for one login with the state of another', async () => {
    const site = await start()
    const b = await browser(site)
    const first = new URL(location(await signIn(site, b, PLAIN)))
    // A second login while Auth0's session lives goes straight to the callback with its own code.
    const second = new URL(location(await b.auth.get(location(await b.www.get(LOGIN(site))))))
    const mixed = `/auth/callback?code=${first.searchParams.get('code')}&state=${second.searchParams.get('state')}`
    expect((await b.www.get(mixed)).status).toBe(403)
    expect((await shopper(b.www)).IsLoggedIn).toBe(false)
  })

  it('refuses a made-up code or state, or none', async () => {
    const site = await start()
    const b = await browser(site)
    const real = new URL(location(await signIn(site, b, PLAIN)))
    expect(
      (await b.www.get(`/auth/callback?code=made-up&state=${real.searchParams.get('state')}`)).status,
    ).toBe(403)
    expect((await b.www.get('/auth/callback')).status).toBe(403)
    expect((await shopper(b.www)).IsLoggedIn).toBe(false)
  })

  it(`refuses a code older than ${CODE_TTL_MS} ms`, async () => {
    let now = 0
    const site = await start({ now: () => now })
    const b = await browser(site)
    const callback = location(await signIn(site, b, PLAIN))
    now += CODE_TTL_MS
    expect((await b.www.get(callback)).status).toBe(403)
  })

  it('refuses a login started too long ago, even with a fresh code', async () => {
    let now = 0
    const site = await start({ now: () => now })
    const b = await browser(site)
    const identifier = await beginLogin(site, b)
    now += PENDING_LOGIN_TTL_MS
    const state = stateOf(identifier)
    await b.auth.postForm(identifier, { username: PLAIN.username, action: 'default' })
    const toCallback = await b.auth.postForm(`/u/login/password?state=${state}`, {
      password: PLAIN.password,
      action: 'default',
    })
    expect((await b.www.get(location(toCallback))).status).toBe(403)
  })

  it('accepts a code just inside its lifetime', async () => {
    let now = 0
    const site = await start({ now: () => now })
    const b = await browser(site)
    const callback = location(await signIn(site, b, PLAIN))
    now += CODE_TTL_MS - 1
    expect((await b.www.get(callback)).status).toBe(302)
  })

  it('only ever redirects within www, whatever path the login carried', async () => {
    const site = await start()
    for (const path of ['//evil.test/x', '/\\evil.test', 'https://evil.test/', 'evil']) {
      const b = await browser(site)
      const authorize = location(await b.www.get(`/auth/login?path=${encodeURIComponent(path)}`))
      const identifier = location(await b.auth.get(authorize))
      const state = stateOf(identifier)
      await b.auth.postForm(identifier, { username: PLAIN.username, action: 'default' })
      const toCallback = await b.auth.postForm(`/u/login/password?state=${state}`, {
        password: PLAIN.password,
        action: 'default',
      })
      expect(location(await b.www.get(location(toCallback)))).toBe('/')
    }
  })
})

describe('silent re-login', () => {
  it('goes straight back to the callback while the Auth0 session lives, with no page in between', async () => {
    const site = await start()
    const b = await browser(site)
    await b.www.get(location(await signIn(site, b, PLAIN)))
    site.expireSessions()
    expect((await shopper(b.www)).IsLoggedIn).toBe(false)
    const pagesBefore = site.authRequests.filter((r) => r.path.startsWith('/u/')).length

    const authorize = location(await b.www.get(LOGIN(site)))
    const reply = await b.auth.get(authorize)
    expect(reply.status).toBe(302)
    expect(location(reply).startsWith(`${site.origin}/auth/callback?code=`)).toBe(true)
    await b.www.get(location(reply))
    expect((await shopper(b.www)).IsLoggedIn).toBe(true)
    expect(site.authRequests.filter((r) => r.path.startsWith('/u/')).length).toBe(pagesBefore)
  })

  it('asks for the identifier again once Auth0’s sessions have ended', async () => {
    const site = await start()
    const b = await browser(site)
    await b.www.get(location(await signIn(site, b, PLAIN)))
    site.expireSessions()
    site.expireAuthSessions()
    expect(await beginLogin(site, b)).toMatch(/^\/u\/login\/identifier\?state=/)
  })

  it('does not take a made-up Auth0 session cookie', async () => {
    const site = await start()
    const b = await browser(site)
    b.auth.cookies.set('auth0', 'made-up')
    expect(await beginLogin(site, b)).toMatch(/^\/u\/login\/identifier/)
  })
})

describe('MFA', () => {
  it('sends an SMS account to the SMS challenge after the right password, not yet logged in', async () => {
    let now = 5_000
    const site = await start({ now: () => now })
    const b = await browser(site)
    const reply = await signIn(site, b, SMS)
    expect(reply.status).toBe(302)
    expect(location(reply)).toMatch(/^\/u\/mfa-sms-challenge\?state=/)
    expect(reply.setCookies).toEqual([])
    expect(site.outbox).toEqual([
      {
        channel: 'sms',
        username: SMS.username,
        text: 'Your Woolworths verification code is 135790. It expires in 5 minutes.',
        at: 5_000,
      },
    ])
    now += 1
    const page = await b.auth.get(location(reply))
    expect(page.status).toBe(200)
    expect(page.text).toContain('autocomplete="one-time-code"')
  })

  it('picks the challenge page by the account’s channel, and texts or emails only for SMS and email', async () => {
    const site = await start()
    expect(location(await signIn(site, await browser(site), EMAIL))).toMatch(/^\/u\/mfa-email-challenge\?/)
    expect(location(await signIn(site, await browser(site), TOTP))).toMatch(/^\/u\/mfa-otp-challenge\?/)
    expect(site.outbox.map((m) => [m.channel, m.username])).toEqual([['email', EMAIL.username]])
  })

  it('defaults to SMS for an account with a code but no channel', async () => {
    const site = await start({ accounts: [{ username: 'd@example.test', password: 'p', otpCode: '111111' }] })
    const reply = await signIn(site, await browser(site), { username: 'd@example.test', password: 'p' })
    expect(location(reply)).toMatch(/^\/u\/mfa-sms-challenge\?/)
  })

  it('refuses another channel’s challenge page, and the challenge before the password', async () => {
    const site = await start()
    const b = await browser(site)
    const challenge = location(await signIn(site, b, SMS))
    const state = stateOf(challenge)
    expect((await b.auth.get(`/u/mfa-otp-challenge?state=${state}`)).status).toBe(400)
    const fresh = await browser(site)
    const early = stateOf(await beginLogin(site, fresh))
    expect(
      (
        await fresh.auth.postForm(`/u/mfa-sms-challenge?state=${early}`, {
          code: SMS.otpCode ?? '',
          action: 'default',
        })
      ).status,
    ).toBe(400)
  })

  it('logs in with the right code', async () => {
    const site = await start()
    const b = await browser(site)
    const challenge = location(await signIn(site, b, SMS))
    const reply = await b.auth.postForm(challenge, { code: SMS.otpCode ?? '', action: 'default' })
    expect(location(reply).startsWith(`${site.origin}/auth/callback?code=`)).toBe(true)
    await b.www.get(location(reply))
    expect(await shopper(b.www)).toEqual({ IsLoggedIn: true, FirstName: 'Olive' })
  })

  it('re-renders with an error for a wrong code, and gives up after three', async () => {
    const site = await start()
    const b = await browser(site)
    const challenge = location(await signIn(site, b, TOTP))
    const first = await b.auth.postForm(challenge, { code: '000000', action: 'default' })
    expect(first.status).toBe(400)
    expect(first.text).toContain('data-error-code="invalid-code"')
    await b.auth.postForm(challenge, { code: '000001', action: 'default' })
    const third = await b.auth.postForm(challenge, { code: '000002', action: 'default' })
    expect(third.text).toContain('data-error-code="too-many-failures"')
    const late = await b.auth.postForm(challenge, { code: TOTP.otpCode ?? '', action: 'default' })
    expect(late.status).toBe(400)
    expect(late.text).toContain('data-error-code="invalid-state"')
  })

  it('ties the challenge to its transaction, not to whoever has the code', async () => {
    const site = await start()
    await signIn(site, await browser(site), SMS)
    const other = await browser(site)
    const otherState = stateOf(await beginLogin(site, other))
    const reply = await other.auth.postForm(`/u/mfa-sms-challenge?state=${otherState}`, {
      code: SMS.otpCode ?? '',
      action: 'default',
    })
    expect(reply.status).toBe(400)
  })

  it('resends the code on request, and offers no other method', async () => {
    const site = await start()
    const b = await browser(site)
    const challenge = location(await signIn(site, b, SMS))
    expect((await b.auth.postForm(challenge, { action: 'resend-code' })).status).toBe(200)
    expect(site.outbox).toHaveLength(2)
    expect((await b.auth.postForm(challenge, { action: 'pick-authenticator' })).status).toBe(400)
    expect(
      (await b.auth.postForm(location(await signIn(site, b, TOTP)), { action: 'resend-code' })).status,
    ).toBe(400)
  })

  it('does not remember the device unless asked', async () => {
    const site = await start()
    const b = await browser(site)
    const reply = await b.auth.postForm(location(await signIn(site, b, SMS)), {
      code: SMS.otpCode ?? '',
      action: 'default',
    })
    expect(reply.setCookies.some((line) => line.startsWith('auth0-mf='))).toBe(false)
  })

  it('remembers the device for 30 days on the auth origin, and skips the code next time', async () => {
    const site = await start()
    const b = await browser(site)
    const reply = await b.auth.postForm(location(await signIn(site, b, SMS)), {
      code: SMS.otpCode ?? '',
      rememberBrowser: 'true',
      action: 'default',
    })
    expect(reply.setCookies.find((line) => line.startsWith('auth0-mf='))).toMatch(
      /; Max-Age=2592000; HttpOnly$/,
    )
    site.expireSessions()
    site.expireAuthSessions()
    const again = await signIn(site, b, SMS)
    expect(location(again).startsWith(`${site.origin}/auth/callback?`)).toBe(true)
    expect(site.outbox).toHaveLength(1)
  })

  it('still asks for the password on a remembered device', async () => {
    const site = await start()
    const b = await browser(site)
    await b.auth.postForm(location(await signIn(site, b, SMS)), {
      code: SMS.otpCode ?? '',
      rememberBrowser: 'true',
      action: 'default',
    })
    site.expireAuthSessions()
    expect((await signIn(site, b, SMS, 'wrong')).status).toBe(400)
  })

  it('does not skip the code with a forged device cookie, or one remembered for another account', async () => {
    const site = await start()
    const forged = await browser(site)
    forged.auth.cookies.set('auth0-mf', 'forged')
    expect(location(await signIn(site, forged, SMS))).toMatch(/^\/u\/mfa-sms-challenge/)

    const b = await browser(site)
    await b.auth.postForm(location(await signIn(site, b, TOTP)), {
      code: TOTP.otpCode ?? '',
      rememberBrowser: 'true',
      action: 'default',
    })
    site.expireAuthSessions()
    expect(location(await signIn(site, b, SMS))).toMatch(/^\/u\/mfa-sms-challenge/)
  })
})

describe('the CAPTCHA', () => {
  it('shows on the identifier and password pages and refuses every submit until turned off', async () => {
    const site = await start({ captcha: true })
    const b = await browser(site)
    const identifier = await beginLogin(site, b)
    expect((await b.auth.get(identifier)).text).toContain('ulp-captcha-container')
    const refused = await b.auth.postForm(identifier, { username: PLAIN.username, action: 'default' })
    expect(refused.status).toBe(400)
    expect(refused.text).toContain('data-error-code="invalid-captcha"')

    site.setCaptcha(false)
    const state = stateOf(identifier)
    await b.auth.postForm(identifier, { username: PLAIN.username, action: 'default' })
    site.setCaptcha(true)
    expect((await b.auth.get(`/u/login/password?state=${state}`)).text).toContain('ulp-captcha-container')
    const password = await b.auth.postForm(`/u/login/password?state=${state}`, {
      password: PLAIN.password,
      action: 'default',
    })
    expect(password.text).toContain('data-error-code="invalid-captcha"')
    expect(password.setCookies).toEqual([])
  })
})

describe('hostile variants', () => {
  it('can make the password form post somewhere else, for the form-action guard', async () => {
    const site = await start({ hostile: { loginFormAction: 'https://evil.test:4443/steal' } })
    const b = await browser(site)
    const identifier = await beginLogin(site, b)
    const toPassword = await b.auth.postForm(identifier, { username: PLAIN.username, action: 'default' })
    const page = await b.auth.get(location(toPassword))
    expect(page.text).toContain('data-form-primary="true" action="https://evil.test:4443/steal"')
    // The identifier form is untouched, and the real endpoint still works, so a test can tell
    // "blocked" from "broken".
    expect((await b.auth.get(identifier)).text).toContain(
      `action="/u/login/identifier?state=${stateOf(identifier)}"`,
    )
    const reply = await b.auth.postForm(location(toPassword), { password: PLAIN.password, action: 'default' })
    expect(reply.status).toBe(302)
  })

  it('keeps the hostile action when re-rendering after a wrong password', async () => {
    const site = await start({ hostile: { loginFormAction: 'https://evil.test/' } })
    const reply = await signIn(site, await browser(site), PLAIN, 'wrong')
    expect(reply.text).toContain('action="https://evil.test/"')
  })

  it('can accept any redirect_uri and send the code there, for the navigation guard', async () => {
    const site = await start({ hostile: { openRedirectAfterLogin: true } })
    const b = await browser(site)
    const authorize = location(await b.www.get('/auth/login?redirect_uri=https://evil.test/landed&path=/'))
    const identifier = location(await b.auth.get(authorize))
    const state = stateOf(identifier)
    await b.auth.postForm(identifier, { username: PLAIN.username, action: 'default' })
    const reply = await b.auth.postForm(`/u/login/password?state=${state}`, {
      password: PLAIN.password,
      action: 'default',
    })
    expect(location(reply)).toMatch(/^https:\/\/evil\.test\/landed\?code=[\w-]+&state=[\w-]+$/)
  })

  it('can redirect off-site from www’s callback via the login’s path', async () => {
    const site = await start({ hostile: { openRedirectAfterLogin: true } })
    const b = await browser(site)
    const authorize = location(
      await b.www.get(`/auth/login?path=${encodeURIComponent('https://evil.test/landed')}`),
    )
    const identifier = location(await b.auth.get(authorize))
    const state = stateOf(identifier)
    await b.auth.postForm(identifier, { username: PLAIN.username, action: 'default' })
    const toCallback = await b.auth.postForm(`/u/login/password?state=${state}`, {
      password: PLAIN.password,
      action: 'default',
    })
    expect(location(await b.www.get(location(toCallback)))).toBe('https://evil.test/landed')
  })

  it('still refuses a non-http redirect_uri with the open-redirect variant on', async () => {
    const site = await start({ hostile: { openRedirectAfterLogin: true } })
    const reply = await new Client(site.authOrigin).get(
      '/authorize?state=s&redirect_uri=javascript%3Aalert(1)',
    )
    expect(reply.status).toBe(400)
  })

  it('can put the identifier and password forms in a cross-origin iframe, for the frame-origin guard', async () => {
    const site = await start({ hostile: { loginInFrame: 'login.evil.test' } })
    const b = await browser(site)
    const identifier = await beginLogin(site, b)
    const state = stateOf(identifier)
    const page = await b.auth.get(identifier)
    expect(page.text).not.toContain('id="username"')
    expect(page.text).toContain(
      `<iframe id="loginFrame" title="Log in" src="http://login.evil.test:${site.authPort}/u/login/identifier/frame?state=${state}"></iframe>`,
    )
    // The same server answers for the frame, so the framed form is a working one.
    const frame = await b.auth.get(`/u/login/identifier/frame?state=${state}`)
    expect(frame.text).toContain('id="username" type="email"')
    await b.auth.postForm(identifier, { username: PLAIN.username, action: 'default' })
    const password = await b.auth.get(`/u/login/password?state=${state}`)
    expect(password.text).toContain(
      `src="http://login.evil.test:${site.authPort}/u/login/password/frame?state=${state}"`,
    )
    expect((await b.auth.get(`/u/login/password/frame?state=${state}`)).text).toContain(
      'id="password" type="password"',
    )
  })

  it('serves no frame paths unless the variant is on', async () => {
    const site = await start()
    const b = await browser(site)
    const state = stateOf(await beginLogin(site, b))
    expect((await b.auth.get(`/u/login/identifier/frame?state=${state}`)).status).toBe(404)
  })

  it('can give the password and code fields the wrong type, for the element-type guard', async () => {
    const site = await start({ hostile: { passwordInputType: 'text', codeInputType: 'search' } })
    const b = await browser(site)
    const identifier = await beginLogin(site, b)
    await b.auth.postForm(identifier, { username: SMS.username, action: 'default' })
    const state = stateOf(identifier)
    expect((await b.auth.get(`/u/login/password?state=${state}`)).text).toContain('id="password" type="text"')
    const challenge = await b.auth.postForm(`/u/login/password?state=${state}`, {
      password: SMS.password,
      action: 'default',
    })
    expect((await b.auth.get(location(challenge))).text).toContain('id="code" type="search"')
  })
})

describe('after the login', () => {
  it('redirects /shop/securelogin to the account page, and the account page back when anonymous', async () => {
    const site = await start()
    const b = await browser(site)
    await b.www.get(location(await signIn(site, b, PLAIN)))
    expect(location(await b.www.get('/shop/securelogin'))).toBe('/shop/myaccount')
    expect(location(await new Client(site.origin).get('/shop/myaccount'))).toBe('/shop/securelogin')
  })

  it("shares the account's trolley across every session logged in to it", async () => {
    const site = await start()
    const laptop = await browser(site)
    const phone = await browser(site)
    for (const b of [laptop, phone]) await b.www.get(location(await signIn(site, b, PLAIN)))
    await laptop.www.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 900601, quantity: 2 }] })
    expect(JSON.parse((await phone.www.get('/apis/ui/Trolley')).text).TotalTrolleyItemQuantity).toBe(2)
    expect(site.trolleyFor(PLAIN.username)).toEqual([{ stockcode: 900601, quantity: 2 }])
    expect(site.trolleyFor(SMS.username)).toEqual([])
    expect(() => site.trolleyFor('nobody@example.test')).toThrow('no such fake account')
  })

  it('does not pick up what was added before logging in', async () => {
    const site = await start()
    const b = await browser(site)
    await b.www.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 88436, quantity: 1 }] })
    await b.www.get(location(await signIn(site, b, PLAIN)))
    expect(site.trolleyFor(PLAIN.username)).toEqual([])
  })

  it('starts a login without the store the anonymous session chose', async () => {
    const site = await start()
    const b = await browser(site)
    await b.www.postJson('/api/v3/ui/fulfilment', { addressId: 9001201, fulfilmentMethod: 'Pickup' })
    expect(site.pickupAddresses(null)).toEqual([9001201])
    await b.www.get(location(await signIn(site, b, PLAIN)))
    expect(site.pickupAddresses(PLAIN.username)).toEqual([null])
    await b.www.postJson('/api/v3/ui/fulfilment', { addressId: 9001245, fulfilmentMethod: 'Pickup' })
    expect(site.pickupAddresses(PLAIN.username)).toEqual([9001245])
  })

  it('logs out to a fresh anonymous session; the old token is dead', async () => {
    const site = await start()
    const b = await browser(site)
    await b.www.get(location(await signIn(site, b, PLAIN)))
    const loggedInToken = b.www.cookies.get('wow-auth-token') ?? ''
    expect(location(await b.www.get('/auth/logout'))).toBe('/')
    expect((await shopper(b.www)).IsLoggedIn).toBe(false)
    const replay = await browser(site)
    replay.www.cookies.set('wow-auth-token', loggedInToken)
    expect((await shopper(replay.www)).IsLoggedIn).toBe(false)
  })

  it('greets an account with no first name as Shopper', async () => {
    const site = await start({ accounts: [{ username: 'a@example.test', password: 'p' }] })
    const b = await browser(site)
    await b.www.get(location(await signIn(site, b, { username: 'a@example.test', password: 'p' })))
    expect(await shopper(b.www)).toEqual({ IsLoggedIn: true, FirstName: 'Shopper' })
  })
})

describe('the auth origin itself', () => {
  it('answers unknown paths with a 404 error page', async () => {
    const site = await start()
    const reply = await new Client(site.authOrigin).get('/u/login/elsewhere')
    expect(reply.status).toBe(404)
  })

  it('is not behind the Akamai simulation', async () => {
    const site = await start()
    site.blockAll(true)
    const auth = new Client(site.authOrigin)
    expect((await auth.get('/u/login/identifier?state=x')).status).toBe(400)
    expect((await auth.get('/u/login/identifier?state=x')).text).not.toContain('Access Denied')
  })

  it('refuses a body over the size limit but still records the request', async () => {
    const site = await start()
    const reply = await new Client(site.authOrigin).request('POST', '/u/login/password', {
      raw: 'x'.repeat(1_000_001),
    })
    expect(reply.status).toBe(413)
    expect(site.authRequests[0]?.body).toHaveLength(1_000_000)
  })
})

describe('the CAPTCHA’s frame', () => {
  it('loads the challenge from the provider’s own origin, which the auth server answers for', async () => {
    const site = await start({ captcha: true })
    expect(site.captchaFrameOrigin).toBe(`http://challenges.captcha.test:${site.authPort}`)
    const b = await browser(site)
    const page = await b.auth.get(await beginLogin(site, b))
    expect(page.text).toContain(`src="${site.captchaFrameOrigin}/captcha/frame"`)
    const frame = await new Client(site.authOrigin).get('/captcha/frame')
    expect(frame.status).toBe(200)
    expect(frame.text).toContain('id="challenge-checkbox"')
  })

  it('takes another frame hostname', async () => {
    const site = await start({ captcha: true, captchaFrameHostname: 'frames.example.test' })
    expect(site.captchaFrameOrigin).toBe(`http://frames.example.test:${site.authPort}`)
  })
})

describe('cookies on the parent domain', () => {
  it('has Akamai set one for the whole domain on a new www visitor, once', async () => {
    const site = await start({ hostname: 'www.woolworths.test' })
    const www = new Client(`http://127.0.0.1:${site.port}`)
    const first = await www.get('/')
    expect(first.setCookies.find((line) => line.startsWith('bm_sz='))).toMatch(
      /^bm_sz=[^;]+; Path=\/; SameSite=Lax; Domain=woolworths\.test$/,
    )
    www.cookies.delete('wow-auth-token')
    expect((await www.get('/')).setCookies.some((line) => line.startsWith('bm_sz='))).toBe(false)
  })

  it('has the login pages set an analytics cookie for the whole domain, once', async () => {
    const site = await start({ hostname: 'www.woolworths.test' })
    const auth = new Client(`http://127.0.0.1:${site.authPort}`)
    const first = await auth.get('/authorize?state=s&redirect_uri=x')
    expect(first.setCookies).toEqual([
      expect.stringMatching(/^_ga=GA1\.2\.[\w-]+; Path=\/; SameSite=Lax; Domain=woolworths\.test$/),
    ])
    expect((await auth.get('/authorize?state=s&redirect_uri=x')).setCookies).toEqual([])
  })

  it('sets neither without a www hostname to share', async () => {
    expect(parentDomainOf(undefined)).toBeNull()
    expect(parentDomainOf('woolworths.test')).toBeNull()
    expect(parentDomainOf('www.woolworths.test')).toBe('woolworths.test')
    const site = await start()
    expect((await new Client(site.authOrigin).get('/authorize?state=s&redirect_uri=x')).setCookies).toEqual(
      [],
    )
  })
})

describe('an expired login', () => {
  it('gets 401 from the cart API, setting nothing, while other calls see a new anonymous visitor', async () => {
    const site = await start()
    const b = await browser(site)
    await b.www.get(location(await signIn(site, b, PLAIN)))
    site.expireSessions()
    const read = await b.www.get('/apis/ui/Trolley')
    expect(read.status).toBe(401)
    expect(read.setCookies).toEqual([])
    const write = await b.www.postJson('/api/v3/ui/trolley/update', {
      items: [{ stockcode: 900601, quantity: 1 }],
    })
    expect(write.status).toBe(401)
    expect(site.trolleyFor(PLAIN.username)).toEqual([])
    expect((await shopper(b.www)).IsLoggedIn).toBe(false)
    // The bootstrap call replaced the expired token, so the cart now answers for the new visitor.
    expect((await b.www.get('/apis/ui/Trolley')).status).toBe(200)
  })

  it('does not refuse an anonymous visitor the site never knew', async () => {
    const site = await start()
    const b = await browser(site)
    b.www.cookies.set('wow-auth-token', 'never-issued')
    expect((await b.www.get('/apis/ui/Trolley')).status).toBe(200)
  })
})

describe('the site redirecting on its own', () => {
  it('sends the browser from Auth0 to another host with the code, in place of the callback', async () => {
    const site = await start({
      hostile: { redirectAfterLogin: { from: 'auth', to: 'https://evil.test/landed' } },
    })
    const b = await browser(site)
    const reply = await signIn(site, b, PLAIN)
    expect(location(reply)).toMatch(/^https:\/\/evil\.test\/landed\?code=[\w-]+&state=[\w-]+$/)
    // The silent re-login goes there too.
    const again = await b.auth.get(location(await b.www.get(LOGIN(site))))
    expect(location(again)).toMatch(/^https:\/\/evil\.test\/landed\?code=/)
  })

  it('sends the browser from www’s callback to another host once the session is set', async () => {
    const site = await start({
      hostile: { redirectAfterLogin: { from: 'callback', to: 'https://evil.test/landed' } },
    })
    const b = await browser(site)
    const callback = await b.www.get(location(await signIn(site, b, PLAIN)))
    expect(location(callback)).toBe('https://evil.test/landed')
    expect((await shopper(b.www)).IsLoggedIn).toBe(true)
  })

  it('redirects any request for one www path, API calls included, whatever the case', async () => {
    const site = await start({
      hostile: { wwwRedirect: { path: '/apis/ui/Trolley', to: 'https://evil.test/x' } },
    })
    const b = await browser(site)
    expect(location(await b.www.get('/APIS/UI/TROLLEY'))).toBe('https://evil.test/x')
    expect(location(await b.www.postJson('/apis/ui/trolley', {}))).toBe('https://evil.test/x')
    expect((await b.www.get('/shop/securelogin')).status).toBe(200)
  })
})
