import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { evaluateCondition, MAX_REGEX_INPUT, patternsValid, urlMatches } from '../src/conditions'
import { FakeAuthPage } from './fake-auth-page'
import { LOGIN_PAGE, SITE } from './fixtures'

function pageAtLogin(): FakeAuthPage {
  const page = new FakeAuthPage(structuredClone(SITE))
  page.navigate(LOGIN_PAGE)
  return page
}

describe('urlMatches', () => {
  it('matches a substring of the path', () => {
    expect(urlMatches('https://www.shop.test/account/orders', '/account')).toBe(true)
    expect(urlMatches('https://www.shop.test/login', '/account')).toBe(false)
  })

  it('matches against the query too', () => {
    expect(urlMatches('https://www.shop.test/login?step=otp', 'step=otp')).toBe(true)
  })

  it('never matches against the host, so a pattern cannot be satisfied by an attacker domain', () => {
    expect(urlMatches('https://account.evil.test/', 'account')).toBe(false)
    expect(urlMatches('https://www.shop.test.evil.test/', 'shop.test')).toBe(false)
  })

  it('never matches against the fragment', () => {
    expect(urlMatches('https://www.shop.test/login#account', 'account')).toBe(false)
  })

  it('treats a pattern wrapped in slashes as a regular expression', () => {
    expect(urlMatches('https://www.shop.test/account', '/^\\/account$/')).toBe(true)
    expect(urlMatches('https://www.shop.test/my/account', '/^\\/account$/')).toBe(false)
  })

  it('treats a lone slash, or a pair of slashes, as a substring', () => {
    expect(urlMatches('https://www.shop.test/', '/')).toBe(true)
    expect(urlMatches('https://www.shop.test/a', '//')).toBe(false)
    expect(urlMatches('https://www.shop.test/a//b', '//')).toBe(true)
  })

  it('rejects an invalid regular expression as an invalid manifest', () => {
    expect(() => urlMatches('https://www.shop.test/', '/(unclosed/')).toThrow(SiteAdapterError)
    try {
      urlMatches('https://www.shop.test/', '/(unclosed/')
    } catch (error) {
      expect(error).toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
    }
  })

  it('does not run a regex on a path and query longer than the cap', () => {
    const long = `https://www.shop.test/account?${'a'.repeat(MAX_REGEX_INPUT)}`
    expect(urlMatches(long, '/^\\/account/')).toBe(false)
  })

  it('runs a regex on a path and query exactly at the cap', () => {
    const path = `/account?${'a'.repeat(MAX_REGEX_INPUT - '/account?'.length)}`
    expect(urlMatches(`https://www.shop.test${path}`, '/^\\/account/')).toBe(true)
  })

  it('still matches a substring on a long URL, which costs no backtracking', () => {
    const long = `https://www.shop.test/account?${'a'.repeat(MAX_REGEX_INPUT)}`
    expect(urlMatches(long, '/account')).toBe(true)
  })

  it('does not match a URL it cannot parse', () => {
    expect(urlMatches('not a url', 'url')).toBe(false)
  })
})

describe('evaluateCondition', () => {
  it('visible holds for a present, visible element', async () => {
    expect(await evaluateCondition(pageAtLogin(), { visible: '#email' })).toBe(true)
  })

  it('visible does not hold for a hidden element', async () => {
    const page = pageAtLogin()
    const site = page.site[LOGIN_PAGE]!
    page.site[LOGIN_PAGE] = { ...site, elements: { '#email': { inputType: 'email', visible: false } } }
    expect(await evaluateCondition(page, { visible: '#email' })).toBe(false)
  })

  it('visible does not hold for a missing element', async () => {
    expect(await evaluateCondition(pageAtLogin(), { visible: '#nope' })).toBe(false)
  })

  it('urlMatches reads the current URL', async () => {
    expect(await evaluateCondition(pageAtLogin(), { urlMatches: '/' })).toBe(true)
    expect(await evaluateCondition(pageAtLogin(), { urlMatches: 'account' })).toBe(false)
  })

  it('textPresent reads the page text', async () => {
    expect(await evaluateCondition(pageAtLogin(), { textPresent: 'Sign in' })).toBe(true)
    expect(await evaluateCondition(pageAtLogin(), { textPresent: 'Welcome back' })).toBe(false)
  })

  it('not inverts', async () => {
    expect(await evaluateCondition(pageAtLogin(), { not: { visible: '#email' } })).toBe(false)
    expect(await evaluateCondition(pageAtLogin(), { not: { visible: '#nope' } })).toBe(true)
  })

  it('any holds when one inner condition holds', async () => {
    expect(
      await evaluateCondition(pageAtLogin(), { any: [{ visible: '#nope' }, { visible: '#email' }] }),
    ).toBe(true)
    expect(
      await evaluateCondition(pageAtLogin(), { any: [{ visible: '#nope' }, { textPresent: 'zzz' }] }),
    ).toBe(false)
  })

  it('all holds only when every inner condition holds', async () => {
    expect(
      await evaluateCondition(pageAtLogin(), { all: [{ visible: '#email' }, { textPresent: 'Sign in' }] }),
    ).toBe(true)
    expect(
      await evaluateCondition(pageAtLogin(), { all: [{ visible: '#email' }, { visible: '#nope' }] }),
    ).toBe(false)
  })

  it('nests', async () => {
    const condition = {
      all: [{ not: { any: [{ visible: '#nope' }, { textPresent: 'Welcome' }] } }, { visible: '#password' }],
    }
    expect(await evaluateCondition(pageAtLogin(), condition)).toBe(true)
  })
})

describe('patternsValid', () => {
  it('holds for steps with no conditions', () => {
    expect(patternsValid([{ op: 'goto', url: LOGIN_PAGE }])).toBe(true)
  })

  it('holds for substrings and valid regular expressions', () => {
    expect(
      patternsValid([
        { op: 'waitFor', condition: { urlMatches: '/account' }, timeoutMs: 1000 },
        { op: 'waitFor', condition: { urlMatches: '/^\\/account$/' }, timeoutMs: 1000 },
      ]),
    ).toBe(true)
  })

  it('fails for an invalid regular expression in a waitFor', () => {
    expect(patternsValid([{ op: 'waitFor', condition: { urlMatches: '/(/' }, timeoutMs: 1000 }])).toBe(false)
  })

  it('fails for an invalid regular expression deep inside nested branches', () => {
    expect(
      patternsValid([
        {
          op: 'retry',
          times: 1,
          steps: [
            {
              op: 'when',
              condition: { visible: '#x' },
              steps: [],
              otherwise: [
                {
                  op: 'when',
                  condition: { all: [{ textPresent: 'x' }, { any: [{ not: { urlMatches: '/)/' } }] }] },
                  steps: [],
                },
              ],
            },
          ],
        },
      ]),
    ).toBe(false)
  })
})
