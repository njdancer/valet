// Plumbing shared by the fake site and the exfiltration sink: request recording, bodies, cookies,
// and starting and stopping real node:http or node:https servers on port 0.

import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  readonly method: string
  /** Hostname from the Host header, without the port. */
  readonly host: string
  /** Path without the query string. */
  readonly path: string
  /** Query parameters; a repeated key keeps its last value. */
  readonly query: Readonly<Record<string, string>>
  /** Lower-cased header names. Repeated headers are joined with ", ". */
  readonly headers: Readonly<Record<string, string>>
  /** The body as UTF-8, cut at `MAX_BODY_BYTES`. */
  readonly body: string
  /** When the request arrived, from the server's clock (ms). */
  readonly at: number
}

export interface TlsOptions {
  readonly key: string
  readonly cert: string
}

export const MAX_BODY_BYTES = 1_000_000

export interface Body {
  readonly text: string
  readonly truncated: boolean
}

/** Reads the whole body, keeping at most `limit` bytes. The rest is drained so the socket stays usable. */
export async function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Body> {
  const chunks: Buffer[] = []
  let kept = 0
  let truncated = false
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    const room = limit - kept
    if (buffer.length > room) truncated = true
    if (room > 0) {
      const part = buffer.subarray(0, room)
      chunks.push(part)
      kept += part.length
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

export function hostnameOf(hostHeader: string | undefined): string {
  if (hostHeader === undefined || hostHeader === '') return ''
  try {
    return new URL(`http://${hostHeader}`).hostname
  } catch {
    return ''
  }
}

export function recordRequest(request: IncomingMessage, body: string, at: number): RecordedRequest {
  const url = new URL(request.url ?? '/', 'http://fake.invalid')
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return {
    method: request.method ?? 'GET',
    host: hostnameOf(request.headers.host),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body,
    at,
  }
}

/** Parses a Cookie header. The first occurrence of a name wins, as browsers send the most specific first. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const raw of (header ?? '').split(';')) {
    const pair = raw.trim()
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index)
    if (!cookies.has(name)) cookies.set(name, pair.slice(index + 1))
  }
  return cookies
}

export interface CookieOptions {
  readonly httpOnly: boolean
  readonly secure: boolean
  /** Seconds. Omit for a session cookie; 0 deletes the cookie. */
  readonly maxAge?: number
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Lax']
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export function createServer(tls: TlsOptions | undefined): Server {
  return tls === undefined ? createHttpServer() : createHttpsServer({ key: tls.key, cert: tls.cert })
}

/** Listens on 127.0.0.1. Port 0 picks a free port. */
export async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

/** Closes the server, cutting off keep-alive connections so tests don't hang. */
export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
  await closed
}

export function originFor(tls: TlsOptions | undefined, hostname: string, port: number): string {
  const host = hostname.includes(':') ? `[${hostname}]` : hostname
  return `${tls === undefined ? 'http' : 'https'}://${host}:${port}`
}
