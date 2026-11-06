import { afterEach, describe, expect, it } from 'vitest'
import { type FakeWoolworths, startFakeWoolworths } from '../src/server'
import { Client } from './support/client'

const PLAIN = { username: 'plain@example.test', password: 'plain-password', firstName: 'Pat' }
const TWO_FACTOR = {
  username: 'otp@example.test',
  password: 'otp-password',
  otpCode: '135790',
  firstName: 'Olive',
}

const sites: FakeWoolworths[] = []
afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()))
})

async function start(): Promise<FakeWoolworths> {
  const site = await startFakeWoolworths({ accounts: [PLAIN, TWO_FACTOR] })
  sites.push(site)
  return site
}

async function browsing(site: FakeWoolworths): Promise<Client> {
  const client = new Client(site.origin)
  await client.visit('/')
  return client
}

async function shopper(client: Client): Promise<{ IsLoggedIn: boolean; FirstName: string | null }> {
  return JSON.parse((await client.get('/api/ui/v2/bootstrap')).text).ShopperDetails
}

describe('GET /shop/securelogin', () => {
  it('serves the login form and the decoy header search box', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/shop/securelogin')
    expect(reply.status).toBe(200)
    expect(reply.text).toContain('<form id="loginForm" method="post" action="/auth/login">')
    expect(reply.text).toContain('id="loginForm-Email"')
    expect(reply.text).toContain('id="loginForm-Password"')
    expect(reply.text).toContain('id="loginForm-Submit"')
    expect(reply.text).toContain('<input id="headerSearch-Input" type="search"')
  })
})

describe('POST /auth/login without 2FA', () => {
  it('logs in with the right credentials and redirects to the account page', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    expect(reply.status).toBe(302)
    expect(reply.headers.get('location')).toBe('/shop/myaccount')
    expect(await shopper(client)).toEqual({ IsLoggedIn: true, FirstName: 'Pat' })
    const account = await client.get('/shop/myaccount')
    expect(account.status).toBe(200)
    expect(account.text).toContain('<h1 id="myaccount-Greeting">Hi Pat</h1>')
  })

  it('sets a new httpOnly session cookie on login', async () => {
    const site = await start()
    const client = await browsing(site)
    const before = client.cookies.get('wow-auth-token')
    const reply = await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    expect(reply.setCookies).toHaveLength(1)
    expect(reply.setCookies[0]).toMatch(/^wow-auth-token=[\w-]+; Path=\/; SameSite=Lax; HttpOnly$/)
    expect(client.cookies.get('wow-auth-token')).not.toBe(before)
  })

  it('does not log in the pre-login token, so a planted token cannot be upgraded', async () => {
    const site = await start()
    const victim = await browsing(site)
    const planted = victim.cookies.get('wow-auth-token') ?? ''
    await victim.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    const attacker = await browsing(site)
    attacker.cookies.set('wow-auth-token', planted)
    expect(await shopper(attacker)).toEqual({ IsLoggedIn: false, FirstName: null })
  })

  it('re-renders the page with an error for a wrong password, and stays logged out', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.postForm('/auth/login', { email: PLAIN.username, password: 'wrong' })
    expect(reply.status).toBe(200)
    expect(reply.text).toContain('<p class="login-error" role="alert">')
    expect(reply.text).toContain('<form id="loginForm"')
    expect(reply.setCookies).toEqual([])
    expect(await shopper(client)).toEqual({ IsLoggedIn: false, FirstName: null })
  })

  it('gives an unknown user the same error as a wrong password', async () => {
    const site = await start()
    const client = await browsing(site)
    const unknown = await client.postForm('/auth/login', { email: 'nobody@example.test', password: 'x' })
    const wrong = await client.postForm('/auth/login', { email: PLAIN.username, password: 'x' })
    const error = (html: string) => /<p class="login-error"[^>]*>([^<]*)</.exec(html)?.[1]
    expect(error(unknown.text)).toBe(error(wrong.text))
  })

  it("refuses one account's username with another account's password", async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postForm('/auth/login', { email: PLAIN.username, password: TWO_FACTOR.password })
    expect((await shopper(client)).IsLoggedIn).toBe(false)
  })

  it('matches credentials exactly, not by case or prefix', async () => {
    const site = await start()
    const client = await browsing(site)
    for (const [email, password] of [
      [PLAIN.username.toUpperCase(), PLAIN.password],
      [PLAIN.username, PLAIN.password.toUpperCase()],
      [PLAIN.username, `${PLAIN.password} `],
      [PLAIN.username, PLAIN.password.slice(0, -1)],
    ]) {
      await client.postForm('/auth/login', { email: email ?? '', password: password ?? '' })
      expect((await shopper(client)).IsLoggedIn).toBe(false)
    }
  })

  it('refuses a login with missing fields', async () => {
    const site = await start()
    const client = await browsing(site)
    expect((await client.postForm('/auth/login', {})).text).toContain('login-error')
  })

  it('does not echo the submitted credentials back into the page', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.postForm('/auth/login', {
      email: 'canary-user@example.test',
      password: 'canary-pw',
    })
    expect(reply.text).not.toContain('canary-user')
    expect(reply.text).not.toContain('canary-pw')
  })
})

describe('logged-in pages', () => {
  it('redirects the login page to the account page once logged in', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    const reply = await client.get('/shop/securelogin')
    expect(reply.status).toBe(302)
    expect(reply.headers.get('location')).toBe('/shop/myaccount')
  })

  it('redirects the account page to the login page when anonymous', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/shop/myaccount')
    expect(reply.status).toBe(302)
    expect(reply.headers.get('location')).toBe('/shop/securelogin')
  })

  it('greets the shopper in the header', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    expect((await client.get('/')).text).toContain('Hi Pat')
  })
})

describe('the account trolley', () => {
  it("is the account's, shared by every session logged in to it", async () => {
    const site = await start()
    const laptop = await browsing(site)
    const phone = await browsing(site)
    for (const client of [laptop, phone]) {
      await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    }
    await laptop.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 900601, quantity: 2 }] })
    expect(JSON.parse((await phone.get('/apis/ui/Trolley')).text).TotalTrolleyItemQuantity).toBe(2)
    expect(site.trolleyFor(PLAIN.username)).toEqual([{ stockcode: 900601, quantity: 2 }])
    expect(site.trolleyFor(TWO_FACTOR.username)).toEqual([])
  })

  it('does not pick up what was added before logging in', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 88436, quantity: 1 }] })
    await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    expect(site.trolleyFor(PLAIN.username)).toEqual([])
  })

  it('cannot be read for an unknown account', async () => {
    const site = await start()
    expect(() => site.trolleyFor('nobody@example.test')).toThrow('no such fake account')
  })
})

describe('logging out', () => {
  it('ends the session and starts a fresh anonymous one', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    const loggedInToken = client.cookies.get('wow-auth-token') ?? ''
    const reply = await client.get('/auth/logout')
    expect(reply.status).toBe(302)
    expect(reply.headers.get('location')).toBe('/')
    expect((await shopper(client)).IsLoggedIn).toBe(false)
    const replay = await browsing(site)
    replay.cookies.set('wow-auth-token', loggedInToken)
    expect((await shopper(replay)).IsLoggedIn).toBe(false)
  })

  it('happens to everyone at once with expireSessions', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    site.expireSessions()
    expect((await shopper(client)).IsLoggedIn).toBe(false)
  })
})

describe('2FA', () => {
  async function passwordStep(site: FakeWoolworths): Promise<Client> {
    const client = await browsing(site)
    const reply = await client.postForm('/auth/login', {
      email: TWO_FACTOR.username,
      password: TWO_FACTOR.password,
    })
    expect(reply.status).toBe(302)
    expect(reply.headers.get('location')).toBe('/auth/verify')
    return client
  }

  it('asks for a code after the right password, and is not logged in yet', async () => {
    const site = await start()
    const client = await passwordStep(site)
    expect(await shopper(client)).toEqual({ IsLoggedIn: false, FirstName: null })
    const page = await client.get('/auth/verify')
    expect(page.status).toBe(200)
    expect(page.text).toContain('<form id="verifyForm" method="post" action="/auth/verify">')
    expect(page.text).toContain('autocomplete="one-time-code"')
  })

  it('logs in with the right code', async () => {
    const site = await start()
    const client = await passwordStep(site)
    const reply = await client.postForm('/auth/verify', { code: TWO_FACTOR.otpCode })
    expect(reply.status).toBe(302)
    expect(reply.headers.get('location')).toBe('/shop/myaccount')
    expect(await shopper(client)).toEqual({ IsLoggedIn: true, FirstName: 'Olive' })
  })

  it('re-renders with an error for a wrong code', async () => {
    const site = await start()
    const client = await passwordStep(site)
    const reply = await client.postForm('/auth/verify', { code: '000000' })
    expect(reply.status).toBe(200)
    expect(reply.text).toContain('<p class="login-error" role="alert">')
    expect((await shopper(client)).IsLoggedIn).toBe(false)
  })

  it('throws the half-finished login away after three wrong codes, so the right code no longer works', async () => {
    const site = await start()
    const client = await passwordStep(site)
    await client.postForm('/auth/verify', { code: '000000' })
    await client.postForm('/auth/verify', { code: '000001' })
    const third = await client.postForm('/auth/verify', { code: '000002' })
    expect(third.status).toBe(302)
    expect(third.headers.get('location')).toBe('/shop/securelogin')
    const late = await client.postForm('/auth/verify', { code: TWO_FACTOR.otpCode })
    expect(late.headers.get('location')).toBe('/shop/securelogin')
    expect((await shopper(client)).IsLoggedIn).toBe(false)
  })

  it('cannot be reached without the password step', async () => {
    const site = await start()
    const client = await browsing(site)
    const page = await client.get('/auth/verify')
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/shop/securelogin')
    await client.postForm('/auth/verify', { code: TWO_FACTOR.otpCode })
    expect((await shopper(client)).IsLoggedIn).toBe(false)
  })

  it('treats the pending login as tied to its session, not to whoever has the code', async () => {
    const site = await start()
    await passwordStep(site)
    const other = await browsing(site)
    await other.postForm('/auth/verify', { code: TWO_FACTOR.otpCode })
    expect((await shopper(other)).IsLoggedIn).toBe(false)
  })

  it('does not set a device cookie unless asked to remember the device', async () => {
    const site = await start()
    const client = await passwordStep(site)
    const reply = await client.postForm('/auth/verify', { code: TWO_FACTOR.otpCode })
    expect(reply.setCookies.some((line) => line.startsWith('wow-remembered-device='))).toBe(false)
  })

  it('remembers the device with a long-lived httpOnly cookie, and skips the code next time', async () => {
    const site = await start()
    const client = await passwordStep(site)
    const reply = await client.postForm('/auth/verify', { code: TWO_FACTOR.otpCode, rememberDevice: 'true' })
    const device = reply.setCookies.find((line) => line.startsWith('wow-remembered-device='))
    expect(device).toMatch(/; Max-Age=7776000; HttpOnly$/)
    await client.get('/auth/logout')
    const again = await client.postForm('/auth/login', {
      email: TWO_FACTOR.username,
      password: TWO_FACTOR.password,
    })
    expect(again.headers.get('location')).toBe('/shop/myaccount')
    expect((await shopper(client)).IsLoggedIn).toBe(true)
  })

  it('remembers the device across expired sessions', async () => {
    const site = await start()
    const client = await passwordStep(site)
    await client.postForm('/auth/verify', { code: TWO_FACTOR.otpCode, rememberDevice: 'true' })
    site.expireSessions()
    const again = await client.postForm('/auth/login', {
      email: TWO_FACTOR.username,
      password: TWO_FACTOR.password,
    })
    expect(again.headers.get('location')).toBe('/shop/myaccount')
  })

  it('still asks for the password on a remembered device', async () => {
    const site = await start()
    const client = await passwordStep(site)
    await client.postForm('/auth/verify', { code: TWO_FACTOR.otpCode, rememberDevice: 'true' })
    await client.get('/auth/logout')
    await client.postForm('/auth/login', { email: TWO_FACTOR.username, password: 'wrong' })
    expect((await shopper(client)).IsLoggedIn).toBe(false)
  })

  it('does not skip the code with a forged device cookie', async () => {
    const site = await start()
    const client = await browsing(site)
    client.cookies.set('wow-remembered-device', 'forged')
    const reply = await client.postForm('/auth/login', {
      email: TWO_FACTOR.username,
      password: TWO_FACTOR.password,
    })
    expect(reply.headers.get('location')).toBe('/auth/verify')
  })

  it("does not skip the code with a device cookie remembered for someone else's account", async () => {
    const accounts = [TWO_FACTOR, { username: 'other@example.test', password: 'other', otpCode: '111111' }]
    const site = await startFakeWoolworths({ accounts })
    sites.push(site)
    const client = await browsing(site)
    await client.postForm('/auth/login', { email: 'other@example.test', password: 'other' })
    await client.postForm('/auth/verify', { code: '111111', rememberDevice: 'true' })
    await client.get('/auth/logout')
    const reply = await client.postForm('/auth/login', {
      email: TWO_FACTOR.username,
      password: TWO_FACTOR.password,
    })
    expect(reply.headers.get('location')).toBe('/auth/verify')
  })
})

describe('hostile variants', () => {
  it('can make the login form post somewhere else, for the form-action guard', async () => {
    const site = await startFakeWoolworths({
      accounts: [PLAIN],
      hostile: { loginFormAction: 'https://evil.test:4443/steal' },
    })
    sites.push(site)
    const page = await new Client(site.origin).get('/shop/securelogin')
    expect(page.text).toContain('<form id="loginForm" method="post" action="https://evil.test:4443/steal">')
    // The real endpoint still works, so a test can tell "blocked" from "broken".
    const client = await browsing(site)
    await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    expect((await shopper(client)).IsLoggedIn).toBe(true)
  })

  it('escapes a hostile form action rather than breaking out of the attribute', async () => {
    const site = await startFakeWoolworths({ hostile: { loginFormAction: '"><script>x</script>' } })
    sites.push(site)
    const page = await new Client(site.origin).get('/shop/securelogin')
    expect(page.text).toContain('action="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"')
  })

  it('keeps the hostile form action when re-rendering after a wrong password', async () => {
    const site = await startFakeWoolworths({
      accounts: [PLAIN],
      hostile: { loginFormAction: 'https://evil.test/' },
    })
    sites.push(site)
    const client = await browsing(site)
    const reply = await client.postForm('/auth/login', { email: PLAIN.username, password: 'wrong' })
    expect(reply.text).toContain('action="https://evil.test/"')
  })

  it('can redirect off-site after login via returnUrl, for the navigation guard', async () => {
    const site = await startFakeWoolworths({ accounts: [PLAIN], hostile: { openRedirectAfterLogin: true } })
    sites.push(site)
    const client = await browsing(site)
    const page = await client.get('/shop/securelogin?returnUrl=https%3A%2F%2Fevil.test%2Flanded')
    expect(page.text).toContain('action="/auth/login?returnUrl=https%3A%2F%2Fevil.test%2Flanded"')
    const reply = await client.postForm('/auth/login?returnUrl=https%3A%2F%2Fevil.test%2Flanded', {
      email: PLAIN.username,
      password: PLAIN.password,
    })
    expect(reply.status).toBe(302)
    expect(reply.headers.get('location')).toBe('https://evil.test/landed')
  })

  it('keeps returnUrl on the form when re-rendering after a wrong password', async () => {
    const site = await startFakeWoolworths({ accounts: [PLAIN], hostile: { openRedirectAfterLogin: true } })
    sites.push(site)
    const client = await browsing(site)
    const reply = await client.postForm('/auth/login?returnUrl=%2Fx', {
      email: PLAIN.username,
      password: 'no',
    })
    expect(reply.text).toContain('action="/auth/login?returnUrl=%2Fx"')
  })

  it('falls back to the account page when the open-redirect variant gets no returnUrl', async () => {
    const site = await startFakeWoolworths({ accounts: [PLAIN], hostile: { openRedirectAfterLogin: true } })
    sites.push(site)
    const client = await browsing(site)
    const page = await client.get('/shop/securelogin')
    expect(page.text).toContain('action="/auth/login"')
    const reply = await client.postForm('/auth/login', { email: PLAIN.username, password: PLAIN.password })
    expect(reply.headers.get('location')).toBe('/shop/myaccount')
  })

  it('ignores returnUrl entirely unless the variant is on', async () => {
    const site = await start()
    const client = await browsing(site)
    const page = await client.get('/shop/securelogin?returnUrl=https%3A%2F%2Fevil.test%2F')
    expect(page.text).toContain('<form id="loginForm" method="post" action="/auth/login">')
    const reply = await client.postForm('/auth/login?returnUrl=https%3A%2F%2Fevil.test%2F', {
      email: PLAIN.username,
      password: PLAIN.password,
    })
    expect(reply.headers.get('location')).toBe('/shop/myaccount')
  })
})

describe('default first name', () => {
  it('is Shopper when an account has none', async () => {
    const site = await startFakeWoolworths({ accounts: [{ username: 'a@example.test', password: 'p' }] })
    sites.push(site)
    const client = await browsing(site)
    await client.postForm('/auth/login', { email: 'a@example.test', password: 'p' })
    expect(await shopper(client)).toEqual({ IsLoggedIn: true, FirstName: 'Shopper' })
  })
})
