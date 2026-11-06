import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import type { SessionFetchResponse } from '../src/platform'
import {
  MAX_PROBE_BYTES,
  MAX_PROBE_REDIRECTS,
  ProbeRedirects,
  probeResult,
  probeTarget,
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

function ok(contentType: string | null, body: Uint8Array | string, status = 200): SessionFetchResponse {
  return { ok: true, status, contentType, body: typeof body === 'string' ? bytes(body) : body }
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
  const none = () => new ProbeRedirects(NAVIGATION)

  it('parses JSON when the content type says JSON and it parses', () => {
    expect(probeResult(ok('application/json; charset=utf-8', '{"loggedIn":true}'), none())).toEqual({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { loggedIn: true },
    })
    expect(probeResult(ok('application/problem+json', '{"a":1}'), none()).body).toEqual({ a: 1 })
    expect(probeResult(ok('text/json', '[1,2]'), none()).body).toEqual([1, 2])
    expect(probeResult(ok('APPLICATION/JSON', '"s"'), none()).body).toBe('s')
  })

  it('keeps the text when JSON does not parse', () => {
    expect(probeResult(ok('application/json', '<html>Access Denied</html>'), none()).body).toBe(
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
      expect(probeResult(ok(type, '{"loggedIn":true}'), none()).body, String(type)).toBe('{"loggedIn":true}')
    }
  })

  it('gives null for an empty body, whatever the content type', () => {
    expect(probeResult(ok('application/json', ''), none()).body).toBeNull()
    expect(probeResult(ok('text/html', ''), none()).body).toBeNull()
    expect(probeResult(ok(null, new Uint8Array()), none())).toEqual({
      status: 200,
      contentType: null,
      body: null,
    })
  })

  it('keeps the status as the site gave it, error statuses included', () => {
    expect(probeResult(ok('text/html', 'denied', 403), none())).toMatchObject({ status: 403, body: 'denied' })
    expect(probeResult(ok('application/json', '{}', 401), none())).toMatchObject({ status: 401, body: {} })
    expect(probeResult(ok(null, '', 204), none())).toMatchObject({ status: 204, body: null })
  })

  it('decodes the declared charset, and UTF-8 when it is unknown or missing', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    expect(probeResult(ok('text/plain; charset=iso-8859-1', latin1), none()).body).toBe('café')
    expect(probeResult(ok('text/plain; charset="nonsense-9"', bytes('café')), none()).body).toBe('café')
    expect(probeResult(ok('text/plain', bytes('café')), none()).body).toBe('café')
    expect(probeResult(ok('text/plain', new Uint8Array([0xff, 0x41])), none()).body).toBe('�A')
  })

  it('caps the content type it hands back', () => {
    const long = `text/plain; x=${'a'.repeat(1000)}`
    expect(probeResult(ok(long, 'x'), none()).contentType).toHaveLength(200)
  })

  it('refuses a status no server sends', () => {
    for (const status of [0, 99, 600, 200.5, Number.NaN]) {
      expect(thrown(() => probeResult(ok('text/plain', 'x', status), none()))).toMatchObject({
        stage: 'probe',
        errorClass: 'unavailable',
      })
    }
  })

  it('turns each failure into a probe error that says nothing about the response', () => {
    const fail = (failure: 'redirect-refused' | 'too-large' | 'network' | 'aborted', redirects = none()) =>
      thrown(() => probeResult({ ok: false, failure }, redirects))
    expect(fail('too-large')).toMatchObject({ stage: 'probe', errorClass: 'unexpected-shape' })
    expect(fail('network')).toMatchObject({ stage: 'probe', errorClass: 'unavailable' })
    expect(fail('aborted')).toMatchObject({ stage: 'probe', errorClass: 'aborted' })
    expect(fail('redirect-refused')).toMatchObject({ stage: 'probe', errorClass: 'host-not-allowed' })
    const offList = none()
    offList.allow('https://evil.test/')
    expect(fail('redirect-refused', offList)).toMatchObject({ errorClass: 'host-not-allowed' })
    const tooMany = none()
    for (let hop = 0; hop <= MAX_PROBE_REDIRECTS; hop++) tooMany.allow('https://www.example.com/')
    expect(fail('redirect-refused', tooMany)).toMatchObject({ errorClass: 'unavailable' })
  })

  it('caps the body at 1 MiB', () => {
    expect(MAX_PROBE_BYTES).toBe(1024 * 1024)
  })
})
