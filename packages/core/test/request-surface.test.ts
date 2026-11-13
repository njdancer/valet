import { describe, expect, it } from 'vitest'
import {
  ambiguousPath,
  decideRequest,
  declarationOnHost,
  describeDeclaration,
  pathMatches,
  type RequestDeclaration,
  touchesDeniedSegment,
} from '../src/request-surface'

describe('pathMatches', () => {
  it('matches literal paths case-insensitively', () => {
    expect(pathMatches('/apis/ui/Trolley', '/apis/ui/trolley')).toBe(true)
  })

  it('requires the same number of segments', () => {
    expect(pathMatches('/apis/ui/Trolley', '/apis/ui/Trolley/Items')).toBe(false)
    expect(pathMatches('/apis/ui/Trolley/Items', '/apis/ui/Trolley')).toBe(false)
  })

  it('matches one segment for a :param', () => {
    expect(pathMatches('/apis/ui/product/detail/:stockcode', '/apis/ui/product/detail/123')).toBe(true)
    expect(pathMatches('/apis/ui/product/detail/:stockcode', '/apis/ui/product/detail/1/2')).toBe(false)
  })

  it('matches any remainder for a trailing *', () => {
    expect(pathMatches('/apis/ui/browse/*', '/apis/ui/browse/a/b/c')).toBe(true)
    expect(pathMatches('/apis/ui/browse/*', '/apis/ui/browse')).toBe(true)
  })

  it('treats * anywhere but the end as a literal segment', () => {
    expect(pathMatches('/a/*/c', '/a/b/c')).toBe(false)
    expect(pathMatches('/a/*/c', '/a/*/c')).toBe(true)
  })

  it('ignores the query string and trailing slashes', () => {
    expect(pathMatches('/apis/ui/Search/products', '/apis/ui/Search/products/?q=milk')).toBe(true)
  })
})

describe('touchesDeniedSegment', () => {
  it('flags payment and checkout segments in any case', () => {
    expect(touchesDeniedSegment('/api/v3/ui/Checkout/submit')).toBe(true)
    expect(touchesDeniedSegment('/apis/ui/PAYMENT')).toBe(true)
    expect(touchesDeniedSegment('/banking/payees/new')).toBe(true)
  })

  it('does not flag segments that merely contain a denied word', () => {
    expect(touchesDeniedSegment('/apis/ui/paymentmethods-help')).toBe(false)
    expect(touchesDeniedSegment('/apis/ui/Trolley')).toBe(false)
  })
})

describe('decideRequest', () => {
  const hosts = ['www.example.com', '*.api.example.com']
  const declarations: RequestDeclaration[] = [
    { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' },
    { method: 'POST', path: '/api/v3/ui/trolley/update', purpose: 'write' },
    { method: 'POST', path: '/api/checkout/payment', purpose: 'write' },
    { method: 'POST', path: '/api/checkout/place', purpose: 'irreversible' },
  ]

  it('allows a declared request and returns its declaration', () => {
    const decision = decideRequest('get', 'https://www.example.com/apis/ui/Trolley', hosts, declarations)
    expect(decision).toEqual({ allowed: true, declaration: declarations[0] })
  })

  it('matches methods exactly, not just paths', () => {
    expect(decideRequest('DELETE', 'https://www.example.com/apis/ui/Trolley', hosts, declarations)).toEqual({
      allowed: false,
      reason: 'undeclared',
    })
  })

  it('rejects hosts outside the egress allowlist', () => {
    expect(decideRequest('GET', 'https://evil.test/apis/ui/Trolley', hosts, declarations)).toEqual({
      allowed: false,
      reason: 'host-not-allowed',
    })
  })

  it('rejects plain http even on an allowed host', () => {
    expect(decideRequest('GET', 'http://www.example.com/apis/ui/Trolley', hosts, declarations)).toEqual({
      allowed: false,
      reason: 'host-not-allowed',
    })
  })

  it('rejects unparseable URLs', () => {
    expect(decideRequest('GET', '/relative', hosts, declarations)).toEqual({
      allowed: false,
      reason: 'bad-url',
    })
  })

  it('denies payment paths declared as mere writes', () => {
    expect(
      decideRequest('POST', 'https://www.example.com/api/checkout/payment', hosts, declarations),
    ).toEqual({
      allowed: false,
      reason: 'denied-path',
    })
  })

  it('lets an irreversible declaration through a denied path', () => {
    const decision = decideRequest('POST', 'https://www.example.com/api/checkout/place', hosts, declarations)
    expect(decision.allowed).toBe(true)
  })
})

describe('declarations tied to a host', () => {
  const hosts = ['news.example.com', 'api.example.net']
  const declarations: RequestDeclaration[] = [
    { method: 'GET', host: 'api.example.net', path: '/v0/item/:id', purpose: 'read' },
    { method: 'GET', path: '/v0/any', purpose: 'read' },
  ]

  it('applies a declaration with a host on that host only', () => {
    expect(decideRequest('GET', 'https://api.example.net/v0/item/101.json', hosts, declarations)).toEqual({
      allowed: true,
      declaration: declarations[0],
    })
    expect(decideRequest('GET', 'https://API.example.net/v0/item/101', hosts, declarations).allowed).toBe(
      true,
    )
    expect(decideRequest('GET', 'https://news.example.com/v0/item/101.json', hosts, declarations)).toEqual({
      allowed: false,
      reason: 'undeclared',
    })
  })

  it('applies a declaration without a host on every egress host', () => {
    for (const host of hosts)
      expect(decideRequest('GET', `https://${host}/v0/any`, hosts, declarations).allowed, host).toBe(true)
  })

  it('matches a :param against one whole segment, suffix and all, never more', () => {
    expect(pathMatches('/v0/item/:id', '/v0/item/101.json')).toBe(true)
    expect(pathMatches('/v0/item/:id', '/v0/item/101/kids')).toBe(false)
  })

  it('describes a declaration with its host', () => {
    expect(describeDeclaration(declarations[0] as RequestDeclaration)).toBe('GET api.example.net/v0/item/:id')
    expect(describeDeclaration(declarations[1] as RequestDeclaration)).toBe('GET /v0/any')
    expect(declarationOnHost({}, 'x.example.com')).toBe(true)
  })
})

describe('encoded and ambiguous paths', () => {
  const hosts = ['www.example.com']
  const declarations: RequestDeclaration[] = [
    { method: 'POST', path: '/api/:section/items', purpose: 'write' },
    { method: 'GET', path: '/api/product/:id', purpose: 'read' },
  ]

  it('catches a deny segment hidden by percent-encoding', () => {
    expect(touchesDeniedSegment('/api/check%6Fut/items')).toBe(true)
    expect(
      decideRequest('POST', 'https://www.example.com/api/check%6Fut/items', hosts, declarations),
    ).toEqual({
      allowed: false,
      reason: 'denied-path',
    })
  })

  it('catches a deny segment behind matrix parameters', () => {
    expect(touchesDeniedSegment('/api/checkout;jsessionid=1/items')).toBe(true)
  })

  it('refuses encoded slashes, backslashes and NULs inside a segment', () => {
    for (const path of ['/api/product/..%2F..%2Fcheckout', '/api/product/a%5Cb', '/api/product/a%00']) {
      expect(ambiguousPath(path), path).toBe(true)
      expect(decideRequest('GET', `https://www.example.com${path}`, hosts, declarations), path).toEqual({
        allowed: false,
        reason: 'ambiguous-path',
      })
    }
  })

  it('refuses segments that decode to dot segments', () => {
    expect(ambiguousPath('/api/product/%2e%2e')).toBe(true)
    expect(ambiguousPath('/api/product/%2E')).toBe(true)
  })

  it('leaves ordinary encoded values alone', () => {
    expect(ambiguousPath('/api/product/milk%20full%20cream')).toBe(false)
    expect(
      decideRequest('GET', 'https://www.example.com/api/product/a%20b', hosts, declarations).allowed,
    ).toBe(true)
  })
})
