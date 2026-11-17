// Red-team PoCs for the egress broker. Each `it` states what SHOULD hold; a failing test is a
// demonstrated hole. Harness as broker.test.ts.

import { type FakeApi, startFakeApi } from '@valet/fake-http-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ConnectionRecord, EgressBroker, type RunContext } from '../src/broker'
import { dial } from '../src/dial'
import { RunMeter } from '../src/meter'

let api: FakeApi
beforeAll(async () => {
  api = await startFakeApi()
})
afterAll(async () => {
  await api.close()
})

function run(budget = 64 * 1024): RunContext & { records: ConnectionRecord[] } {
  const controller = new AbortController()
  const records: ConnectionRecord[] = []
  return { meter: new RunMeter(budget), signal: controller.signal, record: (r) => records.push(r), records }
}

describe('RB-1 a public name that resolves to one of this Mac’s own addresses', () => {
  // app.ts promises "never this Mac's own addresses", and dial() checks ownAddresses for a private
  // host, but not for a public one. A Mac usually has a global IPv6 address (and sometimes a public
  // IPv4); an agent-controlled DNS name pointing at it dials the Mac itself (and with a raw tunnel
  // and plainTcp, any port the manifest names). The same goes for LAN devices' global IPv6 addresses.
  const MAC_GLOBAL_V6 = '2a00:1450:4001:82a::200e'
  it('refuses it as host-not-allowed', async () => {
    const attempt = dial(
      { kind: 'public', host: 'api.example.test', port: 443 },
      {
        lookup: (_n, cb) => cb(null, [{ address: MAC_GLOBAL_V6, family: 6 }]),
        ownAddresses: () => ['192.168.1.99', MAC_GLOBAL_V6],
        testing: { ca: api.cert as string, route: () => ({ address: '127.0.0.1', port: api.port }) },
      },
    ).then(
      (s) => {
        s.destroy()
        return 'dialled'
      },
      (e: { errorClass?: string }) => e.errorClass,
    )
    expect(await attempt).toBe('host-not-allowed')
  })
})

describe('RB-2 WebSocket subprotocols are sent but not spent from the upload budget', () => {
  it('spends at least the bytes the handshake carries', async () => {
    const broker = new EgressBroker(
      { egress: ['api.example.test'] },
      {
        lookup: (_n, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
        testing: {
          allowAddresses: ['127.0.0.1'],
          ca: api.cert as string,
          route: () => ({ address: '127.0.0.1', port: api.port }),
        },
      },
    )
    const r = run()
    // 8 tokens of 64 chars: what guarded-http's snapshotSocket allows.
    const protocols = Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(64, 'Q'))
    const socket = await broker.websocket(new URL('https://api.example.test/ws/echo'), { protocols }, r)
    const seen = api.seen.at(-1)
    socket.close()
    // What the server received in headers alone (name: value\r\n), plus the request line.
    let wire = `GET /ws/echo HTTP/1.1\r\n`.length + 2
    for (const [name, value] of Object.entries(seen?.headers ?? {}))
      wire += name.length + String(value).length + 4
    expect(seen?.headers['sec-websocket-protocol']).toContain(protocols[7])
    expect(r.meter.bytesUp).toBeGreaterThanOrEqual(wire)
  })
})
