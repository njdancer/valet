// The hub (docs/relay-hub.md), step 1: the account with a passkey and the authenticator-app backup,
// Macs joining it as nodes over their relay socket, and node presence. Against a local Workers
// runtime, with the real relay client as the Mac and a software passkey as the browser's.

import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type HubStatus,
  hubGrantId,
  nextRosterChange,
  type RosterDevice,
  SIGNING_DOMAINS,
  verifyRoster,
} from '@valet/core'
import {
  ConsentRequests,
  type ListedTool,
  RelayClient,
  type RelayEvent,
  RemoteAccessTokens,
  RemoteAuthorization,
  RemoteClients,
  startRemoteListener,
  type ToolCall,
} from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
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
  /** Each hub-roster frame, in order. */
  readonly rosters: Extract<RelayEvent, { type: 'hub-roster' }>[]
  /** Each hub-consents and hub-grants frame, in order. */
  readonly consents: Extract<RelayEvent, { type: 'hub-consents' }>[]
  readonly grants: Extract<RelayEvent, { type: 'hub-grants' }>[]
  /** This Mac as a roster device, and its approval key's signature over a change. */
  readonly device: RosterDevice
  signRoster(payload: string): { payload: string; signature: string }
  signGrant(payload: string): { payload: string; signature: string }
  online(): Promise<void>
  next(state: HubStatus['state']): Promise<HubStatus>
}

interface MacOptions {
  readonly pingMs?: number
  /** The Mac's remote listener, for agents through the hub (step 2). */
  readonly listener?: () => string | null
  readonly hubAuthorization?: (grantId: string) => string | null
}

function startMac(runtime: Runtime, options: MacOptions = {}): Mac {
  const transport = testKey()
  const approval = testKey()
  const hub: HubStatus[] = []
  const rosters: Extract<RelayEvent, { type: 'hub-roster' }>[] = []
  const consents: Extract<RelayEvent, { type: 'hub-consents' }>[] = []
  const grants: Extract<RelayEvent, { type: 'hub-grants' }>[] = []
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
    listener: options.listener ?? (() => null),
    ...(options.hubAuthorization === undefined ? {} : { hubAuthorization: options.hubAuthorization }),
    consent: () => ({ state: 'declined' }),
    onEvent: (event: RelayEvent) => {
      if (event.type === 'hub-status') hub.push(event.hub)
      if (event.type === 'hub-roster') rosters.push(event)
      if (event.type === 'hub-consents') consents.push(event)
      if (event.type === 'hub-grants') grants.push(event)
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
    rosters,
    consents,
    grants,
    device: {
      deviceId: approval.id,
      role: 'mac',
      platform: 'macos',
      name: 'Mac',
      approvalKey: approval.publicKey,
      transportKey: transport.publicKey,
      agreementKey: testKey().publicKey,
    },
    signRoster: (payload) => ({
      payload,
      signature: approval.signDomain(SIGNING_DOMAINS.rosterChange, payload),
    }),
    signGrant: (payload) => ({
      payload,
      signature: approval.signDomain(SIGNING_DOMAINS.hubGrant, payload),
    }),
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
      accountId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
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

  it('keeps the account’s device list: signed by devices on it, the same for every node', async () => {
    const runtime = await relay()
    const browser = new Browser(runtime)
    await signUp(browser, testPasskey(HUB_HOST))
    const join = async (name: string, slug: string): Promise<Mac & { accountId: string }> => {
      const mac = startMac(runtime)
      await mac.online()
      mac.client.send({ type: 'hub-link-start', name })
      const linking = await mac.next('linking')
      if (linking.state !== 'linking') throw new Error('expected linking')
      await browser.json('/api/nodes/link', { code: linking.code, slug })
      const linked = await mac.next('linked')
      if (linked.state !== 'linked') throw new Error('expected linked')
      return Object.assign(mac, { accountId: linked.accountId })
    }
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 10_000
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await delay(50)
      }
    }
    const a = await join('Studio', 'studio')
    const b = await join('Laptop', 'laptop')
    // Linked, with an empty list so far.
    await until(() => a.rosters.length > 0)
    expect(a.rosters.at(-1)?.changes).toEqual([])

    // The first device adds itself.
    const at = new Date().toISOString()
    const genesis = a.signRoster(
      nextRosterChange(null, a.accountId, a.id, { op: 'add', device: a.device }, at),
    )
    a.client.send({ type: 'hub-roster-append', changes: [genesis] })
    await until(() => b.rosters.some((r) => r.changes.length === 1))
    await until(() => a.rosters.some((r) => r.changes.length === 1))
    const first = verifyRoster(b.rosters.at(-1)?.changes ?? [])
    if (!first.ok) throw new Error(first.reason)

    // B isn't on the list, so it can't add itself.
    const self = b.signRoster(
      nextRosterChange(first.roster, a.accountId, b.id, { op: 'add', device: b.device }, at),
    )
    b.client.send({ type: 'hub-roster-append', changes: [self] })
    await until(() => b.rosters.some((r) => r.refused === 'invalid'))

    // A adds B. A change built on an old head is refused as a conflict.
    const add = a.signRoster(
      nextRosterChange(first.roster, a.accountId, a.id, { op: 'add', device: b.device }, at),
    )
    a.client.send({ type: 'hub-roster-append', changes: [add] })
    await until(() => b.rosters.some((r) => r.changes.length === 2))
    a.client.send({ type: 'hub-roster-append', changes: [add] })
    await until(() => a.rosters.some((r) => r.refused === 'conflict'))
    const second = verifyRoster(b.rosters.at(-1)?.changes ?? [], { pinned: first.roster.genesis })
    expect(second.ok && [...second.roster.devices.keys()]).toEqual([a.id, b.id])

    // Several changes in one frame are kept all together, or not at all.
    const x = startMac(runtime).device
    const y = startMac(runtime).device
    if (!second.ok) throw new Error(second.reason)
    const addX = a.signRoster(
      nextRosterChange(second.roster, a.accountId, a.id, { op: 'add', device: x }, at),
    )
    const afterX = verifyRoster([...(b.rosters.at(-1)?.changes ?? []), addX])
    if (!afterX.ok) throw new Error(afterX.reason)
    const again = a.signRoster(
      nextRosterChange(afterX.roster, a.accountId, a.id, { op: 'add', device: x }, at),
    )
    const addY = a.signRoster(
      nextRosterChange(afterX.roster, a.accountId, a.id, { op: 'add', device: y }, at),
    )
    const refusals = a.rosters.filter((r) => r.refused === 'invalid').length
    a.client.send({ type: 'hub-roster-append', changes: [addX, again] })
    await until(() => a.rosters.filter((r) => r.refused === 'invalid').length > refusals)
    expect(a.rosters.at(-1)?.changes).toHaveLength(2)
    a.client.send({ type: 'hub-roster-append', changes: [addX, addY] })
    await until(() => b.rosters.some((r) => r.changes.length === 4))
    const third = verifyRoster(b.rosters.at(-1)?.changes ?? [], { pinned: first.roster.genesis })
    expect(third.ok && [...third.roster.devices.keys()]).toEqual([a.id, b.id, x.deviceId, y.deviceId])

    // After a reconnect, the list comes with the status.
    const before = b.rosters.length
    await b.client.stop()
    b.client.start()
    await b.online()
    await until(() => b.rosters.length > before)
    expect(b.rosters.at(-1)?.changes).toHaveLength(4)

    // A Mac on no account can't append.
    const stranger = startMac(runtime)
    await stranger.online()
    stranger.client.send({ type: 'hub-roster-append', changes: [genesis] })
    await until(() => stranger.rosters.some((r) => r.refused === 'not-linked'))
  })
})

describe('agents signing in at the hub', () => {
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out')
      await delay(50)
    }
  }
  const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

  /** An account with one Mac on it, which started the device list. */
  async function account(options: { runtime?: Runtime; mac?: MacOptions } = {}) {
    const runtime = options.runtime ?? (await relay())
    const browser = new Browser(runtime)
    await signUp(browser, testPasskey(HUB_HOST))
    const mac = startMac(runtime, options.mac)
    await mac.online()
    mac.client.send({ type: 'hub-link-start', name: 'Studio' })
    const linking = await mac.next('linking')
    if (linking.state !== 'linking') throw new Error('expected linking')
    await browser.json('/api/nodes/link', { code: linking.code, slug: 'studio' })
    const linked = await mac.next('linked')
    if (linked.state !== 'linked') throw new Error('expected linked')
    const genesis = mac.signRoster(
      nextRosterChange(
        null,
        linked.accountId,
        mac.id,
        { op: 'add', device: mac.device },
        new Date().toISOString(),
      ),
    )
    mac.client.send({ type: 'hub-roster-append', changes: [genesis] })
    await until(() => mac.rosters.some((r) => r.changes.length === 1))
    return { runtime, mac, browser, accountId: linked.accountId }
  }

  /** An agent's browser: registers, opens /authorize, and keeps the consent cookie. */
  async function agent(runtime: Runtime) {
    const registered = await runtime.fetch(`${HUB_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude' }),
    })
    expect(registered.status).toBe(201)
    const { client_id: clientId } = (await registered.json()) as { client_id: string }
    const verifier = 'v'.repeat(50)
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      state: 'st',
      resource: `${HUB_ORIGIN}/mcp`,
    })
    const page = await runtime.fetch(`${HUB_ORIGIN}/authorize?${query}`)
    expect(page.status).toBe(200)
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] as string
    const data = /data-consent="([^"]*)"/.exec(await page.text())?.[1] ?? ''
    const consent = JSON.parse(
      data
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&'),
    ) as {
      id: string
      code: string
    }
    const get = (path: string) =>
      runtime.fetch(`${HUB_ORIGIN}${path}?id=${consent.id}`, { headers: { cookie }, redirect: 'manual' })
    const token = (form: Record<string, string>) =>
      runtime.fetch(`${HUB_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, ...form }).toString(),
      })
    return { clientId, verifier, consent, get, token }
  }

  const grantFor = (
    accountId: string,
    by: string,
    consent: { id: string },
    clientId: string,
    at = Date.now(),
  ) =>
    JSON.stringify({
      v: 1,
      account: accountId,
      consentId: consent.id,
      clientId,
      clientName: 'Claude',
      host: 'claude.ai',
      scope: 'remote-tools',
      at: new Date(at).toISOString(),
      expiresAt: new Date(at + 30 * 24 * 60 * 60_000).toISOString(),
      by,
    })

  it('publishes its metadata', async () => {
    const runtime = await relay()
    const resource = await (
      await runtime.fetch(`${HUB_ORIGIN}/.well-known/oauth-protected-resource/mcp`)
    ).json()
    expect(resource).toMatchObject({ resource: `${HUB_ORIGIN}/mcp`, authorization_servers: [HUB_ORIGIN] })
    const server = await (await runtime.fetch(`${HUB_ORIGIN}/.well-known/oauth-authorization-server`)).json()
    expect(server).toMatchObject({ issuer: HUB_ORIGIN, code_challenge_methods_supported: ['S256'] })
    const bad = await runtime.fetch(`${HUB_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
    })
    expect(bad.status).toBe(400)
  })

  it('lets an agent in only with a grant a device on the list signed', async () => {
    const { runtime, mac, accountId } = await account()
    const a = await agent(runtime)

    // The Mac hears the sign-in, with the code the browser shows.
    await until(() => mac.consents.some((c) => c.consents.some((x) => x.id === a.consent.id)))
    const shown = mac.consents.at(-1)?.consents.find((x) => x.id === a.consent.id)
    expect(shown).toMatchObject({ clientName: 'Claude', host: 'claude.ai', code: a.consent.code })
    expect(await (await a.get('/authorize/status')).json()).toEqual({ state: 'pending' })

    // A key that isn't on the list: refused, still waiting.
    const stranger = testKey()
    mac.client.send({
      type: 'hub-grant',
      grant: {
        payload: grantFor(accountId, stranger.id, a.consent, a.clientId),
        signature: stranger.signDomain(
          SIGNING_DOMAINS.hubGrant,
          grantFor(accountId, stranger.id, a.consent, a.clientId),
        ),
      },
    })
    // Signed for another purpose: refused too.
    const payload = grantFor(accountId, mac.id, a.consent, a.clientId)
    mac.client.send({ type: 'hub-grant', grant: { payload, signature: mac.signRoster(payload).signature } })
    await delay(300)
    expect(await (await a.get('/authorize/status')).json()).toEqual({ state: 'pending' })
    // Without the browser's cookie, nothing.
    expect(
      (await runtime.fetch(`${HUB_ORIGIN}/authorize/done?id=${a.consent.id}`, { redirect: 'manual' })).status,
    ).toBe(400)

    // The Mac signs it: every node hears the grant, and the browser collects its code.
    mac.client.send({ type: 'hub-grant', grant: mac.signGrant(payload) })
    await until(() => mac.grants.some((g) => g.grants.length === 1))
    expect(await (await a.get('/authorize/status')).json()).toEqual({ state: 'approved' })
    const done = await a.get('/authorize/done')
    expect(done.status).toBe(302)
    const back = new URL(done.headers.get('location') ?? '')
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe('st')
    expect(back.searchParams.get('iss')).toBe(HUB_ORIGIN)
    const code = back.searchParams.get('code') ?? ''
    expect((await a.get('/authorize/done')).status).toBe(400)

    // The code, with the right verifier, once.
    const wrong = await a.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: 'w'.repeat(50),
    })
    expect(wrong.status).toBe(400)
    const form = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: a.verifier }
    const tokens = (await (await a.token(form)).json()) as { access_token: string; refresh_token: string }
    expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    // Refresh tokens rotate; a second use of one ends the lot.
    const refreshed = await a.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { refresh_token: string }
    expect((await a.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status).toBe(
      400,
    )
    expect((await a.token({ grant_type: 'refresh_token', refresh_token: next.refresh_token })).status).toBe(
      400,
    )
    // A code used twice is refused.
    expect((await a.token(form)).status).toBe(400)

    // After a reconnect, the grant comes with the status.
    const before = mac.grants.length
    await mac.client.stop()
    mac.client.start()
    await mac.online()
    await until(() => mac.grants.length > before)
    expect(mac.grants.at(-1)?.grants).toHaveLength(1)
  })

  it('sends the agent back declined when the person says no', async () => {
    const { runtime, mac } = await account()
    const a = await agent(runtime)
    await until(() => mac.consents.some((c) => c.consents.some((x) => x.id === a.consent.id)))
    mac.client.send({ type: 'hub-consent-decline', consentId: a.consent.id })
    await until(() => mac.consents.some((c) => c.consents.length === 0))
    expect(await (await a.get('/authorize/status')).json()).toEqual({ state: 'declined' })
    const done = await a.get('/authorize/done')
    expect(new URL(done.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied')
  })

  it('serves an agent every node’s tools under one address, only with a grant the Mac checked', async () => {
    const runtime = await relay({ hub: { graceSeconds: 3 } })
    // The Mac's real remote listener: it lets an agent through the hub (client `hub-…`) call its
    // remote-enabled tools, as the app's policy does, and the relay client gives it a token only
    // for a grant it holds.
    const tokens = new RemoteAccessTokens()
    const calls: ToolCall[] = []
    const viewCart: ListedTool = {
      adapterId: 'woolworths',
      adapterName: 'Woolworths',
      declaration: { name: 'view_cart', title: 'View cart', description: 'The cart.', sideEffect: 'read' },
      input: z.object({}),
      output: z.object({ items: z.number() }),
    }
    let host = ''
    const listener = await startRemoteListener({
      caller: {
        listTools: () => [viewCart],
        call: async (call) => {
          calls.push(call)
          return { status: 'ok', output: { items: 3 } }
        },
      },
      policy: { allows: (_a, _d, clientId) => clientId === null || clientId.startsWith('hub-') },
      tokens,
      authorization: new RemoteAuthorization({
        tokens,
        clients: new RemoteClients(),
        consents: new ConsentRequests(),
      }),
      hosts: () => new Set([host]),
    })
    cleanup.push(() => listener.close())
    let honoured: Set<string> = new Set()
    const { mac, accountId } = await account({
      runtime,
      mac: {
        listener: () => listener.url,
        hubAuthorization: (grantId) =>
          honoured.has(grantId)
            ? `Bearer ${tokens.issue(`hub-${grantId.slice(0, 32)}`, `https://${host}/mcp`)}`
            : null,
      },
    })
    host = `${mac.id}.relay.test`

    // An agent signs in and the Mac approves it.
    const a = await agent(runtime)
    await until(() => mac.consents.some((c) => c.consents.some((x) => x.id === a.consent.id)))
    const signed = mac.signGrant(grantFor(accountId, mac.id, a.consent, a.clientId))
    mac.client.send({ type: 'hub-grant', grant: signed })
    await until(() => mac.grants.some((g) => g.grants.length === 1))
    honoured = new Set([hubGrantId(signed)])
    const code = new URL((await a.get('/authorize/done')).headers.get('location') ?? '').searchParams.get(
      'code',
    )
    const issued = (await (
      await a.token({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: REDIRECT,
        code_verifier: a.verifier,
      })
    ).json()) as { access_token: string }

    let next = 1
    const mcp = (method: string, params?: unknown, bearer = issued.access_token) =>
      runtime.fetch(`${HUB_ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(bearer === '' ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: next++,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      })
    const result = async (method: string, params?: unknown) => {
      const response = await mcp(method, params)
      expect(response.status).toBe(200)
      return ((await response.json()) as { result: Record<string, unknown> }).result
    }

    // No token, or someone else's: the OAuth challenge.
    const anonymous = await mcp('tools/list', undefined, '')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toContain(
      `${HUB_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    )
    expect((await mcp('tools/list', undefined, 'x'.repeat(43))).status).toBe(401)

    expect(await result('initialize', { protocolVersion: '2025-06-18', capabilities: {} })).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
    })
    expect(await result('ping')).toEqual({})

    // The node's tools, named for it, and a call that runs on it as the agent through the hub.
    const listed = (await result('tools/list')) as { tools: { name: string; title: string }[] }
    expect(listed.tools.map((t) => t.name)).toEqual(['studio__woolworths_view_cart'])
    expect(listed.tools[0]?.title).toBe('View cart (Studio)')
    const called = await result('tools/call', { name: 'studio__woolworths_view_cart', arguments: {} })
    expect(called).toMatchObject({ structuredContent: { items: 3 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.identity).toMatchObject({
      origin: 'remote',
      clientId: `hub-${hubGrantId(signed).slice(0, 32)}`,
    })
    expect(await result('tools/call', { name: 'elsewhere__x', arguments: {} })).toMatchObject({
      isError: true,
    })

    // A grant the Mac stops honouring: the node refuses, whatever the hub holds.
    honoured = new Set()
    await listener.endClient(`hub-${hubGrantId(signed).slice(0, 32)}`)
    const refused = (await result('tools/call', {
      name: 'studio__woolworths_view_cart',
      arguments: {},
    })) as { isError?: boolean }
    expect(refused.isError).toBe(true)
    expect(calls).toHaveLength(1)
    honoured = new Set([hubGrantId(signed)])

    // The Mac goes offline: its tools stay listed for the grace, failing fast, and then go.
    await mac.client.stop()
    await delay(300)
    expect(((await result('tools/list')) as { tools: unknown[] }).tools).toHaveLength(1)
    const offline = (await result('tools/call', { name: 'studio__woolworths_view_cart', arguments: {} })) as {
      isError: boolean
      content: { text: string }[]
    }
    expect(offline.isError).toBe(true)
    expect(offline.content[0]?.text).toContain('Studio is offline')
    await delay(3_200)
    expect(((await result('tools/list')) as { tools: unknown[] }).tools).toEqual([])

    // Back online: back in the list.
    mac.client.start()
    await mac.online()
    await until(() => mac.grants.length > 1)
    expect(((await result('tools/list')) as { tools: unknown[] }).tools).toHaveLength(1)

    // The person removes the agent on the Mac: its token stops working at once, and every node
    // hears the grants without it. A grant id the account doesn't hold changes nothing.
    const heard = mac.grants.length
    mac.client.send({ type: 'hub-grant-revoke', grantId: 'f'.repeat(64) })
    await delay(200)
    expect((await mcp('tools/list')).status).toBe(200)
    mac.client.send({ type: 'hub-grant-revoke', grantId: hubGrantId(signed) })
    await until(() => mac.grants.slice(heard).some((g) => g.grants.length === 0))
    expect((await mcp('tools/list')).status).toBe(401)
  }, 30_000)

  it('starts the device list again when the Mac that started it is removed, taking its grants', async () => {
    const { runtime, mac, browser, accountId } = await account()
    const a = await agent(runtime)
    await until(() => mac.consents.some((c) => c.consents.some((x) => x.id === a.consent.id)))
    mac.client.send({
      type: 'hub-grant',
      grant: mac.signGrant(grantFor(accountId, mac.id, a.consent, a.clientId)),
    })
    await until(() => mac.grants.some((g) => g.grants.length === 1))
    const code = new URL((await a.get('/authorize/done')).headers.get('location') ?? '').searchParams.get(
      'code',
    )
    const issued = (await (
      await a.token({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: REDIRECT,
        code_verifier: a.verifier,
      })
    ).json()) as { access_token: string }
    const mcp = () =>
      runtime.fetch(`${HUB_ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.access_token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
    expect((await mcp()).status).toBe(200)

    // A second Mac on the account (one that lost its keys comes back as a new one).
    const second = startMac(runtime)
    await second.online()
    second.client.send({ type: 'hub-link-start', name: 'Studio again' })
    const linking = await second.next('linking')
    if (linking.state !== 'linking') throw new Error('expected linking')
    await browser.json('/api/nodes/link', { code: linking.code, slug: 'studio-2' })
    await second.next('linked')
    await until(() => second.rosters.some((r) => r.changes.length === 1))

    // The old Mac goes: the list and the grants under it go too, and the agent's token stops working.
    await browser.json('/api/nodes/remove', { macId: mac.id })
    await until(() => second.rosters.at(-1)?.changes.length === 0)
    await until(() => second.grants.at(-1)?.grants.length === 0)
    expect((await mcp()).status).toBe(401)

    // The new Mac starts its own list.
    const genesis = second.signRoster(
      nextRosterChange(
        null,
        accountId,
        second.id,
        { op: 'add', device: second.device },
        new Date().toISOString(),
      ),
    )
    second.client.send({ type: 'hub-roster-append', changes: [genesis] })
    await until(() => second.rosters.at(-1)?.changes.length === 1)
    expect(second.rosters.at(-1)?.refused).toBeUndefined()
  })
})
