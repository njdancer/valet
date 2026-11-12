// `ctx.local.fetch` (a `network` exception) and `ctx.local.service` (a `local-service` exception),
// enforced in the main process (docs/sandbox.md#exceptions-capabilities-enforced-in-main).
//
// fetch: https on 443 only, to a declared host, dialled only at a public address (checked on the
// address the socket is given, so a DNS answer that points home goes nowhere), redirects returned
// not followed, no cookies, size and time capped. service: http to 127.0.0.1 on a declared port,
// never a name.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { hostAllowed, type LocalRequestInit, type LocalResponse, ValetError } from '@valet/core'

export const MAX_BODY_BYTES = 4 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 30_000
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
/** Headers Valet sets or refuses: tool code can't name a host, a cookie, or proxy credentials. */
const REFUSED_HEADERS = new Set([
  'host',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'content-length',
])

/** Every range that isn't the public internet: loopback, private, link-local, CGNAT, ULA, and the rest. */
const NOT_PUBLIC = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NOT_PUBLIC.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  NOT_PUBLIC.addSubnet(net, bits, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  // An IPv4-mapped IPv6 address is the IPv4 one. BlockList matches IPv4 against mapped IPv6
  // subnets on its own, so the mapped range can't sit in the list; it's unwrapped here instead.
  const mapped = /^::ffff:(.+)$/i.exec(address)
  if (family === 6 && mapped !== null) {
    const rest = mapped[1] as string
    if (isIP(rest) === 4) return isPublicAddress(rest)
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest)
    if (hex === null) return false
    const n = (Number.parseInt(hex[1] as string, 16) << 16) | Number.parseInt(hex[2] as string, 16)
    return isPublicAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'))
  }
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

type Lookup = (hostname: string, callback: (error: Error | null, addresses: LookupAddress[]) => void) => void

export const systemLookup: Lookup = (hostname, callback) =>
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => callback(error, addresses ?? []))

const fail = (
  errorClass: 'not-granted' | 'host-not-allowed' | 'invalid' | 'unavailable' | 'unexpected-shape',
) => new ValetError('tool-run', errorClass)

interface Prepared {
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: Buffer | null
  readonly responseEncoding: 'utf8' | 'base64'
}

function prepare(init: unknown): Prepared {
  if (init !== undefined && init !== null && typeof init !== 'object') throw fail('invalid')
  const i = (init ?? {}) as Partial<Record<keyof LocalRequestInit, unknown>>
  const method = i.method === undefined ? 'GET' : i.method
  if (typeof method !== 'string' || !METHODS.has(method)) throw fail('invalid')
  const headers: Record<string, string> = {}
  if (i.headers !== undefined) {
    if (i.headers === null || typeof i.headers !== 'object' || Array.isArray(i.headers)) throw fail('invalid')
    const entries = Object.entries(i.headers as Record<string, unknown>)
    if (entries.length > 50) throw fail('invalid')
    for (const [name, value] of entries) {
      const lower = name.toLowerCase()
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(lower)) throw fail('invalid')
      if (typeof value !== 'string' || value.length > 8_000 || /[\r\n\0]/.test(value)) throw fail('invalid')
      if (REFUSED_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-'))
        throw fail('invalid')
      headers[lower] = value
    }
  }
  const bodyEncoding = i.bodyEncoding ?? 'utf8'
  const responseEncoding = i.responseEncoding ?? 'utf8'
  if (
    (bodyEncoding !== 'utf8' && bodyEncoding !== 'base64') ||
    (responseEncoding !== 'utf8' && responseEncoding !== 'base64')
  )
    throw fail('invalid')
  let body: Buffer | null = null
  if (i.body !== undefined) {
    if (typeof i.body !== 'string' || method === 'GET' || method === 'HEAD') throw fail('invalid')
    body = Buffer.from(i.body, bodyEncoding)
    if (body.byteLength > MAX_BODY_BYTES) throw fail('invalid')
  }
  return { method, headers, body, responseEncoding }
}

function send(
  client: typeof http | typeof https,
  options: http.RequestOptions,
  prepared: Prepared,
  timeoutMs: number,
): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const request = client.request({
      ...options,
      method: prepared.method,
      headers: prepared.headers,
      agent: false,
    })
    const timer = setTimeout(() => request.destroy(fail('unavailable')), timeoutMs)
    const done = (error: ValetError | null, value?: LocalResponse) => {
      clearTimeout(timer)
      if (error !== null) reject(error)
      else resolve(value as LocalResponse)
    }
    request.on('error', (error) => done(error instanceof ValetError ? error : fail('unavailable')))
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > MAX_BODY_BYTES) {
          response.destroy()
          done(fail('unexpected-shape'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', () => done(fail('unavailable')))
      response.on('end', () => {
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(response.headers)) {
          if (name === 'set-cookie' || value === undefined) continue
          headers[name] = Array.isArray(value) ? value.join(', ') : value
        }
        done(null, {
          status: response.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks).toString(prepared.responseEncoding),
        })
      })
    })
    if (prepared.body !== null) request.end(prepared.body)
    else request.end()
  })
}

export interface NetOptions {
  /** Declared host patterns, or 'open' (unsandboxed: any public host). */
  readonly hosts: readonly string[] | 'open'
  readonly lookup?: Lookup
  /** Tests point https at a local server they trust; the app never sets these. */
  readonly httpsPort?: number
  readonly ca?: string | Buffer
  readonly timeoutMs?: number
  /** Tests only: an address a test server listens on that the real rule would refuse. */
  readonly testAddress?: string
}

export function localFetch(options: NetOptions) {
  const lookup = options.lookup ?? systemLookup
  return async (urlValue: unknown, init?: unknown): Promise<LocalResponse> => {
    if (options.hosts !== 'open' && options.hosts.length === 0) throw fail('not-granted')
    if (typeof urlValue !== 'string' || urlValue.length > 4_000) throw fail('invalid')
    let url: URL
    try {
      url = new URL(urlValue)
    } catch {
      throw fail('invalid')
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '')
      throw fail('invalid')
    const host = url.hostname.toLowerCase()
    if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) throw fail('host-not-allowed')
    if (options.hosts !== 'open' && !hostAllowed(host, options.hosts)) throw fail('not-granted')
    const prepared = prepare(init)
    // Node may ask for one address or (happy eyeballs) all of them; either way only checked ones.
    const checkedLookup = (
      hostname: string,
      opts: { all?: boolean } | undefined,
      callback: (...args: unknown[]) => void,
    ): void => {
      lookup(hostname, (error, addresses) => {
        if (error !== null || addresses.length === 0) return callback(fail('unavailable'))
        // Every answer must be public, not just the first: a name that answers both ways is refused.
        if (!addresses.every((a) => isPublicAddress(a.address) || a.address === options.testAddress))
          return callback(fail('host-not-allowed'))
        if (opts?.all === true) return callback(null, addresses)
        const first = addresses[0] as LookupAddress
        callback(null, first.address, first.family)
      })
    }
    return send(
      https,
      {
        host,
        servername: host,
        port: options.httpsPort ?? 443,
        path: `${url.pathname}${url.search}`,
        lookup: checkedLookup as never,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      } as https.RequestOptions,
      prepared,
      options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    )
  }
}

export interface ServiceOptions {
  /** Declared ports, or 'open' (unsandboxed: any port above 1023). */
  readonly ports: readonly number[] | 'open'
  /**
   * Valet's own loopback ports (the MCP endpoint, the OAuth server, helpers), asked at each call
   * because some move: a local-service exception never reaches Valet itself.
   */
  readonly refusedPorts?: () => readonly number[]
  readonly timeoutMs?: number
}

export function localService(options: ServiceOptions) {
  return async (portValue: unknown, pathValue: unknown, init?: unknown): Promise<LocalResponse> => {
    if (options.ports !== 'open' && options.ports.length === 0) throw fail('not-granted')
    if (
      typeof portValue !== 'number' ||
      !Number.isInteger(portValue) ||
      portValue < 1024 ||
      portValue > 65535
    )
      throw fail('invalid')
    if (options.ports !== 'open' && !options.ports.includes(portValue)) throw fail('not-granted')
    if (options.refusedPorts?.().includes(portValue)) throw fail('host-not-allowed')
    if (
      typeof pathValue !== 'string' ||
      !/^\/[\x21-\x7e]{0,2000}$/.test(pathValue) ||
      pathValue.startsWith('//')
    )
      throw fail('invalid')
    const prepared = prepare(init)
    return send(
      http,
      { host: '127.0.0.1', port: portValue, path: pathValue, setHost: false, headers: {} },
      { ...prepared, headers: { ...prepared.headers, host: `127.0.0.1:${portValue}` } },
      options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    )
  }
}
