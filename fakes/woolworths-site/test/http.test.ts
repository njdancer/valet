import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { hostnameOf, originFor, parseCookies, readBody, recordRequest, serializeCookie } from '../src/http'

function message(chunks: string[], fields: Partial<IncomingMessage> = {}): IncomingMessage {
  return Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), fields) as unknown as IncomingMessage
}

describe('readBody', () => {
  it('reads every chunk', async () => {
    expect(await readBody(message(['ab', 'cd']))).toEqual({ text: 'abcd', truncated: false })
  })

  it('keeps only up to the limit and says it truncated', async () => {
    expect(await readBody(message(['abc', 'def', 'ghi']), 5)).toEqual({ text: 'abcde', truncated: true })
  })

  it('is not truncated at exactly the limit', async () => {
    expect(await readBody(message(['abc', 'de']), 5)).toEqual({ text: 'abcde', truncated: false })
  })
})

describe('recordRequest', () => {
  it('records method, host, path, query, headers and body', () => {
    const request = message([], {
      method: 'POST',
      url: '/apis/ui/Search/products?searchTerm=milk&a=1&a=2',
      headers: { host: 'www.woolworths.test:8443', 'x-many': ['a', 'b'], cookie: 'a=b' },
    } as Partial<IncomingMessage>)
    expect(recordRequest(request, '{"x":1}', 123)).toEqual({
      method: 'POST',
      host: 'www.woolworths.test',
      path: '/apis/ui/Search/products',
      query: { searchTerm: 'milk', a: '2' },
      headers: { host: 'www.woolworths.test:8443', 'x-many': 'a, b', cookie: 'a=b' },
      body: '{"x":1}',
      at: 123,
    })
  })

  it('copes with a request missing its method and URL', () => {
    const recorded = recordRequest(message([], { headers: {} } as Partial<IncomingMessage>), '', 0)
    expect(recorded).toMatchObject({ method: 'GET', host: '', path: '/', query: {} })
  })
})

describe('hostnameOf', () => {
  it('strips the port', () => {
    expect(hostnameOf('127.0.0.1:1234')).toBe('127.0.0.1')
    expect(hostnameOf('[::1]:1234')).toBe('[::1]')
    expect(hostnameOf('Evil.Test')).toBe('evil.test')
  })

  it('returns empty for a missing or unparseable host', () => {
    expect(hostnameOf(undefined)).toBe('')
    expect(hostnameOf('')).toBe('')
    expect(hostnameOf('a b')).toBe('')
  })
})

describe('parseCookies', () => {
  it('parses name=value pairs', () => {
    expect(parseCookies('a=1; b=two=2;c=3')).toEqual(
      new Map([
        ['a', '1'],
        ['b', 'two=2'],
        ['c', '3'],
      ]),
    )
  })

  it('keeps the first of a repeated name', () => {
    expect(parseCookies('a=first; a=second').get('a')).toBe('first')
  })

  it('skips malformed pairs and copes with no header', () => {
    expect(parseCookies('novalue; =x; ok=1')).toEqual(new Map([['ok', '1']]))
    expect(parseCookies(undefined).size).toBe(0)
  })
})

describe('serializeCookie', () => {
  it('writes a session cookie', () => {
    expect(serializeCookie('a', 'b', { httpOnly: true, secure: false })).toBe(
      'a=b; Path=/; SameSite=Lax; HttpOnly',
    )
  })

  it('writes a persistent secure cookie', () => {
    expect(serializeCookie('a', 'b', { httpOnly: false, secure: true, maxAge: 60 })).toBe(
      'a=b; Path=/; SameSite=Lax; Max-Age=60; Secure',
    )
  })
})

describe('originFor', () => {
  it('uses http without TLS and https with it', () => {
    expect(originFor(undefined, '127.0.0.1', 80)).toBe('http://127.0.0.1:80')
    expect(originFor({ key: 'k', cert: 'c' }, 'www.woolworths.test', 8443)).toBe(
      'https://www.woolworths.test:8443',
    )
  })

  it('brackets an IPv6 host', () => {
    expect(originFor(undefined, '::1', 80)).toBe('http://[::1]:80')
  })
})
