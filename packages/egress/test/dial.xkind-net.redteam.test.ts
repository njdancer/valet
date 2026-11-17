// Red team (cross-kind network boundaries, 2026-11-17). Each `it` states what SHOULD hold; a failing
// test is a demonstrated hole. Harness as broker.redteam.test.ts (RB-1).

import { type FakeApi, startFakeApi } from '@valet/fake-http-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dial } from '../src/dial'

let api: FakeApi
beforeAll(async () => {
  api = await startFakeApi()
})
afterAll(async () => {
  await api.close()
})

describe('XK-1 a public name answering with this Mac’s own public IPv4, written IPv4-mapped', () => {
  // RB-1 was fixed by comparing the canonical form of each answer with this Mac's own addresses. An
  // AAAA record of `::ffff:a.b.c.d` canonicalises to `::ffff:xxxx:xxxx`, never to `a.b.c.d`, so it
  // isn't seen as one of them; isPublicAddress unwraps it and finds it public, and a dual-stack
  // socket to it reaches a.b.c.d: this Mac. (A Mac with a public IPv4 on an interface: no NAT, many
  // university, office and VPS-style networks, or a VPN that hands out public addresses.)
  const MAC_PUBLIC_V4 = '93.184.216.34'
  it('refuses it as host-not-allowed, as the plain IPv4 answer is', async () => {
    const attempt = (address: string, family: 4 | 6) =>
      dial(
        { kind: 'public', host: 'api.example.test', port: 443 },
        {
          lookup: (_n, cb) => cb(null, [{ address, family }]),
          ownAddresses: () => ['192.168.1.99', MAC_PUBLIC_V4],
          // Where it would have gone, had the checks passed: the fake server (no real network).
          testing: { ca: api.cert as string, route: () => ({ address: '127.0.0.1', port: api.port }) },
        },
      ).then(
        (s) => {
          s.destroy()
          return 'dialled'
        },
        (e: { errorClass?: string }) => e.errorClass,
      )
    // Control: the plain form is refused (RB-1's fix).
    expect(await attempt(MAC_PUBLIC_V4, 4)).toBe('host-not-allowed')
    // The same address, mapped.
    expect(await attempt(`::ffff:${MAC_PUBLIC_V4}`, 6)).toBe('host-not-allowed')
  })
})
