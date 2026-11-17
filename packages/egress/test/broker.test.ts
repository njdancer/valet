// The egress broker against a fake API on loopback (docs/adapter-kinds.md#f1-the-egress-broker).
// The fake has a test certificate for api.example.test; the broker is pointed at it through the
// test-only `testing` options, which act after every check, as the real network would.

import { createHash, X509Certificate } from 'node:crypto'
import { type FakeApi, ITEMS, startFakeApi } from '@valet/fake-http-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ConnectionRecord, EgressBroker, type RunContext } from '../src/broker'
import type { Lookup } from '../src/dial'
import { RunMeter } from '../src/meter'

let api: FakeApi
let plain: FakeApi

beforeAll(async () => {
  api = await startFakeApi()
  plain = await startFakeApi({ plain: true })
})
afterAll(async () => {
  await api.close()
  await plain.close()
})

const loopback: Lookup = (_name, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])

function broker(
  extra: Partial<ConstructorParameters<typeof EgressBroker>[0]> = {},
  lookup: Lookup = loopback,
) {
  return new EgressBroker(
    { egress: ['api.example.test'], ...extra },
    {
      lookup,
      ownAddresses: () => ['192.168.1.99'],
      testing: {
        allowAddresses: ['127.0.0.1'],
        ca: api.cert as string,
        route: (address, port) => {
          if (address === '127.0.0.1' && port === 443) return { address, port: api.port }
          if (address === '10.0.0.5') return { address: '127.0.0.1', port: plain.port }
          if (address === '10.0.0.6') return { address: '127.0.0.1', port: api.port }
          return { address, port }
        },
      },
    },
  )
}

function run(budget = 64 * 1024): RunContext & { records: ConnectionRecord[]; controller: AbortController } {
  const controller = new AbortController()
  const records: ConnectionRecord[] = []
  return {
    meter: new RunMeter(budget),
    signal: controller.signal,
    record: (r) => records.push(r),
    records,
    controller,
  }
}

const get = { method: 'GET', headers: {}, body: null }
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { stage?: string; errorClass?: string }) => `${e.stage}/${e.errorClass}`,
  )

describe('fetch', () => {
  it('reaches an exact endpoint, with SNI and Host set to its name, and records the connection', async () => {
    const r = run()
    const result = await broker().fetch(new URL('https://api.example.test/v1/items'), get, r)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body.toString())).toEqual({ items: ITEMS })
    expect(result.headers['set-cookie']).toBeUndefined()
    const seen = api.seen.at(-1)
    expect(seen?.servername).toBe('api.example.test')
    expect(seen?.headers['host']).toBe('api.example.test')
    expect(r.records).toEqual([
      expect.objectContaining({ endpoint: 'api.example.test:443', kind: 'https', errorClass: null }),
    ])
    expect(r.records[0]?.bytesDown).toBeGreaterThan(0)
    expect(r.meter.bytesUp).toBe(r.records[0]?.bytesUp)
  })

  it.each([
    'https://other.example.test/v1/items',
    'https://api.example.test:8443/v1/items',
    'http://api.example.test/v1/items',
    'https://user:pw@api.example.test/v1/items',
    'https://127.0.0.1/v1/items',
    'https://API.example.test.evil.test/v1/items',
    'ftp://api.example.test/',
  ])('refuses %s before any connection', async (url) => {
    const before = api.seen.length
    const r = run()
    expect(await outcome(broker().fetch(new URL(url), get, r))).toBe('egress/host-not-allowed')
    expect(api.seen.length).toBe(before)
    expect(r.records).toEqual([])
  })

  it('refuses a name that resolves to a private address, or to both kinds', async () => {
    for (const answers of [
      [{ address: '10.0.0.1', family: 4 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.2', family: 4 },
      ],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
      [{ address: '169.254.169.254', family: 4 }],
    ]) {
      const lookup: Lookup = (_n, cb) => cb(null, answers)
      const r = run()
      expect(
        await outcome(broker({}, lookup).fetch(new URL('https://api.example.test/v1/items'), get, r)),
      ).toBe('egress/host-not-allowed')
    }
  })

  it('verifies the certificate against the name', async () => {
    const wrong = new EgressBroker(
      { egress: ['wrong.example.test'] },
      {
        lookup: loopback,
        testing: {
          allowAddresses: ['127.0.0.1'],
          ca: api.cert as string,
          route: () => ({ address: '127.0.0.1', port: api.port }),
        },
      },
    )
    expect(await outcome(wrong.fetch(new URL('https://wrong.example.test/v1/items'), get, run()))).toBe(
      'egress/unavailable',
    )
    const untrusted = new EgressBroker(
      { egress: ['api.example.test'] },
      {
        lookup: loopback,
        testing: { allowAddresses: ['127.0.0.1'], route: () => ({ address: '127.0.0.1', port: api.port }) },
      },
    )
    expect(await outcome(untrusted.fetch(new URL('https://api.example.test/v1/items'), get, run()))).toBe(
      'egress/unavailable',
    )
  })

  it('returns a redirect unfollowed', async () => {
    const result = await broker().fetch(new URL('https://api.example.test/v1/redirect'), get, run())
    expect(result.status).toBe(302)
    expect(result.headers['location']).toBe('https://evil.example.test/steal')
  })

  it('caps the response, declared or not, and never decompresses', async () => {
    expect(await outcome(broker().fetch(new URL('https://api.example.test/v1/big'), get, run()))).toBe(
      'tool-run/unexpected-shape',
    )
    expect(
      await outcome(broker().fetch(new URL('https://api.example.test/v1/big-declared'), get, run())),
    ).toBe('tool-run/unexpected-shape')
    expect(await outcome(broker().fetch(new URL('https://api.example.test/v1/endless'), get, run()))).toBe(
      'tool-run/unexpected-shape',
    )
    const bomb = await broker().fetch(new URL('https://api.example.test/v1/gzip-bomb'), get, run())
    expect(bomb.headers['content-encoding']).toBe('gzip')
    expect(bomb.body.byteLength).toBeLessThan(4 * 1024 * 1024)
    expect(
      await outcome(broker().fetch(new URL('https://api.example.test/v1/headers-flood'), get, run())),
    ).toBe('egress/unavailable')
  })

  it('times out a server that never answers, and stops when the run aborts', async () => {
    const slow = new EgressBroker(
      { egress: ['api.example.test'] },
      {
        lookup: loopback,
        timeoutMs: 300,
        testing: {
          allowAddresses: ['127.0.0.1'],
          ca: api.cert as string,
          route: () => ({ address: '127.0.0.1', port: api.port }),
        },
      },
    )
    expect(await outcome(slow.fetch(new URL('https://api.example.test/v1/hang'), get, run()))).toBe(
      'tool-run/timed-out',
    )
    const r = run()
    const pending = broker().fetch(new URL('https://api.example.test/v1/hang'), get, r)
    setTimeout(() => r.controller.abort(), 100)
    expect(await outcome(pending)).toBe('tool-run/aborted')
  })

  it('sends WebDAV methods and bodies', async () => {
    const result = await broker().fetch(
      new URL('https://api.example.test/calendars/alex/'),
      {
        method: 'PROPFIND',
        headers: { depth: '1', 'content-type': 'application/xml' },
        body: Buffer.from('<propfind/>'),
      },
      run(),
    )
    expect(result.status).toBe(207)
    expect(api.seen.at(-1)).toMatchObject({ method: 'PROPFIND', body: '<propfind/>' })
  })
})

describe('the upload budget', () => {
  it('spends a request’s bytes before it is sent, and refuses one that does not fit, sending nothing', async () => {
    const before = api.seen.length
    const r = run(2048)
    const body = Buffer.alloc(4096, 120)
    expect(
      await outcome(
        broker().fetch(new URL('https://api.example.test/v1/echo'), { method: 'POST', headers: {}, body }, r),
      ),
    ).toBe('egress/upload-budget')
    expect(api.seen.length).toBe(before)
    expect(r.meter.bytesUp).toBe(0)
  })

  it('counts the query string, so a read can’t carry data out in its URLs', async () => {
    const r = run(4096)
    const b = broker()
    let sent = 0
    let refused = false
    for (let i = 0; i < 20 && !refused; i++) {
      const outcomeOf = await outcome(
        b.fetch(new URL(`https://api.example.test/v1/items?q=${'s'.repeat(500)}`), get, r),
      )
      if (outcomeOf === 'egress/upload-budget') refused = true
      else sent++
    }
    expect(refused).toBe(true)
    expect(sent).toBeLessThan(8)
    expect(r.meter.bytesUp).toBeLessThanOrEqual(4096)
  })

  it('earns 1 KB more for each 100 KB received', async () => {
    const r = run(2048)
    await broker().fetch(new URL('https://api.example.test/v1/download?bytes=1048576'), get, r)
    expect(r.meter.allowance()).toBe(2048 + 10 * 1024)
  })
})

describe('private hosts', () => {
  const homeHub = { address: '10.0.0.5', port: 8123, scheme: 'http' as const }

  it('reaches a declared private host over plain http, keyed as declared', async () => {
    const r = run()
    const result = await broker({ egress: [], privateHosts: [homeHub] }).fetch(
      new URL('http://10.0.0.5:8123/v1/items'),
      get,
      r,
    )
    expect(result.status).toBe(200)
    expect(plain.seen.at(-1)?.headers['host']).toBe('10.0.0.5:8123')
    expect(r.records[0]).toMatchObject({ endpoint: '10.0.0.5:8123', kind: 'http' })
  })

  it('refuses another port, scheme or address', async () => {
    const b = broker({ egress: [], privateHosts: [homeHub] })
    for (const url of [
      'http://10.0.0.5:8124/v1/items',
      'https://10.0.0.5:8123/v1/items',
      'http://10.0.0.6:8123/v1/items',
    ]) {
      expect(await outcome(b.fetch(new URL(url), get, run())), url).toBe('egress/host-not-allowed')
    }
  })

  it('refuses one of this Mac’s own addresses', async () => {
    const own = { address: '192.168.1.99', port: 8123, scheme: 'http' as const }
    expect(
      await outcome(
        broker({ egress: [], privateHosts: [own] }).fetch(
          new URL('http://192.168.1.99:8123/v1/items'),
          get,
          run(),
        ),
      ),
    ).toBe('egress/host-not-allowed')
  })

  it('accepts exactly the pinned certificate', async () => {
    const der = new X509Certificate(api.cert as string).raw
    const pin = createHash('sha256').update(der).digest('hex')
    const pinned = { address: '10.0.0.6', port: 8443, certSha256: pin }
    const ok = await broker({ egress: [], privateHosts: [pinned] }).fetch(
      new URL('https://10.0.0.6:8443/v1/items'),
      get,
      run(),
    )
    expect(ok.status).toBe(200)
    const wrongPin = { ...pinned, certSha256: 'a'.repeat(64) }
    const before = api.seen.length
    expect(
      await outcome(
        broker({ egress: [], privateHosts: [wrongPin] }).fetch(
          new URL('https://10.0.0.6:8443/v1/items'),
          get,
          run(),
        ),
      ),
    ).toBe('egress/unavailable')
    expect(api.seen.length).toBe(before)
  })

  it('refuses an unpinned private https host whose certificate does not verify', async () => {
    const unpinned = { address: '10.0.0.6', port: 8443 }
    expect(
      await outcome(
        broker({ egress: [], privateHosts: [unpinned] }).fetch(
          new URL('https://10.0.0.6:8443/v1/items'),
          get,
          run(),
        ),
      ),
    ).toBe('egress/unavailable')
  })
})

describe('websocket', () => {
  it('echoes messages, spends what it sends and closes when the run ends', async () => {
    const r = run()
    const socket = await broker().websocket(new URL('https://api.example.test/ws/echo'), {}, r)
    await socket.send(Buffer.from('hello'), false)
    const reply = await socket.receive(2000)
    expect(reply).toMatchObject({ kind: 'message', binary: false })
    expect(reply?.kind === 'message' && reply.data.toString()).toBe('hello')
    expect(r.meter.bytesUp).toBeGreaterThan(5)
    r.controller.abort()
    expect(socket.isClosed).toBe(true)
    expect(r.records).toEqual([
      expect.objectContaining({ endpoint: 'api.example.test:443', kind: 'websocket' }),
    ])
  })

  it('refuses a send past the budget and closes the socket', async () => {
    const r = run(4096)
    const socket = await broker().websocket(new URL('https://api.example.test/ws/echo'), {}, r)
    expect(await outcome(socket.send(Buffer.alloc(8000, 120), false))).toBe('egress/upload-budget')
    expect(socket.isClosed).toBe(true)
    r.controller.abort()
  })

  it('breaks a socket a server floods, and refuses an oversized message', async () => {
    const r = run()
    const flood = await broker().websocket(new URL('https://api.example.test/ws/flood'), {}, r)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await outcome(flood.receive(10))).toBe('tool-run/unexpected-shape')
    const huge = await broker().websocket(new URL('https://api.example.test/ws/huge'), {}, r)
    const first = await huge.receive(2000)
    expect(first).toMatchObject({ kind: 'closed' })
    r.controller.abort()
  })

  it('refuses a socket to an undeclared endpoint', async () => {
    expect(await outcome(broker().websocket(new URL('https://other.example.test/ws/echo'), {}, run()))).toBe(
      'egress/host-not-allowed',
    )
  })
})
