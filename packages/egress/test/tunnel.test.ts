// Tunnels for raw adapters: exact endpoints, an SNI check before anything is dialled, the upload
// budget on every byte, pacing per connection, and everything closed when the call ends.

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { type FakeApi, startFakeApi } from '@valet/fake-http-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ConnectionRecord, EgressBroker, type RunContext } from '../src/broker'
import type { Lookup } from '../src/dial'
import { RunMeter } from '../src/meter'
import { parseEndpoint } from '../src/tunnel'

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

const broker = () =>
  new EgressBroker(
    {
      egress: [],
      endpoints: ['api.example.test:443', 'plain.example.test:7000'],
      privateHosts: [{ address: '10.0.0.5', port: 8123, scheme: 'http' }],
    },
    {
      lookup: loopback,
      testing: {
        allowAddresses: ['127.0.0.1'],
        route: (address, port) =>
          address === '10.0.0.5' || port === 7000
            ? { address: '127.0.0.1', port: plain.port }
            : { address: '127.0.0.1', port: api.port },
      },
    },
  )

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

/** An HTTPS GET through a tunnel port, as an npm package would make it. */
function httpsThrough(port: number, servername: string, path = '/v1/items'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, servername, ca: api.cert as string })
    let text = ''
    socket.on('secureConnect', () =>
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`),
    )
    socket.on('data', (c: Buffer) => (text += c.toString()))
    socket.on('end', () => resolve(text))
    socket.on('close', () => resolve(text))
    socket.on('error', reject)
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('tunnels', () => {
  it('carries a TLS connection with the endpoint’s SNI to the endpoint', async () => {
    const r = run()
    const tunnels = await broker().tunnels(r)(['api.example.test:443'])
    const port = tunnels.ports.get('api.example.test:443') as number
    const response = await httpsThrough(port, 'api.example.test')
    expect(response).toMatch(/^HTTP\/1.1 200/)
    await settle()
    expect(r.records).toEqual([
      expect.objectContaining({ endpoint: 'api.example.test:443', kind: 'tunnel', errorClass: null }),
    ])
    expect(r.records[0]?.bytesUp).toBeGreaterThan(100)
    tunnels.close()
  })

  it('refuses another SNI before anything is dialled', async () => {
    const r = run()
    const before = api.seen.length
    const tunnels = await broker().tunnels(r)(['api.example.test:443'])
    const port = tunnels.ports.get('api.example.test:443') as number
    await httpsThrough(port, 'evil.example.test').catch(() => '')
    await settle()
    expect(r.records).toEqual([expect.objectContaining({ errorClass: 'sni-mismatch', bytesUp: 0 })])
    expect(api.seen.length).toBe(before)
    tunnels.close()
  })

  it('refuses plain bytes on a TLS endpoint', async () => {
    const r = run()
    const tunnels = await broker().tunnels(r)(['api.example.test:443'])
    const port = tunnels.ports.get('api.example.test:443') as number
    await new Promise<void>((resolve) => {
      const s = netConnect({ host: '127.0.0.1', port }, () =>
        s.write('GET / HTTP/1.1\r\nHost: evil.example.test\r\n\r\n'),
      )
      s.on('close', () => resolve())
      s.on('error', () => {})
    })
    expect(r.records).toEqual([expect.objectContaining({ errorClass: 'sni-mismatch' })])
    tunnels.close()
  })

  it('carries plain TCP only where the caller says the endpoint has no TLS', async () => {
    const r = run()
    const tunnels = await broker().tunnels(r, { plainTcp: ['plain.example.test:7000'] })([
      'plain.example.test:7000',
      '10.0.0.5:8123',
    ])
    for (const key of ['plain.example.test:7000', '10.0.0.5:8123']) {
      const port = tunnels.ports.get(key) as number
      const text = await new Promise<string>((resolve) => {
        let out = ''
        const s = netConnect({ host: '127.0.0.1', port }, () =>
          s.write('GET /v1/items HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
        )
        s.on('data', (c: Buffer) => (out += c.toString()))
        s.on('close', () => resolve(out))
        s.on('error', () => {})
      })
      expect(text, key).toMatch(/^HTTP\/1.1 200/)
    }
    tunnels.close()
  })

  it('refuses an endpoint it doesn’t know, or one written another way, before listening', async () => {
    for (const endpoint of [
      'other.example.test:443',
      'api.example.test:8443',
      'API.example.test:443x',
      '10.0.0.5:8124',
      '[10.0.0.5]:8123',
    ]) {
      await expect(broker().tunnels(run())([endpoint]), endpoint).rejects.toMatchObject({
        errorClass: 'host-not-allowed',
      })
    }
  })

  it('closes a connection that sends past the budget', async () => {
    const r = run(1024)
    const tunnels = await broker().tunnels(r, { plainTcp: ['plain.example.test:7000'] })([
      'plain.example.test:7000',
    ])
    const port = tunnels.ports.get('plain.example.test:7000') as number
    await new Promise<void>((resolve) => {
      const s = netConnect({ host: '127.0.0.1', port }, () => s.write(Buffer.alloc(5000, 120)))
      s.on('close', () => resolve())
      s.on('error', () => {})
    })
    await settle()
    expect(r.records).toEqual([expect.objectContaining({ errorClass: 'upload-budget' })])
    expect(r.meter.bytesUp).toBeLessThanOrEqual(1024)
    tunnels.close()
  })

  it('paces each connection, and refuses one the pacing refuses', async () => {
    const r = run()
    let admitted = 0
    const tunnels = await broker().tunnels(r, {
      admit: async () => {
        admitted++
        if (admitted > 1) throw new Error('breaker open')
      },
    })(['api.example.test:443'])
    const port = tunnels.ports.get('api.example.test:443') as number
    expect(await httpsThrough(port, 'api.example.test')).toMatch(/200/)
    await httpsThrough(port, 'api.example.test').catch(() => '')
    await settle()
    expect(r.records.map((x) => x.errorClass)).toEqual([null, 'rate-limited'])
    tunnels.close()
  })

  it('closes everything when the call ends', async () => {
    const r = run()
    const tunnels = await broker().tunnels(r)(['api.example.test:443'])
    const port = tunnels.ports.get('api.example.test:443') as number
    r.controller.abort()
    await settle()
    const refused = await new Promise<boolean>((resolve) => {
      const s = netConnect({ host: '127.0.0.1', port })
      s.on('connect', () => resolve(false))
      s.on('error', () => resolve(true))
    })
    expect(refused).toBe(true)
  })
})

describe('parseEndpoint', () => {
  it.each([
    ['api.example.com:443', { host: 'api.example.com', port: 443 }],
    ['API.example.com:993', { host: 'api.example.com', port: 993 }],
    ['fd00::5:22', { host: 'fd00::5', port: 22 }],
    ['10.0.0.5:8123', { host: '10.0.0.5', port: 8123 }],
    ['api.example.com', null],
    ['api.example.com:0', null],
    ['api.example.com:70000', null],
    ['*.example.com:443', null],
    ['[fd00::5]:22', null],
    ['010.0.0.5:22', null],
  ])('%s', (value, expected) => {
    expect(parseEndpoint(value)).toEqual(expected)
  })
})
