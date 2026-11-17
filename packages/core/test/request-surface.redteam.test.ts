// Red-team PoCs for core's request surface and address classification. Each `it` states what
// SHOULD hold; a failing test is a demonstrated hole.

import { describe, expect, it } from 'vitest'
import { isPrivateHostAddress, isPublicAddress } from '../src/addresses'
import { decideRequest } from '../src/request-surface'

const hosts = ['api.example.com']
const writeAny = [
  { method: 'POST', host: 'api.example.com', path: '/api/orders/:id/:action', purpose: 'write' as const },
]

describe('RC-1 deny segments miss a format suffix', () => {
  // Rails routes /orders/1/pay.json to #pay, Spring MVC (suffix pattern match, default before 5.3)
  // maps /pay.json to /pay, many PHP routers strip an extension. The deny list is the backstop that
  // keeps a broad write declaration from moving money unless it is declared irreversible.
  it.each(['pay', 'pay.json', 'checkout.json', 'transfer.xml', 'pay%2Ejson'])(
    'refuses /api/orders/1/%s on a write declaration',
    (action) => {
      const d = decideRequest('POST', `https://api.example.com/api/orders/1/${action}`, hosts, writeAny)
      expect(d).toEqual({ allowed: false, reason: 'denied-path' })
    },
  )
})

describe('RC-2 IPv4-translated IPv6 (SIIT, ::ffff:0:a.b.c.d) is classified public', () => {
  // embeddedIPv4 unwraps ::ffff:a.b.c.d and ::a.b.c.d but not ::ffff:0:a.b.c.d (RFC 2765/6052).
  // Where a SIIT/NAT64 translator is on path, this reaches the embedded IPv4 address.
  it.each(['::ffff:0:7f00:1', '::ffff:0:a00:1', '::ffff:0:c0a8:101'])('%s is not public', (a) => {
    expect(isPublicAddress(a)).toBe(false)
  })
})

describe('RC-3 a private host may be an address this Mac itself serves', () => {
  // 100.64.0.0/10 is allowed for VPN overlays, but Tailscale's 100.100.100.100 (and
  // fd7a:115c:a1e0::53) is answered by tailscaled on this Mac, not another machine, and is never
  // one of ownAddresses(). So "never this Mac" holds only for interface addresses.
  it.each(['100.100.100.100', 'fd7a:115c:a1e0::53'])('%s is not a private host', (a) => {
    expect(isPrivateHostAddress(a)).toBe(false)
  })
})
