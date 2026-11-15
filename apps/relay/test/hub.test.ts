// The hub (docs/relay-hub.md), step 1: the account with a passkey and the authenticator-app backup,
// Macs joining it as nodes over their relay socket, and node presence. Against a local Workers
// runtime, with the real relay client as the Mac and a software passkey as the browser's.

import { setTimeout as delay } from 'node:timers/promises'
import { type HubStatus, SIGNING_DOMAINS } from '@valet/core'
import { RelayClient, type RelayEvent } from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { base32, checkTotp, fromBase32, normaliseLinkCode, slugFromName, totpAt } from '../src/hub/secrets'
import { testKey } from './keys'
import { type TestPasskey, testPasskey } from './passkey'
import { HUB_HOST, HUB_ORIGIN, HUB_SETUP_SECRET, RELAY_ORIGIN, type Runtime, startRelay } from './runtime'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function relay(options: Parameters<typeof startRelay>[0] = {}): Promise<Runtime> {
  const runtime = await startRelay(options)
  cleanup.push(() => runtime.close())
  return runtime
}

/** A browser on the hub's pages: keeps the session cookie and sends the hub's Origin. */
class Browser {
  cookie = ''
  constructor(private readonly runtime: Runtime) {}

  async get(path: string): Promise<Response> {
    return this.runtime.fetch(`${HUB_ORIGIN}${path}`, { headers: this.headers() })
  }

  async post(path: string, body: unknown, origin: string | null = HUB_ORIGIN): Promise<Response> {
    const headers = {
      ...this.headers(),
      'content-type': 'application/json',
      ...(origin === null ? {} : { origin }),
    }
    const response = await this.runtime.fetch(`${HUB_ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const set = response.headers.get('set-cookie')
    if (set !== null) this.cookie = set.split(';')[0] as string
    return response
  }

  async json<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    const response = body === undefined ? await this.get(path) : await this.post(path, body)
    const data = (await response.json()) as T
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`)
    return data
  }

  private headers(): Record<string, string> {
    return this.cookie === '' ? {} : { cookie: this.cookie }
  }
}

interface Options {
  challenge: string
  user: { id: string }
}

async function signUp(browser: Browser, passkey: TestPasskey, email = 'nick@example.com'): Promise<void> {
  const { challengeId, options } = await browser.json<{ challengeId: string; options: Options }>(
    '/api/sign-up/options',
    { setup: HUB_SETUP_SECRET, email },
  )
  await browser.json('/api/sign-up/verify', { challengeId, response: passkey.register(options, HUB_ORIGIN) })
}

async function signIn(browser: Browser, passkey: TestPasskey): Promise<Response> {
  const { challengeId, options } = await browser.json<{ challengeId: string; options: Options }>(
    '/api/sign-in/options',
    {},
  )
  return browser.post('/api/sign-in/verify', { challengeId, response: passkey.assert(options, HUB_ORIGIN) })
}

interface Mac {
  readonly id: string
  readonly client: RelayClient
  readonly hub: HubStatus[]
  online(): Promise<void>
  next(state: HubStatus['state']): Promise<HubStatus>
}

function startMac(runtime: Runtime, options: { pingMs?: number } = {}): Mac {
  const transport = testKey()
  const approval = testKey()
  const hub: HubStatus[] = []
  const waiters: Array<() => void> = []
  let cursor = 0
  const client = new RelayClient({
    relay: RELAY_ORIGIN,
    connectUrl: runtime.url,
    macId: approval.id,
    signer: transport,
    binding: {
      approvalKey: approval.publicKey,
      signature: approval.signDomain(SIGNING_DOMAINS.relayBinding, transport.publicKey),
    },
    listener: () => null,
    consent: () => ({ state: 'declined' }),
    onEvent: (event: RelayEvent) => {
      if (event.type === 'hub-status') hub.push(event.hub)
      for (const w of waiters.splice(0)) w()
    },
    onStatus: () => {
      for (const w of waiters.splice(0)) w()
    },
    backoff: { minMs: 50, maxMs: 200 },
    ...(options.pingMs === undefined ? {} : { pingMs: options.pingMs }),
  })
  cleanup.push(() => client.stop())
  client.start()
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out')
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), delay(100)])
    }
  }
  return {
    id: approval.id,
    client,
    hub,
    online: () => until(() => client.status.state === 'online'),
    // Statuses in order: each call takes the first one of that state after the last one taken.
    next: async (state) => {
      const found = () => hub.findIndex((s, i) => i >= cursor && s.state === state)
      await until(() => found() >= 0)
      const index = found()
      cursor = index + 1
      return hub[index] as HubStatus
    },
  }
}

describe('hub secrets', () => {
  it('matches the RFC 6238 test vector and base32', async () => {
    const secret = base32(new TextEncoder().encode('12345678901234567890'))
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(new TextDecoder().decode(fromBase32(secret) as Uint8Array)).toBe('12345678901234567890')
    // 94287082 at T = 59 s with eight digits; the hub uses six.
    expect(await totpAt(secret, 1)).toBe('287082')
    expect(await checkTotp(secret, '287082', 59_000, null)).toBe(1)
    expect(await checkTotp(secret, '287082', 59_000, 1)).toBeNull()
    expect(await checkTotp(secret, '287082', 200_000, null)).toBeNull()
  })

  it('normalises link codes and makes slugs', () => {
    expect(normaliseLinkCode(' abcd efgh ')).toBe('ABCD-EFGH')
    expect(normaliseLinkCode('ABCD-EFGI')).toBeNull()
    expect(slugFromName('Nick’s MacBook Pro')).toBe('nicks-macbook-pro'.slice(0, 16).replace(/-$/, ''))
    expect(slugFromName('💻')).toBe('node')
  })
})

describe('the hub account', () => {
  it('takes one account, made with the setup code and a passkey', async () => {
    const runtime = await relay()
    const browser = new Browser(runtime)
    const passkey = testPasskey(HUB_HOST)

    const wrong = await browser.post('/api/sign-up/options', { setup: 'nope', email: 'nick@example.com' })
    expect(wrong.status).toBe(403)
    expect(((await browser.get('/sign-up')) as Response).status).toBe(200)

    await signUp(browser, passkey)
    expect(browser.cookie).toMatch(/^__Host-valet-hub=/)
    const me = await browser.json<{ email: string; passkeys: unknown[]; app: boolean }>('/api/me')
    expect(me).toMatchObject({ email: 'nick@example.com', app: false })
    expect(me.passkeys).toHaveLength(1)

    // Sign-up is closed now, even with the code.
    const again = await new Browser(runtime).post('/api/sign-up/options', {
      setup: HUB_SETUP_SECRET,
      email: 'someone@example.com',
    })
    expect(again.status).toBe(403)
    expect((await new Browser(runtime).get('/sign-up')).status).toBe(303)
  })

  it('signs in with the passkey, once per challenge, and refuses other passkeys', async () => {
    const runtime = await relay()
    const passkey = testPasskey(HUB_HOST)
    await signUp(new Browser(runtime), passkey)

    const browser = new Browser(runtime)
    expect((await browser.get('/')).headers.get('location')).toBe('/sign-in')
    expect((await browser.get('/link')).headers.get('location')).toBe('/sign-in?next=%2Flink')
    expect((await signIn(browser, passkey)).status).toBe(200)
    const home = await browser.get('/')
    expect(home.status).toBe(200)
    expect(home.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[0-9a-f]{32}'/)

    // A stranger's passkey for the same site.
    expect((await signIn(new Browser(runtime), testPasskey(HUB_HOST))).status).toBe(401)

    // An answer to a challenge can't be used twice.
    const stranger = new Browser(runtime)
    const { challengeId, options } = await stranger.json<{ challengeId: string; options: Options }>(
      '/api/sign-in/options',
      {},
    )
    const response = passkey.assert(options, HUB_ORIGIN)
    expect((await stranger.post('/api/sign-in/verify', { challengeId, response })).status).toBe(200)
    expect((await new Browser(runtime).post('/api/sign-in/verify', { challengeId, response })).status).toBe(
      400,
    )

    // A passkey answer made for another site's origin.
    const phish = new Browser(runtime)
    const other = await phish.json<{ challengeId: string; options: Options }>('/api/sign-in/options', {})
    const forged = passkey.assert(other.options, 'https://hub.example.evil')
    expect(
      (await phish.post('/api/sign-in/verify', { challengeId: other.challengeId, response: forged })).status,
    ).toBe(401)
  })

  it('refuses changes from other origins and signs out', async () => {
    const runtime = await relay()
    const browser = new Browser(runtime)
    await signUp(browser, testPasskey(HUB_HOST))
    expect((await browser.post('/api/sign-out', {}, null)).status).toBe(403)
    expect((await browser.post('/api/sign-out', {}, 'https://evil.example')).status).toBe(403)
    expect((await browser.post('/api/sign-out', {})).status).toBe(200)
    expect(browser.cookie).toBe('__Host-valet-hub=')
    expect((await browser.get('/api/me')).status).toBe(401)
  })

  it('signs in with email, password and an authenticator code, each code once', async () => {
    const runtime = await relay()
    const browser = new Browser(runtime)
    await signUp(browser, testPasskey(HUB_HOST))
    const short = await browser.post('/api/app/start', { password: 'short' })
    expect(short.status).toBe(400)
    const started = await browser.json<{ challengeId: string; secret: string; uri: string }>(
      '/api/app/start',
      {
        password: 'correct horse battery',
      },
    )
    expect(started.uri).toMatch(/^otpauth:\/\/totp\/Valet%3Anick%40example\.com\?secret=/)
    const step = Math.floor(Date.now() / 30_000)
    expect(
      (await browser.post('/api/app/confirm', { challengeId: started.challengeId, code: '000000' })).status,
    ).toBe(400)
    // A wrong code ends that start, so begin again.
    const restarted = await browser.json<{ challengeId: string; secret: string }>('/api/app/start', {
      password: 'correct horse battery',
    })
    await browser.json('/api/app/confirm', {
      challengeId: restarted.challengeId,
      code: await totpAt(restarted.secret, step),
    })
    expect((await browser.json<{ app: boolean }>('/api/me')).app).toBe(true)

    const laptop = new Browser(runtime)
    const used = await laptop.post('/api/sign-in/app', {
      email: 'nick@example.com',
      password: 'correct horse battery',
      code: await totpAt(restarted.secret, step),
    })
    expect(used.status).toBe(401)
    const badPassword = await laptop.post('/api/sign-in/app', {
      email: 'nick@example.com',
      password: 'wrong horse battery',
      code: await totpAt(restarted.secret, step + 1),
    })
    expect(badPassword.status).toBe(401)
    const ok = await laptop.post('/api/sign-in/app', {
      email: 'NICK@example.com',
      password: 'correct horse battery',
      code: await totpAt(restarted.secret, step + 1),
    })
    expect(ok.status).toBe(200)
    expect((await laptop.json<{ email: string }>('/api/me')).email).toBe('nick@example.com')
  })

  it('keeps a way in: the last passkey stays until the authenticator app is on', async () => {
    const runtime = await relay()
    const browser = new Browser(runtime)
    const passkey = testPasskey(HUB_HOST)
    await signUp(browser, passkey)
    expect((await browser.post('/api/passkeys/remove', { id: passkey.id })).status).toBe(409)
    expect((await browser.post('/api/app/remove', {})).status).toBe(200)

    const second = testPasskey(HUB_HOST)
    const { challengeId, options } = await browser.json<{ challengeId: string; options: Options }>(
      '/api/passkeys/options',
      {},
    )
    await browser.json('/api/passkeys/verify', {
      challengeId,
      response: second.register(options, HUB_ORIGIN),
    })
    await browser.json('/api/passkeys/remove', { id: passkey.id })
    expect((await signIn(new Browser(runtime), passkey)).status).toBe(401)
    expect((await signIn(new Browser(runtime), second)).status).toBe(200)
  })
})

describe('nodes', () => {
  it('adds a Mac with the code it shows, tells it, and lists it online', async () => {
    const runtime = await relay()
    const browser = new Browser(runtime)
    await signUp(browser, testPasskey(HUB_HOST))
    const mac = startMac(runtime)
    await mac.online()
    expect((await mac.next('unlinked')).state).toBe('unlinked')

    mac.client.send({ type: 'hub-link-start', name: 'Nick’s MacBook Pro' })
    const linking = await mac.next('linking')
    if (linking.state !== 'linking') throw new Error('expected linking')
    expect(linking.url).toBe(HUB_ORIGIN)

    expect((await browser.post('/api/nodes/preview', { code: 'ABCD-EFGH' })).status).toBe(404)
    const preview = await browser.json<{ name: string; slug: string }>('/api/nodes/preview', {
      code: linking.code.toLowerCase().replace('-', ' '),
    })
    expect(preview).toEqual({
      name: 'Nick’s MacBook Pro',
      slug: 'nicks-macbook-pro'.slice(0, 16).replace(/-$/, ''),
    })
    expect((await browser.post('/api/nodes/link', { code: linking.code, slug: 'Not OK' })).status).toBe(400)
    await browser.json('/api/nodes/link', { code: linking.code, slug: 'mbp' })
    expect(await mac.next('linked')).toEqual({
      state: 'linked',
      url: HUB_ORIGIN,
      account: 'nick@example.com',
      slug: 'mbp',
      name: 'Nick’s MacBook Pro',
    })
    // The code is spent.
    expect((await browser.post('/api/nodes/link', { code: linking.code, slug: 'mbp2' })).status).toBe(404)

    const { nodes } = await browser.json<{ nodes: { macId: string; online: boolean; slug: string }[] }>(
      '/api/nodes',
    )
    expect(nodes).toMatchObject([{ macId: mac.id, slug: 'mbp', online: true }])

    // Gone, then back: offline in the list, and the Mac hears it is still linked after its hello.
    await mac.client.stop()
    await delay(300)
    const away = await browser.json<{ nodes: { online: boolean }[] }>('/api/nodes')
    expect(away.nodes[0]?.online).toBe(false)
    mac.client.start()
    await mac.online()
    expect((await mac.next('linked')).state).toBe('linked')
    expect((await browser.json<{ nodes: { online: boolean }[] }>('/api/nodes')).nodes[0]?.online).toBe(true)

    // Removed on the hub's page: the Mac hears at once.
    await browser.json('/api/nodes/remove', { macId: mac.id })
    expect((await mac.next('unlinked')).state).toBe('unlinked')
    expect((await browser.json<{ nodes: unknown[] }>('/api/nodes')).nodes).toEqual([])
  })

  it('lets the Mac leave, and only someone signed in can add one', async () => {
    const runtime = await relay()
    const browser = new Browser(runtime)
    await signUp(browser, testPasskey(HUB_HOST))
    const mac = startMac(runtime)
    await mac.online()
    mac.client.send({ type: 'hub-link-start', name: 'Studio' })
    const linking = await mac.next('linking')
    if (linking.state !== 'linking') throw new Error('expected linking')
    expect(
      (await new Browser(runtime).post('/api/nodes/link', { code: linking.code, slug: 'studio' })).status,
    ).toBe(401)
    await browser.json('/api/nodes/link', { code: linking.code, slug: 'studio' })
    await mac.next('linked')
    // Starting again while linked changes nothing.
    mac.client.send({ type: 'hub-link-start', name: 'Studio' })
    expect((await mac.next('linked')).state).toBe('linked')

    mac.client.send({ type: 'hub-unlink' })
    expect((await mac.next('unlinked')).state).toBe('unlinked')
    expect((await browser.json<{ nodes: unknown[] }>('/api/nodes')).nodes).toEqual([])
  })

  it('counts a Mac that stops pinging as offline, even with its socket open', async () => {
    const runtime = await relay({ hub: { offlineAfterSeconds: 1 } })
    const browser = new Browser(runtime)
    await signUp(browser, testPasskey(HUB_HOST))
    const mac = startMac(runtime, { pingMs: 60_000 })
    await mac.online()
    mac.client.send({ type: 'hub-link-start', name: 'Quiet Mac' })
    const linking = await mac.next('linking')
    if (linking.state !== 'linking') throw new Error('expected linking')
    await browser.json('/api/nodes/link', { code: linking.code, slug: 'quiet' })
    await mac.next('linked')
    await delay(1_500)
    const { nodes } = await browser.json<{ nodes: { online: boolean }[] }>('/api/nodes')
    expect(nodes[0]?.online).toBe(false)
  })

  it('says the hub is off when the relay has none', async () => {
    const runtime = await relay({ hub: false })
    const mac = startMac(runtime)
    await mac.online()
    mac.client.send({ type: 'hub-link-start', name: 'Mac' })
    expect(await mac.next('off')).toEqual({ state: 'off' })
    expect((await runtime.fetch(`${HUB_ORIGIN}/`)).status).toBe(404)
  })

  it('opens no code before the account exists', async () => {
    const runtime = await relay()
    const mac = startMac(runtime)
    await mac.online()
    expect(await mac.next('unlinked')).toEqual({ state: 'unlinked', url: HUB_ORIGIN })
    mac.client.send({ type: 'hub-link-start', name: 'Mac' })
    expect(await mac.next('unlinked')).toEqual({ state: 'unlinked', url: HUB_ORIGIN, problem: 'unavailable' })
  })
})
