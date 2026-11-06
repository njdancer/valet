import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import {
  compileUrlRegexes,
  evaluateCondition,
  MAX_REGEX_INPUT,
  urlContains,
  urlRegexMatches,
} from '../src/conditions'
import { FakeAuthPage } from './fake-auth-page'
import { LOGIN_PAGE, SITE } from './fixtures'

function pageAtLogin(): FakeAuthPage {
  const page = new FakeAuthPage(structuredClone(SITE))
  page.navigate(LOGIN_PAGE)
  return page
}

const NO_REGEXES = new Map<string, RegExp>()

describe('urlContains', () => {
  it('matches a substring of the path', () => {
    expect(urlContains('https://www.shop.test/account/orders', '/account')).toBe(true)
    expect(urlContains('https://www.shop.test/login', '/account')).toBe(false)
  })

  it('matches against the query too', () => {
    expect(urlContains('https://www.shop.test/login?step=otp', 'step=otp')).toBe(true)
  })

  it('never matches against the host, so it cannot be satisfied by an attacker domain', () => {
    expect(urlContains('https://account.evil.test/', 'account')).toBe(false)
    expect(urlContains('https://www.shop.test.evil.test/', 'shop.test')).toBe(false)
  })

  it('never matches against userinfo', () => {
    expect(urlContains('https://account@www.shop.test/', 'account')).toBe(false)
  })

  it('never matches against the fragment, which the page controls without a navigation', () => {
    expect(urlContains('https://www.shop.test/login#account', 'account')).toBe(false)
  })

  it('treats slashes as plain text, never as a regular expression', () => {
    expect(urlContains('https://www.shop.test/account', '/^\\/account$/')).toBe(false)
    expect(urlContains('https://www.shop.test/a//b', '//')).toBe(true)
  })

  it('treats regex metacharacters as plain text', () => {
    expect(urlContains('https://www.shop.test/a.b', 'a.b')).toBe(true)
    expect(urlContains('https://www.shop.test/axb', 'a.b')).toBe(false)
  })

  it('still matches on a very long URL, which costs no backtracking', () => {
    const long = `https://www.shop.test/account?${'a'.repeat(MAX_REGEX_INPUT * 4)}`
    expect(urlContains(long, '/account')).toBe(true)
  })

  it('does not match a URL it cannot parse', () => {
    expect(urlContains('not a url', 'url')).toBe(false)
  })
})

describe('urlRegexMatches', () => {
  it('matches the path and query', () => {
    expect(urlRegexMatches('https://www.shop.test/account', /^\/account$/)).toBe(true)
    expect(urlRegexMatches('https://www.shop.test/my/account', /^\/account$/)).toBe(false)
    expect(urlRegexMatches('https://www.shop.test/login?step=otp', /step=otp$/)).toBe(true)
  })

  it('never matches against the host, even with an unanchored pattern', () => {
    expect(urlRegexMatches('https://account.evil.test/', /account/)).toBe(false)
  })

  it('never matches against the fragment', () => {
    expect(urlRegexMatches('https://www.shop.test/login#account', /account/)).toBe(false)
  })

  it('does not run on a path and query longer than the cap', () => {
    const long = `https://www.shop.test/account?${'a'.repeat(MAX_REGEX_INPUT)}`
    expect(urlRegexMatches(long, /^\/account/)).toBe(false)
  })

  it('runs on a path and query exactly at the cap', () => {
    const path = `/account?${'a'.repeat(MAX_REGEX_INPUT - '/account?'.length)}`
    expect(urlRegexMatches(`https://www.shop.test${path}`, /^\/account/)).toBe(true)
  })

  it('does not match a URL it cannot parse', () => {
    expect(urlRegexMatches('not a url', /url/)).toBe(false)
  })
})

describe('compileUrlRegexes', () => {
  it('is empty for steps with no urlRegex', () => {
    const regexes = compileUrlRegexes([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { urlContains: '(' }, timeoutMs: 1000 },
    ])
    expect(regexes).toEqual(new Map())
  })

  it('compiles each distinct pattern once, wherever it appears', () => {
    const regexes = compileUrlRegexes([
      { op: 'waitFor', condition: { urlRegex: '^/account' }, timeoutMs: 1000 },
      {
        op: 'when',
        condition: { not: { urlRegex: '^/account' } },
        steps: [{ op: 'waitFor', condition: { urlRegex: 'step=otp' }, timeoutMs: 1000 }],
      },
    ])
    expect([...(regexes?.keys() ?? [])]).toEqual(['^/account', 'step=otp'])
    expect(regexes?.get('^/account')?.flags).toBe('')
  })

  it('refuses a pattern that does not compile', () => {
    expect(compileUrlRegexes([{ op: 'waitFor', condition: { urlRegex: '(' }, timeoutMs: 1000 }])).toBeNull()
  })

  it('refuses a nested quantifier the parse-time screen would have caught', () => {
    expect(
      compileUrlRegexes([{ op: 'waitFor', condition: { urlRegex: '^(a+)+$' }, timeoutMs: 1000 }]),
    ).toBeNull()
  })

  it('refuses a backreference', () => {
    expect(
      compileUrlRegexes([{ op: 'waitFor', condition: { urlRegex: '(a)\\1' }, timeoutMs: 1000 }]),
    ).toBeNull()
  })

  it('refuses a pattern that is not a string at all', () => {
    expect(
      compileUrlRegexes([
        { op: 'waitFor', condition: { urlRegex: { source: 'x' } as unknown as string }, timeoutMs: 1000 },
      ]),
    ).toBeNull()
  })

  it('finds a bad pattern deep inside nested branches and conditions', () => {
    expect(
      compileUrlRegexes([
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
                  condition: { all: [{ textPresent: 'x' }, { any: [{ not: { urlRegex: '(a|ab)*' } }] }] },
                  steps: [],
                },
              ],
            },
          ],
        },
      ]),
    ).toBeNull()
  })
})

describe('evaluateCondition', () => {
  it('visible holds for a present, visible element', async () => {
    expect(await evaluateCondition(pageAtLogin(), { visible: '#email' }, NO_REGEXES)).toBe(true)
  })

  it('visible does not hold for a hidden element', async () => {
    const page = pageAtLogin()
    const site = page.site[LOGIN_PAGE]!
    page.site[LOGIN_PAGE] = { ...site, elements: { '#email': { inputType: 'email', visible: false } } }
    expect(await evaluateCondition(page, { visible: '#email' }, NO_REGEXES)).toBe(false)
  })

  it('visible does not hold for a missing element', async () => {
    expect(await evaluateCondition(pageAtLogin(), { visible: '#nope' }, NO_REGEXES)).toBe(false)
  })

  it('urlContains reads the current URL', async () => {
    expect(await evaluateCondition(pageAtLogin(), { urlContains: '/' }, NO_REGEXES)).toBe(true)
    expect(await evaluateCondition(pageAtLogin(), { urlContains: 'account' }, NO_REGEXES)).toBe(false)
  })

  it('urlRegex uses the compiled pattern for the current URL', async () => {
    const regexes = new Map([['^/$', /^\/$/]])
    expect(await evaluateCondition(pageAtLogin(), { urlRegex: '^/$' }, regexes)).toBe(true)
  })

  it('urlRegex refuses a pattern that was not compiled up front, rather than compiling it now', async () => {
    const outcome = evaluateCondition(pageAtLogin(), { urlRegex: '^/$' }, NO_REGEXES)
    await expect(outcome).rejects.toThrow(SiteAdapterError)
    await expect(outcome).rejects.toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
  })

  it('textPresent reads the page text', async () => {
    expect(await evaluateCondition(pageAtLogin(), { textPresent: 'Sign in' }, NO_REGEXES)).toBe(true)
    expect(await evaluateCondition(pageAtLogin(), { textPresent: 'Welcome back' }, NO_REGEXES)).toBe(false)
  })

  it('not inverts', async () => {
    expect(await evaluateCondition(pageAtLogin(), { not: { visible: '#email' } }, NO_REGEXES)).toBe(false)
    expect(await evaluateCondition(pageAtLogin(), { not: { visible: '#nope' } }, NO_REGEXES)).toBe(true)
  })

  it('any holds when one inner condition holds', async () => {
    expect(
      await evaluateCondition(
        pageAtLogin(),
        { any: [{ visible: '#nope' }, { visible: '#email' }] },
        NO_REGEXES,
      ),
    ).toBe(true)
    expect(
      await evaluateCondition(
        pageAtLogin(),
        { any: [{ visible: '#nope' }, { textPresent: 'zzz' }] },
        NO_REGEXES,
      ),
    ).toBe(false)
  })

  it('all holds only when every inner condition holds', async () => {
    expect(
      await evaluateCondition(
        pageAtLogin(),
        { all: [{ visible: '#email' }, { textPresent: 'Sign in' }] },
        NO_REGEXES,
      ),
    ).toBe(true)
    expect(
      await evaluateCondition(
        pageAtLogin(),
        { all: [{ visible: '#email' }, { visible: '#nope' }] },
        NO_REGEXES,
      ),
    ).toBe(false)
  })

  it('nests', async () => {
    const condition = {
      all: [{ not: { any: [{ visible: '#nope' }, { textPresent: 'Welcome' }] } }, { visible: '#password' }],
    }
    expect(await evaluateCondition(pageAtLogin(), condition, NO_REGEXES)).toBe(true)
  })
})
