import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  hostnameOf,
  originFor,
  parseCookies,
  parseTarget,
  readBody,
  recordRequest,
  serializeCookie,
} from '../src/http'

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
      rawHeaders: ['Host', 'www.woolworths.test:8443', 'X-Many', 'a', 'X-Many', 'b', 'Cookie', 'a=b'],
    } as Partial<IncomingMessage>)
    expect(recordRequest(request, '{"x":1}', 123)).toEqual({
      method: 'POST',
      host: 'www.woolworths.test',
      target: '/apis/ui/Search/products?searchTerm=milk&a=1&a=2',
      path: '/apis/ui/Search/products',
      query: { searchTerm: 'milk', a: '2' },
      headers: { host: 'www.woolworths.test:8443', 'x-many': 'a, b', cookie: 'a=b' },
      rawHeaders: ['Host', 'www.woolworths.test:8443', 'X-Many', 'a', 'X-Many', 'b', 'Cookie', 'a=b'],
      body: '{"x":1}',
      at: 123,
    })
  })

  it('copes with a request missing its method and URL', () => {
    const recorded = recordRequest(message([], { headers: {} } as Partial<IncomingMessage>), '', 0)
    expect(recorded).toMatchObject({
      method: 'GET',
      host: '',
      target: '/',
      path: '/',
      query: {},
      rawHeaders: [],
    })
  })
})

describe('parseTarget', () => {
  it('keeps a leading double slash in the path instead of reading it as a host', () => {
    const target = parseTarget('//api/v3/ui/checkout/order?x=1')
    expect(target.path).toBe('//api/v3/ui/checkout/order')
    expect(target.params.get('x')).toBe('1')
  })

  it('resolves dot segments, encoded ones included, and keeps every repeated parameter', () => {
    const target = parseTarget('/a/./b/../%2e%2e/c?k=1&k=2')
    expect(target.path).toBe('/c')
    expect(target.params.getAll('k')).toEqual(['1', '2'])
  })

  it('takes the path of an absolute-form target, as sent to a proxy', () => {
    expect(parseTarget('http://evil.test/collect?c=1').path).toBe('/collect')
  })

  it('gives anything else, such as an asterisk, the root path', () => {
    expect(parseTarget('*').path).toBe('/')
    expect(parseTarget('').path).toBe('/')
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
