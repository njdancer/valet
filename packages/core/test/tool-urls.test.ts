import { describe, expect, it } from 'vitest'
import { hostOf, httpsOriginOf, originOf, pathnameOf, queryString, urlOn } from '../src/tool-urls'

describe('URL helpers for tool code', () => {
  it('agree with URL on the origins and paths adapters read', () => {
    for (const url of [
      'https://finance.yahoo.com/quote/BHP.AX/?p=1#x',
      'https://EN.Wikipedia.org:443/wiki/Kangaroo',
      'http://localhost:5173/shop/cart',
      'https://www.woolworths.com.au',
    ]) {
      const real = new URL(url)
      expect(originOf(url), url).toBe(real.origin)
      expect(pathnameOf(url), url).toBe(real.pathname)
      expect(hostOf(url), url).toBe(real.host)
    }
  })

  it('answer null for what is not an http(s) URL, and for userinfo', () => {
    for (const url of [
      'about:blank',
      '',
      'file:///etc/passwd',
      '/relative',
      'https://user@evil.test/',
      'javascript:1',
    ])
      expect(originOf(url), url).toBeNull()
    expect(httpsOriginOf('http://example.com/')).toBeNull()
    expect(httpsOriginOf('https://example.com/a')).toBe('https://example.com')
  })

  it('build a path on an origin with an encoded query', () => {
    expect(urlOn('https://q.test', '/v1/search', { q: 'a b&c', n: 5, skip: undefined })).toBe(
      'https://q.test/v1/search?q=a%20b%26c&n=5',
    )
    expect(urlOn('https://q.test', '/x?y=1', { z: '2' })).toBe('https://q.test/x?y=1&z=2')
    expect(new URL(urlOn('https://q.test', '/s', { q: 'é=?' })).searchParams.get('q')).toBe('é=?')
    expect(queryString({})).toBe('')
    expect(() => urlOn('https://q.test/a', '/b')).toThrow()
    expect(() => urlOn('https://q.test', '//evil.test/b')).toThrow()
    expect(() => urlOn('https://q.test', 'b')).toThrow()
  })
})
