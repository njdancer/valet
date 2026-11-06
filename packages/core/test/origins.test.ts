import { describe, expect, it } from 'vitest'
import {
  hostAllowed,
  httpsOrigin,
  isBareOrigin,
  isHostPattern,
  originAllowed,
  urlOriginAllowed,
} from '../src/origins'

describe('httpsOrigin', () => {
  it('returns the origin of an https URL', () => {
    expect(httpsOrigin('https://www.example.com/a/b?c=d#e')).toBe('https://www.example.com')
  })

  it('keeps a non-default port', () => {
    expect(httpsOrigin('https://example.com:8443/x')).toBe('https://example.com:8443')
  })

  it('rejects http', () => {
    expect(httpsOrigin('http://www.example.com/')).toBeNull()
  })

  it('rejects things that are not URLs', () => {
    expect(httpsOrigin('www.example.com')).toBeNull()
    expect(httpsOrigin('')).toBeNull()
  })

  it('rejects other schemes', () => {
    expect(httpsOrigin('javascript:alert(1)')).toBeNull()
    expect(httpsOrigin('data:text/html,hi')).toBeNull()
  })
})

describe('originAllowed', () => {
  const allowed = ['https://www.example.com', 'https://login.example.com/']

  it('matches an exact origin', () => {
    expect(originAllowed('https://www.example.com', allowed)).toBe(true)
  })

  it('matches an allowlist entry written with a trailing slash', () => {
    expect(originAllowed('https://login.example.com', allowed)).toBe(true)
  })

  it('is case-insensitive on the host', () => {
    expect(originAllowed('https://WWW.Example.com', allowed)).toBe(true)
  })

  it('does not match a sibling subdomain', () => {
    expect(originAllowed('https://evil.example.com', allowed)).toBe(false)
  })

  it('does not match a lookalike suffix', () => {
    expect(originAllowed('https://www.example.com.evil.test', allowed)).toBe(false)
  })

  it('does not match a different port', () => {
    expect(originAllowed('https://www.example.com:444', allowed)).toBe(false)
  })

  it('does not match http even for an allowed host', () => {
    expect(originAllowed('http://www.example.com', allowed)).toBe(false)
  })

  it('ignores allowlist entries that carry a path', () => {
    expect(originAllowed('https://other.example.com', ['https://other.example.com/login'])).toBe(false)
  })
})

describe('urlOriginAllowed', () => {
  it('checks the origin of a full URL', () => {
    expect(urlOriginAllowed('https://www.example.com/login?next=/', ['https://www.example.com'])).toBe(true)
    expect(
      urlOriginAllowed('https://evil.test/?u=https://www.example.com', ['https://www.example.com']),
    ).toBe(false)
  })

  it('rejects unparseable URLs', () => {
    expect(urlOriginAllowed('not a url', ['https://www.example.com'])).toBe(false)
  })
})

describe('hostAllowed', () => {
  it('matches exact hosts case-insensitively', () => {
    expect(hostAllowed('WWW.example.com', ['www.example.com'])).toBe(true)
  })

  it('matches strict subdomains of a wildcard', () => {
    expect(hostAllowed('cdn.example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true)
  })

  it('does not let a wildcard match its own apex', () => {
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false)
  })

  it('does not let a wildcard match a lookalike', () => {
    expect(hostAllowed('evilexample.com', ['*.example.com'])).toBe(false)
  })

  it('rejects hosts on no list', () => {
    expect(hostAllowed('evil.test', ['www.example.com', '*.example.com'])).toBe(false)
  })
})

describe('isBareOrigin', () => {
  it('accepts an origin with or without a trailing slash', () => {
    expect(isBareOrigin('https://www.example.com')).toBe(true)
    expect(isBareOrigin('https://www.example.com/')).toBe(true)
  })

  it('rejects anything with a path, query or fragment', () => {
    expect(isBareOrigin('https://www.example.com/login')).toBe(false)
    expect(isBareOrigin('https://www.example.com?x=1')).toBe(false)
    expect(isBareOrigin('https://www.example.com#x')).toBe(false)
  })

  it('rejects http', () => {
    expect(isBareOrigin('http://www.example.com')).toBe(false)
  })
})

describe('isHostPattern', () => {
  it('accepts hostnames and leading wildcards', () => {
    expect(isHostPattern('www.example.com')).toBe(true)
    expect(isHostPattern('*.example.com')).toBe(true)
  })

  it('rejects single labels, schemes, paths and inner wildcards', () => {
    expect(isHostPattern('localhost')).toBe(false)
    expect(isHostPattern('https://example.com')).toBe(false)
    expect(isHostPattern('example.com/x')).toBe(false)
    expect(isHostPattern('a.*.example.com')).toBe(false)
    expect(isHostPattern('*')).toBe(false)
  })
})

describe('isBareOrigin and isHostPattern refuse hosts nobody can grant', () => {
  it('rejects wildcard hosts in an origin, which the URL parser would accept', () => {
    expect(isBareOrigin('https://*.example.com')).toBe(false)
  })

  it('rejects IP literals', () => {
    expect(isBareOrigin('https://127.0.0.1')).toBe(false)
    expect(isBareOrigin('https://[::1]')).toBe(false)
    expect(isHostPattern('127.0.0.1')).toBe(false)
    expect(isHostPattern('*.0.0.1')).toBe(false)
  })

  it('still allows a port on a named host, as local test sites need', () => {
    expect(isBareOrigin('https://www.woolworths.test:8443')).toBe(true)
  })
})
