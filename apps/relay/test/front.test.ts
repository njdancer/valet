// The front door, attacked from the internet: hosts and paths, Origin, limits, bodies, JSON-RPC,
// consent polls and their signed tokens, and a Mac trying to turn consent into an open redirect.

import { describe, expect, it } from 'vitest'
import type { ConsentAnswer, ForwardRequest, RecoverResult } from '../src/core'
import {
  type FrontDoor,
  frontDoor,
  isJsonRpc,
  type MacRelayStub,
  openWaitToken,
  type RateLimiter,
  sealWaitToken,
  sourceKey,
  waitKey,
} from '../src/front'

const MAC = 'a'.repeat(32)
const HOST = `${MAC}.relay.test`
const REDIRECT = 'https://claude.example/api/mcp/auth_callback'

class Limiter implements RateLimiter {
  readonly keys: string[] = []
  constructor(private allow = true) {}
  async limit({ key }: { key: string }) {
    this.keys.push(key)
    return { success: this.allow }
  }
  set(allow: boolean) {
    this.allow = allow
  }
}

interface Harness {
  readonly door: FrontDoor
  readonly forwarded: ForwardRequest[]
  readonly consents: { id: string; query: string; source: string }[]
  readonly connects: string[]
  readonly recoveries: { code: string; unregisterPhones: boolean }[]
  recoverResult: RecoverResult
  answer: ConsentAnswer
  readonly limits: Record<'connect' | 'forward' | 'signIn' | 'poll', Limiter>
}

async function harness(): Promise<Harness> {
  const limits = {
    connect: new Limiter(),
    forward: new Limiter(),
    signIn: new Limiter(),
    poll: new Limiter(),
  }
  const h: Harness = {
    forwarded: [],
    consents: [],
    connects: [],
    recoveries: [],
    recoverResult: 'done',
    answer: { state: 'waiting', code: 'ABCD-EFGH' },
    limits,
    door: undefined as unknown as FrontDoor,
  }
  const stub: MacRelayStub = {
    connect: async (_request, role) => {
      h.connects.push(role)
      return new Response('upgraded')
    },
    forward: async (request) => {
      h.forwarded.push(request)
      return new Response('ok')
    },
    consent: async (id, query, source) => {
      h.consents.push({ id, query, source })
      return h.answer
    },
    recover: async (code, unregisterPhones) => {
      h.recoveries.push({ code, unregisterPhones })
      return h.recoverResult
    },
  }
  ;(h as { door: FrontDoor }).door = {
    host: 'relay.test',
    waitKey: await waitKey('secret'),
    mac: () => stub,
    limits,
  }
  return h
}

const req = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '203.0.113.5')
  return new Request(url, { ...init, headers })
}

describe('routing', () => {
  it('routes device sockets on the relay host and refuses everything else there', async () => {
    const h = await harness()
    const upgrade = { headers: { upgrade: 'websocket' } }
    expect(await (await frontDoor(req(`https://relay.test/v1/mac/${MAC}`, upgrade), h.door)).text()).toBe(
      'upgraded',
    )
    expect(await (await frontDoor(req(`https://relay.test/v1/phone/${MAC}`, upgrade), h.door)).text()).toBe(
      'upgraded',
    )
    expect(h.connects).toEqual(['mac', 'phone'])
    expect(h.limits.connect.keys).toEqual(['connect:203.0.113.5', 'connect:203.0.113.5'])
    for (const url of [
      `https://relay.test/v1/mac/${MAC}`,
      'https://relay.test/v1/mac/nope',
      'https://relay.test/mcp',
    ])
      expect((await frontDoor(req(url), h.door)).status).toBe(404)
    expect(
      (await frontDoor(req(`https://relay.test/v1/mac/${MAC}`, { ...upgrade, method: 'POST' }), h.door))
        .status,
    ).toBe(404)
    h.limits.connect.set(false)
    expect((await frontDoor(req(`https://relay.test/v1/mac/${MAC}`, upgrade), h.door)).status).toBe(429)
  })

  it('serves only the contract’s paths and methods on a Mac’s host', async () => {
    const h = await harness()
    for (const path of ['/', '/authorize/wait', '/mcp/x', '/admin', '/.well-known/other'])
      expect((await frontDoor(req(`https://${HOST}${path}`), h.door)).status).toBe(404)
    expect((await frontDoor(req(`https://${HOST}/mcp`, { method: 'PUT', body: '{}' }), h.door)).status).toBe(
      405,
    )
    expect((await frontDoor(req(`https://NOTAMAC.relay.test/mcp`), h.door)).status).toBe(404)
    expect((await frontDoor(req(`https://${MAC}.other.test/mcp`), h.door)).status).toBe(404)
    expect(h.forwarded).toEqual([])
  })
})

describe('forwarding', () => {
  it('forwards allowed headers, the query and the source, keyed per Mac and source', async () => {
    const h = await harness()
    const response = await frontDoor(
      req(`https://${HOST}/mcp?x=1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer t',
          cookie: 'a=b',
          'x-forwarded-for': '1.2.3.4',
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      }),
      h.door,
    )
    expect(await response.text()).toBe('ok')
    expect(h.forwarded[0]).toMatchObject({
      method: 'POST',
      path: '/mcp',
      query: 'x=1',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      source: '203.0.113.5',
      stream: false,
    })
    expect(h.limits.forward.keys).toEqual([`${MAC}:203.0.113.5`])
    await frontDoor(req(`https://${HOST}/mcp`, { headers: { accept: 'text/event-stream' } }), h.door)
    expect(h.forwarded[1]?.stream).toBe(true)
  })

  it('refuses a request carrying Origin, as the Mac’s own guard would', async () => {
    const h = await harness()
    const response = await frontDoor(
      req(`https://${HOST}/register`, {
        method: 'POST',
        headers: { origin: 'https://evil.test' },
        body: '{}',
      }),
      h.door,
    )
    expect(response.status).toBe(403)
    expect(h.forwarded).toEqual([])
  })

  it('refuses non-JSON-RPC on /mcp, oversized bodies, queries and headers, and floods', async () => {
    const h = await harness()
    const post = (body: string, headers: Record<string, string> = {}) =>
      frontDoor(req(`https://${HOST}/mcp`, { method: 'POST', body, headers }), h.door)
    expect((await post('<html>')).status).toBe(400)
    expect((await post('{"hello":"world"}')).status).toBe(400)
    expect((await post('x'.repeat(1024 * 1024 + 1))).status).toBe(413)
    expect((await post('{}', { 'content-length': String(2 * 1024 * 1024) })).status).toBe(413)
    expect((await frontDoor(req(`https://${HOST}/mcp?${'q'.repeat(2049)}`), h.door)).status).toBe(414)
    expect((await post('{"jsonrpc":"2.0"}', { authorization: 'x'.repeat(8193) })).status).toBe(431)
    expect(h.forwarded).toEqual([])
    h.limits.forward.set(false)
    expect((await post('{"jsonrpc":"2.0"}')).status).toBe(429)
    h.limits.forward.set(true)
    h.limits.signIn.set(false)
    expect(
      (await frontDoor(req(`https://${HOST}/token`, { method: 'POST', body: 'a=b' }), h.door)).status,
    ).toBe(429)
  })

  it('accepts a JSON-RPC batch but not an empty or huge one', () => {
    expect(isJsonRpc('[{"jsonrpc":"2.0","method":"a"},{"jsonrpc":"2.0","id":1,"result":{}}]')).toBe(true)
    expect(isJsonRpc('[]')).toBe(false)
    expect(isJsonRpc(JSON.stringify(Array(101).fill({ jsonrpc: '2.0', method: 'a' })))).toBe(false)
    expect(isJsonRpc('[1]')).toBe(false)
  })

  it('limits IPv6 sources by their /64', () => {
    expect(sourceKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(sourceKey('2001:DB8:0001:0002::9')).toBe('2001:db8:1:2::/64')
    expect(sourceKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(sourceKey('::1')).toBe('0:0:0:0::/64')
    expect(sourceKey('203.0.113.1')).toBe('203.0.113.1')
    expect(sourceKey('')).toBe('')
  })

  it('shuts when a limiter fails', async () => {
    const h = await harness()
    h.limits.forward.limit = async () => {
      throw new Error('down')
    }
    expect(
      (await frontDoor(req(`https://${HOST}/.well-known/oauth-authorization-server`), h.door)).status,
    ).toBe(429)
  })
})

describe('consent', () => {
  const authorize = (extra = '') =>
    `https://${HOST}/authorize?response_type=code&client_id=c1&redirect_uri=${encodeURIComponent(REDIRECT)}${extra}`

  async function waitUrl(h: Harness): Promise<string> {
    const page = await (await frontDoor(req(authorize()), h.door)).text()
    return (/url=([^"]+)"/.exec(page)?.[1] ?? '').replace(/&amp;/g, '&')
  }

  it('opens a sign-in with a fresh id, shows the code, and polls the same id with no query', async () => {
    const h = await harness()
    const page = await frontDoor(req(authorize()), h.door)
    expect(page.status).toBe(200)
    expect(await page.clone().text()).toContain('ABCD-EFGH')
    const next = await waitUrl(h)
    expect(h.consents[0]?.query).toContain('client_id=c1')
    expect(h.consents[0]?.id).toMatch(/^[A-Za-z0-9_-]{20}$/)
    await frontDoor(req(`https://${HOST}${next}`), h.door)
    expect(h.consents.at(-1)).toEqual({ id: h.consents[1]?.id, query: '', source: '203.0.113.5' })
    expect(h.limits.poll.keys).toHaveLength(1)
  })

  it('redirects only to the redirect URI the client named, never where a Mac says', async () => {
    const h = await harness()
    const next = await waitUrl(h)
    h.answer = { state: 'approved', redirect: `${REDIRECT}?code=abc&state=s` }
    const ok = await frontDoor(req(`https://${HOST}${next}`), h.door)
    expect(ok.status).toBe(302)
    expect(ok.headers.get('location')).toBe(`${REDIRECT}?code=abc&state=s`)

    for (const evil of [
      'https://evil.test/phish',
      'https://claude.example/other?code=1',
      'http://claude.example/api/mcp/auth_callback',
    ]) {
      h.answer = { state: 'approved', redirect: evil }
      const refused = await frontDoor(req(`https://${HOST}${next}`), h.door)
      expect(refused.status).toBe(400)
      expect(refused.headers.get('location')).toBeNull()
    }
    // A decline never redirects, even to the named URI: errors get the relay's own page.
    h.answer = { state: 'declined', redirect: `${REDIRECT}?error=access_denied&state=s` }
    const declined = await frontDoor(req(`https://${HOST}${next}`), h.door)
    expect(declined.status).toBe(403)
    expect(declined.headers.get('location')).toBeNull()
    expect(await declined.text()).toContain('declined')
    h.answer = { state: 'declined' }
    expect((await frontDoor(req(`https://${HOST}${next}`), h.door)).status).toBe(400)
  })

  it('renders every other answer as a fixed page', async () => {
    const h = await harness()
    for (const [answer, status] of [
      [{ state: 'expired' }, 404],
      [{ state: 'offline' }, 503],
      [{ state: 'no-answer' }, 504],
      [{ state: 'waiting', code: '<script>' }, 502],
    ] as const) {
      h.answer = answer
      const page = await frontDoor(req(authorize()), h.door)
      expect(page.status).toBe(status)
      expect(await page.text()).not.toContain('<script>')
    }
  })

  it('refuses forged, expired, mixed or other-Mac wait tokens, and floods', async () => {
    const h = await harness()
    const next = await waitUrl(h)
    const token = new URL(next, 'https://x').searchParams.get('wait') as string
    const before = h.consents.length
    expect((await frontDoor(req(`https://${HOST}/authorize?wait=${token}x`), h.door)).status).toBe(404)
    expect(
      (await frontDoor(req(`https://${HOST}/authorize?wait=${token}&client_id=c2`), h.door)).status,
    ).toBe(400)
    expect(
      (await frontDoor(req(`https://${'b'.repeat(32)}.relay.test/authorize?wait=${token}`), h.door)).status,
    ).toBe(404)
    const forged = await sealWaitToken(await waitKey('other'), {
      id: 'A'.repeat(20),
      macId: MAC,
      redirect: REDIRECT,
      exp: Date.now() + 60_000,
    })
    expect((await frontDoor(req(`https://${HOST}/authorize?wait=${forged}`), h.door)).status).toBe(404)
    expect(h.consents.length).toBe(before)

    const key = await waitKey('secret')
    expect(await openWaitToken(key, token, MAC, Date.now() + 7 * 60_000)).toBeNull()
    expect(await openWaitToken(key, 'a.b.c', MAC, 0)).toBeNull()
    expect(await openWaitToken(key, '!.!', MAC, 0)).toBeNull()
    expect(await openWaitToken(key, 'x'.repeat(1300), MAC, 0)).toBeNull()
    const badId = await sealWaitToken(key, {
      id: 'short',
      macId: MAC,
      redirect: REDIRECT,
      exp: Date.now() + 60_000,
    })
    expect(await openWaitToken(key, badId, MAC, Date.now())).toBeNull()

    h.limits.poll.set(false)
    expect((await frontDoor(req(`https://${HOST}${next}`), h.door)).status).toBe(429)
    h.limits.signIn.set(false)
    expect((await frontDoor(req(authorize()), h.door)).status).toBe(429)
  })

  it('needs exactly one https redirect URI and a GET', async () => {
    const h = await harness()
    expect((await frontDoor(req(`https://${HOST}/authorize?client_id=c1`), h.door)).status).toBe(400)
    expect((await frontDoor(req(`https://${HOST}/authorize`), h.door)).status).toBe(400)
    expect(
      (await frontDoor(req(`https://${HOST}/authorize?redirect_uri=http%3A%2F%2Fx.test%2F`), h.door)).status,
    ).toBe(400)
    expect((await frontDoor(req(`https://${HOST}/authorize?redirect_uri=nope`), h.door)).status).toBe(400)
    expect(
      (await frontDoor(req(`${authorize()}&redirect_uri=${encodeURIComponent('https://two.test/')}`), h.door))
        .status,
    ).toBe(400)
    expect((await frontDoor(req(authorize(), { method: 'POST', body: '' }), h.door)).status).toBe(405)
    expect(h.consents).toEqual([])
  })

  it('works without a configured secret, with a key of its own', async () => {
    const key = await waitKey(undefined)
    const token = await sealWaitToken(key, {
      id: 'A'.repeat(20),
      macId: MAC,
      redirect: REDIRECT,
      exp: Date.now() + 1000,
    })
    expect(await openWaitToken(key, token, MAC, Date.now())).toMatchObject({ redirect: REDIRECT })
  })
})

describe('the recovery page', () => {
  const ORIGIN = `https://${HOST}`
  const post = (body: string, headers: Record<string, string> = {}) =>
    req(`${ORIGIN}/recover`, {
      method: 'POST',
      body,
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    })

  it('shows a form that posts only to itself, and never takes the code in a URL', async () => {
    const h = await harness()
    const page = await frontDoor(req(`${ORIGIN}/recover`), h.door)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self'")
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    const text = await page.text()
    expect(text).toContain('<form method="post" action="/recover">')
    expect(text).not.toContain('<script')
    expect((await frontDoor(req(`${ORIGIN}/recover?code=ABCD`), h.door)).status).toBe(400)
    expect((await frontDoor(req(`${ORIGIN}/recover`, { method: 'PUT' }), h.door)).status).toBe(405)
    // Not on the bare relay host, and never forwarded to the Mac.
    expect((await frontDoor(req('https://relay.test/recover'), h.door)).status).toBe(404)
    expect(h.forwarded).toEqual([])
    expect(h.recoveries).toEqual([])
  })

  it('locks with the code, and says nothing about whether a Mac has one', async () => {
    const h = await harness()
    const done = await frontDoor(post('code=RKQ4-7MXT-PW9C-3HJD&phones=remove'), h.door)
    expect(done.status).toBe(200)
    expect(await done.text()).toContain('every paired phone was removed')
    expect(h.recoveries).toEqual([{ code: 'RKQ4-7MXT-PW9C-3HJD', unregisterPhones: true }])
    expect(await (await frontDoor(post('code=x'), h.door)).text()).toContain('locked down at the relay')
    expect(h.recoveries.at(-1)?.unregisterPhones).toBe(false)

    h.recoverResult = 'wrong'
    const wrong = await frontDoor(post('code=x'), h.door)
    h.recoverResult = 'unset'
    const unset = await frontDoor(post('code=x'), h.door)
    expect(wrong.status).toBe(403)
    expect(unset.status).toBe(403)
    expect(await unset.text()).toBe(await wrong.text())
    h.recoverResult = 'too-many'
    expect((await frontDoor(post('code=x'), h.door)).status).toBe(429)
  })

  it('refuses posts from elsewhere, other bodies, big bodies and floods', async () => {
    const h = await harness()
    expect((await frontDoor(post('code=x', { origin: 'https://evil.test' }), h.door)).status).toBe(403)
    const noOrigin = req(`${ORIGIN}/recover`, {
      method: 'POST',
      body: 'code=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect((await frontDoor(noOrigin, h.door)).status).toBe(403)
    expect(
      (await frontDoor(post('{"code":"x"}', { 'content-type': 'application/json' }), h.door)).status,
    ).toBe(415)
    expect((await frontDoor(post(`code=${'x'.repeat(2000)}`), h.door)).status).toBe(413)
    expect(h.recoveries).toEqual([])
    h.limits.signIn.set(false)
    expect((await frontDoor(post('code=x'), h.door)).status).toBe(429)
    expect(h.limits.signIn.keys.at(-1)).toBe(`recover:${MAC}:203.0.113.5`)
    expect(h.recoveries).toEqual([])
  })
})

describe('red-team regressions', () => {
  it('refuses a body on DELETE /mcp (fetch itself refuses one on GET)', async () => {
    const h = await harness()
    const smuggled = req(`https://${HOST}/mcp`, { method: 'DELETE', body: 'GET /admin HTTP/1.1' })
    expect((await frontDoor(smuggled, h.door)).status).toBe(400)
    expect(h.forwarded).toEqual([])
    expect((await frontDoor(req(`https://${HOST}/mcp`, { method: 'DELETE' }), h.door)).status).toBe(200)
  })
})

describe('the waiting page', () => {
  it('says roughly when the sign-in ends, from the Mac’s expiry', async () => {
    const h = await harness()
    ;(h.door as { now?: () => number }).now = () => Date.parse('2026-11-12T03:00:00.000Z')
    h.answer = { state: 'waiting', code: 'ABCD-EFGH', expiresAt: '2026-11-12T03:09:40.000Z' }
    const url = `https://${HOST}/authorize?response_type=code&client_id=c1&redirect_uri=${encodeURIComponent(REDIRECT)}`
    const page = await frontDoor(req(url), h.door)
    expect(await page.text()).toContain('ends in about 10 minutes')
  })
})
