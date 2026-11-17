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
    expect(decision).toEqual({ allowed: true, declaration: declarations[0], host: 'www.example.com' })
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
      host: 'api.example.net',
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

describe('endpoints for http adapters', () => {
  const hosts = ['api.example.com']
  const privateHosts = [
    { address: '192.168.1.20', port: 8123, scheme: 'http' as const },
    { address: 'fd00::5', port: 443 },
  ]
  const declarations: RequestDeclaration[] = [
    { method: 'GET', host: 'api.example.com', path: '/v1/items', purpose: 'read' },
    { method: 'GET', host: 'api.example.com', path: '/v1/live', purpose: 'read', websocket: true },
    { method: 'GET', host: '192.168.1.20:8123', path: '/api/states', purpose: 'read' },
    { method: 'PROPFIND', host: '[fd00::5]:443', path: '/dav/', purpose: 'read' },
  ]
  const decide = (method: string, url: string, extra: { websocket?: boolean } = {}) =>
    decideRequest(method, url, hosts, declarations, { privateHosts, exactPort: true, ...extra })

  it('allows a private host on its own scheme and port, keyed as declared', () => {
    expect(decide('GET', 'http://192.168.1.20:8123/api/states')).toMatchObject({
      allowed: true,
      host: '192.168.1.20:8123',
      privateHost: privateHosts[0],
    })
    expect(decide('PROPFIND', 'https://[fd00::5]/dav/')).toMatchObject({
      allowed: true,
      host: '[fd00::5]:443',
    })
    expect(decide('PROPFIND', 'https://[fd00::5]:443/dav/')).toMatchObject({ allowed: true })
  })

  it.each([
    'https://192.168.1.20:8123/api/states',
    'http://192.168.1.20:8124/api/states',
    'http://192.168.1.20/api/states',
    'http://192.168.1.21:8123/api/states',
    'http://[::ffff:192.168.1.20]:8123/api/states',
    'http://user:pw@192.168.1.20:8123/api/states',
    'http://[fd00::5]:443/dav/',
    'https://[fd00::6]/dav/',
    // Octal: the URL parser reads 020 as 16.
    'http://192.168.1.020:8123/api/states',
  ])('refuses %s', (url) => {
    const method = url.includes('dav') ? 'PROPFIND' : 'GET'
    expect(decide(method, url)).toEqual({ allowed: false, reason: 'host-not-allowed' })
  })

  // The URL parser writes each of these as the declared address, so they are that address.
  it.each([
    'http://3232235796:8123/api/states',
    'http://0xc0a80114:8123/api/states',
    'https://[fd00:0:0::5]/dav/',
    'https://[FD00::5]/dav/',
  ])('takes %s as the declared address', (url) => {
    const method = url.includes('dav') ? 'PROPFIND' : 'GET'
    expect(decide(method, url).allowed).toBe(true)
  })

  it('holds a public host to port 443 when asked', () => {
    expect(decide('GET', 'https://api.example.com:8443/v1/items')).toEqual({
      allowed: false,
      reason: 'host-not-allowed',
    })
    expect(decide('GET', 'https://api.example.com:443/v1/items').allowed).toBe(true)
    expect(decide('GET', 'http://api.example.com/v1/items').allowed).toBe(false)
    expect(decide('GET', 'https://user@api.example.com/v1/items').allowed).toBe(false)
  })

  it('refuses an IP literal of a public host', () => {
    expect(decide('GET', 'https://93.184.216.34/v1/items')).toEqual({
      allowed: false,
      reason: 'host-not-allowed',
    })
  })

  it('matches websocket declarations only for sockets, and the rest never for sockets', () => {
    expect(decide('GET', 'https://api.example.com/v1/live').allowed).toBe(false)
    expect(decide('GET', 'https://api.example.com/v1/live', { websocket: true }).allowed).toBe(true)
    expect(decide('GET', 'https://api.example.com/v1/items', { websocket: true }).allowed).toBe(false)
  })

  it('never matches a private declaration on a public host or the reverse', () => {
    expect(
      decideRequest('GET', 'https://api.example.com/api/states', hosts, declarations, { privateHosts })
        .allowed,
    ).toBe(false)
  })
})
