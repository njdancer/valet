import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import type { HeaderList, SessionFetchRequest, SessionFetchResponse } from '../src/platform'
import {
  hopHeaders,
  MAX_PROBE_BYTES,
  MAX_PROBE_REDIRECTS,
  ProbeRedirects,
  probeFailure,
  probeResult,
  probeTarget,
  referrerFor,
  sessionProbe,
} from '../src/session-fetch'

const NAVIGATION = ['https://www.example.com', 'https://login.example.com']

function thrown(run: () => unknown): SiteAdapterError {
  try {
    run()
  } catch (error) {
    if (error instanceof SiteAdapterError) return error
    throw new Error(`expected a SiteAdapterError, got ${String(error)}`)
  }
  throw new Error('expected it to throw')
}

const bytes = (text: string) => new TextEncoder().encode(text)

function ok(contentType: string | null, body: Uint8Array | string, status = 200) {
  return {
    kind: 'response' as const,
    status,
    contentType,
    body: typeof body === 'string' ? bytes(body) : body,
  }
}

describe('probeTarget', () => {
  it('accepts an https URL on a navigation origin, dropping the fragment', () => {
    expect(probeTarget('https://www.example.com/api/ui/v2/bootstrap?x=1#frag', NAVIGATION)).toBe(
      'https://www.example.com/api/ui/v2/bootstrap?x=1',
    )
    expect(probeTarget('https://LOGIN.example.com/me', NAVIGATION)).toBe('https://login.example.com/me')
  })

  it('refuses anything off the navigation origins as host-not-allowed', () => {
    for (const url of [
      'https://evil.test/api',
      'https://www.example.com.evil.test/api',
      'https://evil.test@www.example.com.evil.test/',
      'https://sub.www.example.com/api',
      'https://www.example.com:8443/api',
      'http://www.example.com/api',
      'wss://www.example.com/api',
      'data:text/plain,hi',
      'javascript:alert(1)',
      'file:///etc/passwd',
      '/api/ui/v2/bootstrap',
      '//evil.test/api',
      '',
      'not a url',
    ]) {
      expect(
        thrown(() => probeTarget(url, NAVIGATION)),
        url,
      ).toMatchObject({
        stage: 'probe',
        errorClass: 'host-not-allowed',
      })
    }
  })

  it('refuses credentials in the URL, which would go out as HTTP authentication', () => {
    for (const url of ['https://user:pass@www.example.com/api', 'https://user@www.example.com/api']) {
      expect(thrown(() => probeTarget(url, NAVIGATION))).toMatchObject({
        stage: 'probe',
        errorClass: 'invalid',
      })
    }
  })

  it('refuses a URL that is not a string', () => {
    expect(thrown(() => probeTarget(42 as unknown as string, NAVIGATION))).toMatchObject({
      stage: 'probe',
      errorClass: 'invalid',
    })
  })

  it('allows nothing with an empty navigation list', () => {
    expect(thrown(() => probeTarget('https://www.example.com/api', []))).toMatchObject({
      errorClass: 'host-not-allowed',
    })
  })
})

describe('ProbeRedirects', () => {
  it('follows redirects that stay on the navigation origins', () => {
    const redirects = new ProbeRedirects(NAVIGATION)
    expect(redirects.allow('https://login.example.com/authorize')).toBe(true)
    expect(redirects.allow('https://www.example.com/callback')).toBe(true)
    expect(redirects.refusal).toBeNull()
  })

  it('refuses a redirect off the navigation origins, whatever its shape', () => {
    for (const url of [
      'https://evil.test/collect',
      'https://www.example.com.evil.test/',
      'http://www.example.com/downgrade',
      'https://www.example.com:444/',
      'data:text/html,x',
      'not a url',
    ]) {
      const redirects = new ProbeRedirects(NAVIGATION)
      expect(redirects.allow(url), url).toBe(false)
      expect(redirects.refusal).toBe('host-not-allowed')
    }
  })

  it(`stops after ${MAX_PROBE_REDIRECTS} redirects, even on the list`, () => {
    const redirects = new ProbeRedirects(NAVIGATION)
    for (let hop = 0; hop < MAX_PROBE_REDIRECTS; hop++) {
      expect(redirects.allow('https://www.example.com/loop')).toBe(true)
    }
    expect(redirects.allow('https://www.example.com/loop')).toBe(false)
    expect(redirects.refusal).toBe('unavailable')
  })

  it('does not count a refused hop toward the limit, and an off-list hop is refused at any count', () => {
    const redirects = new ProbeRedirects(NAVIGATION)
    expect(redirects.allow('https://evil.test/')).toBe(false)
    expect(redirects.allow('https://www.example.com/a')).toBe(true)
    expect(redirects.allow('https://evil.test/')).toBe(false)
    expect(redirects.refusal).toBe('host-not-allowed')
  })
})

describe('probeResult', () => {
  it('parses JSON when the content type says JSON and it parses', () => {
    expect(probeResult(ok('application/json; charset=utf-8', '{"loggedIn":true}'))).toEqual({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { loggedIn: true },
    })
    expect(probeResult(ok('application/problem+json', '{"a":1}')).body).toEqual({ a: 1 })
    expect(probeResult(ok('text/json', '[1,2]')).body).toEqual([1, 2])
    expect(probeResult(ok('APPLICATION/JSON', '"s"')).body).toBe('s')
  })

  it('keeps the text when JSON does not parse', () => {
    expect(probeResult(ok('application/json', '<html>Access Denied</html>')).body).toBe(
      '<html>Access Denied</html>',
    )
  })

  it('never parses a body as JSON when the content type does not say JSON', () => {
    for (const type of [
      'text/html',
      'text/plain',
      null,
      'application/jsonp',
      'application/x-json-ish',
      'text/html; note=application/json',
    ]) {
      expect(probeResult(ok(type, '{"loggedIn":true}')).body, String(type)).toBe('{"loggedIn":true}')
    }
  })

  it('gives null for an empty body, whatever the content type', () => {
    expect(probeResult(ok('application/json', '')).body).toBeNull()
    expect(probeResult(ok('text/html', '')).body).toBeNull()
    expect(probeResult(ok(null, new Uint8Array()))).toEqual({
      status: 200,
      contentType: null,
      body: null,
    })
  })

  it('keeps the status as the site gave it, error statuses included', () => {
    expect(probeResult(ok('text/html', 'denied', 403))).toMatchObject({ status: 403, body: 'denied' })
    expect(probeResult(ok('application/json', '{}', 401))).toMatchObject({ status: 401, body: {} })
    expect(probeResult(ok(null, '', 204))).toMatchObject({ status: 204, body: null })
  })

  it('decodes the declared charset, and UTF-8 when it is unknown or missing', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    expect(probeResult(ok('text/plain; charset=iso-8859-1', latin1)).body).toBe('café')
    expect(probeResult(ok('text/plain; charset="nonsense-9"', bytes('café'))).body).toBe('café')
    expect(probeResult(ok('text/plain', bytes('café'))).body).toBe('café')
    expect(probeResult(ok('text/plain', new Uint8Array([0xff, 0x41]))).body).toBe('�A')
  })

  it('caps the content type it hands back', () => {
    const long = `text/plain; x=${'a'.repeat(1000)}`
    expect(probeResult(ok(long, 'x')).contentType).toHaveLength(200)
  })

  it('refuses a status no server sends', () => {
    for (const status of [0, 99, 600, 200.5, Number.NaN]) {
      expect(thrown(() => probeResult(ok('text/plain', 'x', status)))).toMatchObject({
        stage: 'probe',
        errorClass: 'unavailable',
      })
    }
  })

  it('turns each failure into a probe error that says nothing about the response', () => {
    expect(probeFailure('too-large')).toMatchObject({ stage: 'probe', errorClass: 'unexpected-shape' })
    expect(probeFailure('network')).toMatchObject({ stage: 'probe', errorClass: 'unavailable' })
    expect(probeFailure('aborted')).toMatchObject({ stage: 'probe', errorClass: 'aborted' })
  })

  it('caps the body at 1 MiB', () => {
    expect(MAX_PROBE_BYTES).toBe(1024 * 1024)
  })
})

describe('hopHeaders', () => {
  const IDENTITY: HeaderList = [
    ['sec-ch-ua-platform', '"macOS"'],
    ['User-Agent', 'Mozilla/5.0 clean'],
    ['sec-ch-ua', '"Chromium";v="142"'],
    ['Accept-Language', 'en-AU,en;q=0.9'],
    ['sec-ch-ua-mobile', '?0'],
  ]

  it('words a same-origin hop as Chrome words a page’s fetch(): identity, Accept, cors metadata', () => {
    expect(hopHeaders(IDENTITY, 'https://www.example.com', { crossed: false, tainted: false })).toEqual([
      ...IDENTITY,
      ['Accept', '*/*'],
      ['Sec-Fetch-Site', 'same-origin'],
      ['Sec-Fetch-Mode', 'cors'],
      ['Sec-Fetch-Dest', 'empty'],
    ])
  })

  it('names the page’s origin once the request has gone cross-origin, between Accept and the metadata', () => {
    expect(hopHeaders([], 'https://www.example.com', { crossed: true, tainted: false })).toEqual([
      ['Accept', '*/*'],
      ['Origin', 'https://www.example.com'],
      ['Sec-Fetch-Site', 'same-origin'],
      ['Sec-Fetch-Mode', 'cors'],
      ['Sec-Fetch-Dest', 'empty'],
    ])
  })

  it('sends Origin: null after a tainting redirect', () => {
    const headers = hopHeaders([], 'https://www.example.com', { crossed: true, tainted: true })
    expect(headers.filter(([name]) => name === 'Origin')).toEqual([['Origin', 'null']])
  })

  it('never says no-cors, and never asks for a navigation', () => {
    for (const crossed of [false, true]) {
      const headers = new Map(hopHeaders(IDENTITY, 'https://www.example.com', { crossed, tainted: false }))
      expect(headers.get('Sec-Fetch-Mode')).toBe('cors')
      expect(headers.get('Sec-Fetch-Dest')).toBe('empty')
      expect(headers.has('Sec-Fetch-User')).toBe(false)
      expect(headers.has('Upgrade-Insecure-Requests')).toBe(false)
    }
  })
})

describe('referrerFor', () => {
  const page = new URL('https://www.example.com/shop/login?step=2#top')

  it('sends the page’s URL, less its fragment, to its own origin', () => {
    expect(referrerFor(page, new URL('https://www.example.com/api/me'))).toBe(
      'https://www.example.com/shop/login?step=2',
    )
  })

  it('sends the origin alone anywhere else', () => {
    expect(referrerFor(page, new URL('https://login.example.com/me'))).toBe('https://www.example.com/')
  })

  it('never sends credentials from the page’s URL', () => {
    const withCredentials = new URL('https://user:pass@www.example.com/x')
    expect(referrerFor(withCredentials, new URL('https://www.example.com/me'))).toBe(
      'https://www.example.com/x',
    )
  })
})

describe('sessionProbe', () => {
  const PAGE = 'https://www.example.com/shop/login?step=2#top'
  const IDENTITY: HeaderList = [['User-Agent', 'Mozilla/5.0 clean']]

  function session(answers: SessionFetchResponse[]) {
    const asked: SessionFetchRequest[] = []
    return {
      asked,
      fetch: async (request: SessionFetchRequest): Promise<SessionFetchResponse> => {
        asked.push(request)
        const answer = answers.shift()
        if (answer === undefined) throw new Error('asked more often than expected')
        return answer
      },
    }
  }

  const request = (pageUrl = PAGE, signal = new AbortController().signal) => ({
    navigation: NAVIGATION,
    identity: IDENTITY,
    pageUrl,
    maxBytes: 1234,
    signal,
  })

  const redirect = (location: string): SessionFetchResponse => ({ kind: 'redirect', location })

  it('makes one request on the page’s behalf, with the page’s Referer, and reads the answer', async () => {
    const fake = session([ok('application/json', '{"a":1}')])
    expect(await sessionProbe(fake, 'https://www.example.com/api/me#x', request())).toEqual({
      status: 200,
      contentType: 'application/json',
      body: { a: 1 },
    })
    expect(fake.asked).toHaveLength(1)
    expect(fake.asked[0]).toMatchObject({
      url: 'https://www.example.com/api/me',
      initiator: 'https://www.example.com',
      referrer: 'https://www.example.com/shop/login?step=2',
      maxBytes: 1234,
    })
    expect(fake.asked[0]?.headers).toEqual(
      hopHeaders(IDENTITY, 'https://www.example.com', { crossed: false, tainted: false }),
    )
  })

  it('probes another navigation origin as a cross-origin fetch from the page', async () => {
    const fake = session([ok(null, '')])
    await sessionProbe(fake, 'https://login.example.com/me', request())
    expect(fake.asked[0]).toMatchObject({
      url: 'https://login.example.com/me',
      initiator: 'https://www.example.com',
      referrer: 'https://www.example.com/',
    })
    expect(new Map(fake.asked[0]?.headers).get('Origin')).toBe('https://www.example.com')
  })

  it('goes as if from the target’s own origin, with no Referer, before any page is on the list', async () => {
    for (const pageUrl of [
      '',
      'about:blank',
      'https://evil.test/x',
      'http://www.example.com/x',
      'nonsense',
    ]) {
      const fake = session([ok(null, '')])
      await sessionProbe(fake, 'https://login.example.com/me', request(pageUrl))
      expect(fake.asked[0], pageUrl).toMatchObject({ initiator: 'https://login.example.com', referrer: null })
      expect(new Map(fake.asked[0]?.headers).has('Origin'), pageUrl).toBe(false)
    }
  })

  it('takes redirects one hop at a time, rewording each as Chrome would after it', async () => {
    const fake = session([
      redirect('https://www.example.com/a#frag'),
      redirect('https://login.example.com/b'),
      redirect('https://www.example.com/c'),
      ok('text/plain', 'done'),
    ])
    expect(await sessionProbe(fake, 'https://www.example.com/start', request())).toMatchObject({
      body: 'done',
    })
    expect(fake.asked.map((r) => r.url)).toEqual([
      'https://www.example.com/start',
      'https://www.example.com/a',
      'https://login.example.com/b',
      'https://www.example.com/c',
    ])
    const origins = fake.asked.map((r) => new Map(r.headers).get('Origin') ?? null)
    // Same-origin until it crosses, and CORS from then on. Leaving login.example.com, an origin
    // that isn't the page's, for another taints the origin, even when the other is the page's own.
    expect(origins).toEqual([null, null, 'https://www.example.com', 'null'])
    expect(fake.asked.map((r) => r.referrer)).toEqual([
      'https://www.example.com/shop/login?step=2',
      'https://www.example.com/shop/login?step=2',
      'https://www.example.com/',
      'https://www.example.com/shop/login?step=2',
    ])
    expect(new Set(fake.asked.map((r) => r.initiator))).toEqual(new Set(['https://www.example.com']))
  })

  it('taints the Origin after a redirect from one foreign origin to another', async () => {
    const navigation = [...NAVIGATION, 'https://id.example.com']
    const fake = session([redirect('https://id.example.com/b'), ok(null, '')])
    await sessionProbe(fake, 'https://login.example.com/a', { ...request(), navigation })
    expect(fake.asked.map((r) => new Map(r.headers).get('Origin'))).toEqual([
      'https://www.example.com',
      'null',
    ])
  })

  it('refuses a redirect off the navigation origins before anything is sent there', async () => {
    for (const location of ['https://evil.test/collect?c=1', 'http://www.example.com/x', 'not a url']) {
      const fake = session([redirect(location)])
      const error = await sessionProbe(fake, 'https://www.example.com/start', request()).catch((e) => e)
      expect(error, location).toMatchObject({ stage: 'probe', errorClass: 'host-not-allowed' })
      expect(fake.asked.map((r) => r.url)).toEqual(['https://www.example.com/start'])
    }
  })

  it(`gives up after ${MAX_PROBE_REDIRECTS} redirects on the list as unavailable`, async () => {
    const answers = Array.from({ length: MAX_PROBE_REDIRECTS + 1 }, () =>
      redirect('https://www.example.com/loop'),
    )
    const fake = session(answers)
    const error = await sessionProbe(fake, 'https://www.example.com/start', request()).catch((e) => e)
    expect(error).toMatchObject({ stage: 'probe', errorClass: 'unavailable' })
    expect(fake.asked).toHaveLength(MAX_PROBE_REDIRECTS + 1)
  })

  it('sends no further hop once the signal is aborted', async () => {
    const controller = new AbortController()
    const fake = {
      asked: 0,
      fetch: async (): Promise<SessionFetchResponse> => {
        fake.asked++
        controller.abort()
        return redirect('https://www.example.com/next')
      },
    }
    const error = await sessionProbe(
      fake,
      'https://www.example.com/start',
      request(PAGE, controller.signal),
    ).catch((e) => e)
    expect(error).toMatchObject({ stage: 'probe', errorClass: 'aborted' })
    expect(fake.asked).toBe(1)
  })

  it('turns a failed hop into its probe error', async () => {
    const fake = session([{ kind: 'failed', failure: 'too-large' }])
    const error = await sessionProbe(fake, 'https://www.example.com/start', request()).catch((e) => e)
    expect(error).toMatchObject({ stage: 'probe', errorClass: 'unexpected-shape' })
  })

  it('checks the target before the session is asked anything', async () => {
    const fake = session([])
    const error = await sessionProbe(fake, 'https://evil.test/', request()).catch((e) => e)
    expect(error).toMatchObject({ stage: 'probe', errorClass: 'host-not-allowed' })
    expect(fake.asked).toEqual([])
  })
})
