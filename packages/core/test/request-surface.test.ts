import { describe, expect, it } from 'vitest'
import {
  decideRequest,
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
