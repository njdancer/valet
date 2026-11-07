// @vitest-environment node
// The feed URL check: one test per way to smuggle a token, a credential or a second host in.

import { describe, expect, it } from 'vitest'
import { classifyUpdateError, MAX_FEED_URL_LENGTH, validateFeedUrl } from '../../src/main/updater'

describe('validateFeedUrl', () => {
  it('accepts an https directory URL in canonical form', () => {
    expect(validateFeedUrl('https://updates.example.com/mac/')).toBe('https://updates.example.com/mac/')
    expect(validateFeedUrl('https://updates.example.com/')).toBe('https://updates.example.com/')
    expect(validateFeedUrl('https://updates.example.com:8443/valet/mac/')).toBe(
      'https://updates.example.com:8443/valet/mac/',
    )
  })

  it('refuses a query string or fragment, where tokens go', () => {
    expect(validateFeedUrl('https://updates.example.com/mac/?token=abc')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com/mac/?')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com/mac/#abc')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com/mac/#')).toBeNull()
  })

  it('refuses credentials in the URL', () => {
    expect(validateFeedUrl('https://user:pass@updates.example.com/mac/')).toBeNull()
    expect(validateFeedUrl('https://token@updates.example.com/mac/')).toBeNull()
  })

  it('refuses plain http, and other schemes', () => {
    expect(validateFeedUrl('http://updates.example.com/mac/')).toBeNull()
    expect(validateFeedUrl('file:///Users/x/feed/')).toBeNull()
    expect(validateFeedUrl('ftp://updates.example.com/mac/')).toBeNull()
    expect(validateFeedUrl('data:text/plain,hi/')).toBeNull()
  })

  it('allows http only to loopback, and only when asked', () => {
    expect(validateFeedUrl('http://127.0.0.1:4555/')).toBeNull()
    expect(validateFeedUrl('http://127.0.0.1:4555/', { allowLoopbackHttp: true })).toBe(
      'http://127.0.0.1:4555/',
    )
    expect(validateFeedUrl('http://[::1]:4555/', { allowLoopbackHttp: true })).toBe('http://[::1]:4555/')
    expect(validateFeedUrl('http://localhost:4555/', { allowLoopbackHttp: true })).toBe(
      'http://localhost:4555/',
    )
    expect(validateFeedUrl('http://127.0.0.2:4555/', { allowLoopbackHttp: true })).toBeNull()
    expect(validateFeedUrl('http://localhost.evil.example/', { allowLoopbackHttp: true })).toBeNull()
    expect(validateFeedUrl('http://127.0.0.1.nip.io/', { allowLoopbackHttp: true })).toBeNull()
  })

  it('refuses, for a release, a host that cannot be a public feed', () => {
    const release = { requirePublicHost: true }
    for (const url of [
      'https://localhost/mac/',
      'https://app.localhost/mac/',
      'https://127.0.0.1/mac/',
      'https://0x7f000001/mac/',
      'https://8.8.8.8/mac/',
      'https://[::1]/mac/',
      'https://[2001:db8::1]/mac/',
      'https://updates/mac/',
      'https://updates.local/mac/',
      'https://updates.internal/mac/',
      'https://router.home.arpa/mac/',
      'https://feed.test/mac/',
      'https://updates.example/mac/',
    ]) {
      expect(validateFeedUrl(url, release), url).toBeNull()
      // Allowed when a public host isn't required: the parser's canonical form, at least.
      if (!url.includes('0x7f')) expect(validateFeedUrl(url), url).toBe(url)
    }
    expect(validateFeedUrl('https://updates.example.com/mac/', release)).toBe(
      'https://updates.example.com/mac/',
    )
    expect(validateFeedUrl('https://updates.dncr.me/mac/', release)).toBe('https://updates.dncr.me/mac/')
    // The loopback allowance for the end-to-end build is http only; it doesn't lift the https rule.
    expect(validateFeedUrl('http://127.0.0.1:4555/', { ...release, allowLoopbackHttp: true })).toBe(
      'http://127.0.0.1:4555/',
    )
  })

  it('refuses a path that is not a directory', () => {
    expect(validateFeedUrl('https://updates.example.com/mac')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com/mac/latest-mac.yml')).toBeNull()
  })

  it('refuses anything the URL parser would rewrite, so what was reviewed is what is fetched', () => {
    expect(validateFeedUrl('https://Updates.Example.com/mac/')).toBeNull()
    expect(validateFeedUrl('HTTPS://updates.example.com/mac/')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com/a/../mac/')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com:443/mac/')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com\\mac/')).toBeNull()
    expect(validateFeedUrl('https://xn--updtes-bua.example.com/mac/')).toBe(
      'https://xn--updtes-bua.example.com/mac/',
    )
    expect(validateFeedUrl('https://updätes.example.com/mac/')).toBeNull()
  })

  it('refuses whitespace and control characters, which the parser would silently drop', () => {
    expect(validateFeedUrl('https://updates.exa\nmple.com/mac/')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com/m\tac/')).toBeNull()
    expect(validateFeedUrl(' https://updates.example.com/mac/')).toBeNull()
    expect(validateFeedUrl('https://updates.example.com/mac/\u0000')).toBeNull()
  })

  it('refuses empty, overlong and non-string values', () => {
    expect(validateFeedUrl('')).toBeNull()
    expect(validateFeedUrl(`https://updates.example.com/${'a/'.repeat(MAX_FEED_URL_LENGTH)}`)).toBeNull()
    expect(validateFeedUrl(undefined)).toBeNull()
    expect(validateFeedUrl(new URL('https://updates.example.com/mac/'))).toBeNull()
    expect(validateFeedUrl('not a url/')).toBeNull()
    expect(validateFeedUrl('notaurl/')).toBeNull()
    expect(validateFeedUrl('https://[::1/')).toBeNull()
  })
})

describe('classifyUpdateError', () => {
  it('never reads the message', () => {
    expect(classifyUpdateError(new Error('ERR_CHECKSUM_MISMATCH'), 'download')).toBe('download-failed')
    expect(classifyUpdateError(new Error('ECONNREFUSED'), 'check')).toBe('internal')
  })

  it('survives values that are not errors, and hostile getters', () => {
    expect(classifyUpdateError(null, 'check')).toBe('internal')
    expect(classifyUpdateError(42, 'check')).toBe('internal')
    const hostile = Object.defineProperty({}, 'code', {
      get() {
        throw new Error('boom')
      },
    })
    expect(classifyUpdateError(hostile, 'check')).toBe('internal')
  })

  it('does not accept a code that only looks numeric as an HTTP status', () => {
    expect(classifyUpdateError({ statusCode: '503' }, 'check')).toBe('internal')
    expect(classifyUpdateError({ statusCode: 503 }, 'check')).toBe('feed-unreachable')
  })

  it('reads builder-util-runtime’s HTTP_ERROR_nnn codes as unreachable while checking', () => {
    expect(classifyUpdateError({ code: 'HTTP_ERROR_403' }, 'check')).toBe('feed-unreachable')
    expect(classifyUpdateError({ code: 'HTTP_ERROR_4031' }, 'check')).toBe('internal')
  })

  it('calls any other failure while downloading a failed download', () => {
    expect(classifyUpdateError(new Error('Cannot download "http://…", status 404'), 'download')).toBe(
      'download-failed',
    )
    expect(classifyUpdateError(null, 'download')).toBe('download-failed')
  })

  it('calls every failure during install an install failure', () => {
    expect(classifyUpdateError({ code: 'ERR_CHECKSUM_MISMATCH' }, 'install')).toBe('install-failed')
  })
})
