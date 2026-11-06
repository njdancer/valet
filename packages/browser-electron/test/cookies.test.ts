import { describe, expect, it } from 'vitest'
import { cookieHost, cookieSetDetails, cookiesForDomains } from '../src/cookies'
import type { CookieRecord } from '../src/platform'

const abck: CookieRecord = {
  name: '_abck',
  value: 'akamai-value',
  domain: '.example.com',
  path: '/',
  hostOnly: false,
  secure: true,
  httpOnly: false,
  session: false,
  expirationDate: 1_900_000_000,
  sameSite: 'no_restriction',
}

describe('cookieHost', () => {
  it('strips the leading dot Chromium adds to domain cookies', () => {
    expect(cookieHost(abck)).toBe('example.com')
  })

  it('lower-cases the host', () => {
    expect(cookieHost({ ...abck, domain: 'WWW.Example.com' })).toBe('www.example.com')
  })

  it('has no host for a cookie with no domain', () => {
    expect(cookieHost({ ...abck, domain: undefined })).toBeNull()
    expect(cookieHost({ ...abck, domain: '.' })).toBeNull()
  })
})

describe('cookiesForDomains', () => {
  const www = { ...abck, name: 'wow-auth-token', domain: 'www.example.com', hostOnly: true }
  const other = { ...abck, name: 'tracker', domain: '.ads.test' }
  const sibling = { ...abck, name: 'sibling', domain: 'evil.example.com', hostOnly: true }
  const noDomain = { ...abck, name: 'odd', domain: undefined }

  it('keeps cookies whose host is on the list', () => {
    expect(
      cookiesForDomains([abck, www, other], ['example.com', 'www.example.com']).map((c) => c.name),
    ).toEqual(['_abck', 'wow-auth-token'])
  })

  it('leaves out a sibling subdomain that is not listed', () => {
    expect(cookiesForDomains([www, sibling], ['www.example.com']).map((c) => c.name)).toEqual([
      'wow-auth-token',
    ])
  })

  it('follows hostAllowed: a wildcard covers subdomains but not the bare domain', () => {
    expect(cookiesForDomains([abck, www], ['*.example.com']).map((c) => c.name)).toEqual(['wow-auth-token'])
  })

  it('leaves out other sites and cookies with no domain', () => {
    expect(cookiesForDomains([other, noDomain], ['example.com', '*.example.com'])).toEqual([])
  })

  it('does not treat a domain list entry as a suffix', () => {
    expect(cookiesForDomains([{ ...abck, domain: '.notexample.com' }], ['example.com'])).toEqual([])
  })
})

describe('cookieSetDetails', () => {
  it('keeps every attribute of a domain cookie', () => {
    expect(cookieSetDetails(abck)).toEqual({
      url: 'https://example.com/',
      name: '_abck',
      value: 'akamai-value',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      expirationDate: 1_900_000_000,
    })
  })

  it('sets a host-only cookie without a domain, so it is not widened to subdomains', () => {
    const details = cookieSetDetails({ ...abck, domain: 'www.example.com', hostOnly: true })
    expect(details).not.toHaveProperty('domain')
    expect(details.url).toBe('https://www.example.com/')
  })

  it('sets a session cookie without an expiry, so it stays a session cookie', () => {
    const details = cookieSetDetails({ ...abck, session: true })
    expect(details).not.toHaveProperty('expirationDate')
  })

  it('treats a cookie with no expiry as a session cookie', () => {
    expect(cookieSetDetails({ ...abck, session: undefined, expirationDate: undefined })).not.toHaveProperty(
      'expirationDate',
    )
  })

  it('keeps httpOnly, a narrower path and the sameSite mode', () => {
    const details = cookieSetDetails({ ...abck, httpOnly: true, path: '/shop', sameSite: 'strict' })
    expect(details).toMatchObject({
      url: 'https://example.com/shop',
      path: '/shop',
      httpOnly: true,
      sameSite: 'strict',
    })
  })

  it('defaults missing flags to false and a missing path to /', () => {
    const details = cookieSetDetails({
      name: 'bare',
      value: 'v',
      domain: 'www.example.com',
      hostOnly: true,
      sameSite: 'lax',
    })
    expect(details).toEqual({
      url: 'https://www.example.com/',
      name: 'bare',
      value: 'v',
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'lax',
    })
  })

  it('refuses a cookie with no domain rather than guessing where it belongs', () => {
    expect(() => cookieSetDetails({ ...abck, domain: undefined })).toThrow()
  })
})
