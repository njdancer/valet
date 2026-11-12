// The Worker's front door (docs/relay-worker.md, "Forwarded HTTP" and "Consent"): everything that
// can be decided before a Mac's Durable Object is involved. Routing by host and path, the Origin
// rule, per-source limits, body and JSON-RPC checks, and the signed wait token for consent polls.

import { KEY_ID } from '@valet/core/devices'
import {
  RELAY_CONSENT_PATH,
  RELAY_FORWARDED_HEADERS,
  RELAY_FORWARDED_PATHS,
  RELAY_LIMITS,
} from '@valet/core/relay-protocol'
import { byteLength, type ConsentAnswer, type ForwardRequest, type RecoverResult } from './core'
import { fromBase64url, randomToken, toBase64url } from './encoding'
import { problemPage, recoveryPage, redirectResponse, waitingPage } from './pages'

/** WebCrypto's key type, named so it reads the same under Node's and Workers' type definitions. */
type ImportedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** What the front door needs from a Mac's Durable Object. */
export interface MacRelayStub {
  connect(request: Request, role: 'mac' | 'phone'): Promise<Response>
  forward(request: ForwardRequest, signal: AbortSignal): Promise<Response>
  consent(id: string, query: string, source: string): Promise<ConsentAnswer>
  recover(code: string, unregisterPhones: boolean): Promise<RecoverResult>
}

export interface FrontDoor {
  /** The bare relay host, e.g. relay.example. Each Mac is `<macId>.<host>`. */
  readonly host: string
  /** HMAC key for wait tokens, raw bytes. */
  readonly waitKey: ImportedKey
  readonly mac: (macId: string) => MacRelayStub
  readonly limits: {
    /** Device connections, per source. */
    readonly connect: RateLimiter
    /** Every forwarded request, per Mac and source. */
    readonly forward: RateLimiter
    /** /register, /token and new /authorize, per Mac and source. */
    readonly signIn: RateLimiter
    /** Consent page polls, per Mac and source. */
    readonly poll: RateLimiter
  }
  readonly now?: () => number
}

const DEVICE_PATH = /^\/v1\/(mac|phone)\/([0-9a-f]{32})$/
const FORWARDED = new Set<string>(RELAY_FORWARDED_PATHS)
const SIGN_IN_PATHS = new Set(['/register', '/token'])
const MAX_HEADER_VALUE = 8192
const WAIT_TOKEN_TTL_MS = 6 * 60_000
/** The recovery page, on the Mac's own host so the code needs no lookup. Never forwarded. */
export const RECOVERY_PATH = '/recover'
const MAX_RECOVERY_BODY = 1024

export async function frontDoor(request: Request, door: FrontDoor): Promise<Response> {
  const url = new URL(request.url)
  const host = url.hostname.toLowerCase()
  const source = request.headers.get('cf-connecting-ip') ?? ''

  const suffix = `.${door.host}`
  const macId = host.endsWith(suffix) ? host.slice(0, -suffix.length) : null
  if (macId === null || !KEY_ID.test(macId)) {
    // Device connections. On any host but a Mac's: only the relay's own names are routed here.
    const match = DEVICE_PATH.exec(url.pathname)
    if (
      match === null ||
      request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
      request.method !== 'GET'
    )
      return notFound()
    if (!(await allowed(door.limits.connect, `connect:${sourceKey(source)}`))) return tooMany()
    return door.mac(match[2] as string).connect(request, match[1] as 'mac' | 'phone')
  }
  const key = `${macId}:${sourceKey(source)}`

  if (url.pathname === RELAY_CONSENT_PATH) return consent(request, url, door, macId, key, source)
  if (url.pathname === RECOVERY_PATH) return recover(request, url, door, macId, key)
  if (!FORWARDED.has(url.pathname)) return notFound()
  const method = request.method
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE')
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { allow: 'GET, POST, DELETE' } },
    )
  // The relay drops Origin with every other header it doesn't forward, so it refuses what the
  // Mac's own Origin guard would have refused (remote-auth.ts, remoteRequestHost).
  if (request.headers.has('origin')) return Response.json({ error: 'forbidden' }, { status: 403 })
  if (!(await allowed(door.limits.forward, key))) return tooMany()
  if (SIGN_IN_PATHS.has(url.pathname) && !(await allowed(door.limits.signIn, key))) return tooMany()

  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search
  if (query.length > 2048) return Response.json({ error: 'uri_too_long' }, { status: 414 })
  const headers: Record<string, string> = {}
  for (const name of RELAY_FORWARDED_HEADERS) {
    const value = request.headers.get(name)
    if (value === null) continue
    if (value.length > MAX_HEADER_VALUE) return Response.json({ error: 'header_too_large' }, { status: 431 })
    headers[name] = value
  }
  const body = await readBody(request)
  if (body === null) return Response.json({ error: 'body_too_large' }, { status: 413 })
  if (method === 'POST' && url.pathname === '/mcp' && !isJsonRpc(body))
    return Response.json({ error: 'not_json_rpc' }, { status: 400 })
  // GET and DELETE carry nothing: the relay is not a general tunnel.
  if (method !== 'POST' && body !== '') return Response.json({ error: 'unexpected_body' }, { status: 400 })

  return door.mac(macId).forward(
    {
      method,
      path: url.pathname as ForwardRequest['path'],
      query,
      headers,
      body,
      source,
      stream: method === 'GET' && url.pathname === '/mcp',
    },
    request.signal,
  )
}

// ---------- Recovery ----------

async function recover(
  request: Request,
  url: URL,
  door: FrontDoor,
  macId: string,
  key: string,
): Promise<Response> {
  // The code only ever travels in a POST body, never a URL, so it stays out of logs and history.
  if (url.search !== '') return recoveryPage('form', 400)
  if (request.method === 'GET') return recoveryPage('form', 200)
  if (request.method !== 'POST') return recoveryPage('form', 405)
  // The form posts from this page only (form-action 'self'); a page elsewhere can't post for you.
  if (request.headers.get('origin') !== `https://${macId}.${door.host}`) return recoveryPage('form', 403)
  if (!(await allowed(door.limits.signIn, `recover:${key}`))) return recoveryPage('too-many', 429)
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
    return recoveryPage('form', 415)
  const length = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isFinite(length) || length > MAX_RECOVERY_BODY) return recoveryPage('form', 413)
  const text = await request.text()
  if (byteLength(text) > MAX_RECOVERY_BODY) return recoveryPage('form', 413)
  const form = new URLSearchParams(text)
  const code = form.get('code') ?? ''
  const phones = form.get('phones') === 'remove'
  const result = await door.mac(macId).recover(code, phones)
  // A Mac with no code set reads as a wrong code, so the page says nothing about which Macs have one.
  if (result === 'done') return recoveryPage(phones ? 'done-phones' : 'done', 200)
  if (result === 'too-many') return recoveryPage('too-many', 429)
  return recoveryPage('wrong', 403)
}

// ---------- Consent ----------

async function consent(
  request: Request,
  url: URL,
  door: FrontDoor,
  macId: string,
  key: string,
  source: string,
): Promise<Response> {
  if (request.method !== 'GET') return problemPage('not-found', 405)
  const params = url.searchParams
  const wait = params.get('wait')
  const now = (door.now ?? Date.now)()

  if (wait !== null) {
    // A poll carries nothing but its token; anything else is someone building their own URL.
    if ([...params.keys()].length !== 1) return problemPage('ended', 400)
    const token = await openWaitToken(door.waitKey, wait, macId, now)
    if (token === null) return problemPage('ended', 404)
    if (!(await allowed(door.limits.poll, key))) return problemPage('too-many', 429)
    const answer = await door.mac(macId).consent(token.id, '', source)
    return render(answer, wait, token.redirect)
  }

  if (!(await allowed(door.limits.signIn, key))) return problemPage('too-many', 429)
  const query = url.search.slice(1)
  if (query.length === 0 || query.length > 4096) return problemPage('cant-go-on', 400)
  // In relay mode the client must name its redirect URI, so the relay can hold the Mac to it.
  const redirects = params.getAll('redirect_uri')
  if (redirects.length !== 1 || !isHttps(redirects[0] as string)) return problemPage('cant-go-on', 400)
  const redirect = redirects[0] as string
  const id = randomToken(15)
  const answer = await door.mac(macId).consent(id, query, source)
  const token = await sealWaitToken(door.waitKey, { id, macId, redirect, exp: now + WAIT_TOKEN_TTL_MS })
  return render(answer, token, redirect)
}

function render(answer: ConsentAnswer, token: string, redirect: string): Response {
  switch (answer.state) {
    case 'waiting':
      return waitingPage(answer.code, token)
    case 'approved':
      // Only ever back to the redirect URI the client named. A "Mac" is any program with a key,
      // and could name any URI for itself, so only an approval redirects: errors get the relay's
      // own page, and a stranger's client can't bounce people through a real Mac's host.
      if (answer.redirect !== undefined && sameTarget(answer.redirect, redirect))
        return redirectResponse(answer.redirect)
      return problemPage('cant-go-on', 400)
    case 'declined':
      return answer.redirect === undefined ? problemPage('cant-go-on', 400) : problemPage('declined', 403)
    case 'expired':
      return problemPage('ended', 404)
    case 'offline':
      return problemPage('mac-offline', 503)
    case 'no-answer':
      return problemPage('no-answer', 504)
    case 'closed':
      return problemPage('closed', 403)
    case 'busy':
    case 'too-many':
      return problemPage('too-many', 429)
    case 'locked':
      return problemPage('locked', 503)
  }
}

function sameTarget(location: string, redirect: string): boolean {
  try {
    const a = new URL(location)
    const b = new URL(redirect)
    return a.protocol === 'https:' && a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return false
  }
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

interface WaitToken {
  readonly id: string
  readonly macId: string
  readonly redirect: string
  readonly exp: number
}

/** `<payload>.<mac>`, both base64url; the payload is the JSON of a WaitToken. */
export async function sealWaitToken(key: ImportedKey, token: WaitToken): Promise<string> {
  const payload = toBase64url(new TextEncoder().encode(JSON.stringify(token)))
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${toBase64url(new Uint8Array(mac))}`
}

export async function openWaitToken(
  key: ImportedKey,
  text: string,
  macId: string,
  now: number,
): Promise<WaitToken | null> {
  if (text.length > 1200) return null
  const [payload, mac, extra] = text.split('.')
  if (payload === undefined || mac === undefined || extra !== undefined) return null
  const signature = fromBase64url(mac)
  const bytes = fromBase64url(payload)
  if (signature === null || bytes === null) return null
  const ok = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(payload))
  if (!ok) return null
  try {
    const token = JSON.parse(new TextDecoder().decode(bytes)) as WaitToken
    if (token.macId !== macId || typeof token.exp !== 'number' || token.exp < now) return null
    if (typeof token.id !== 'string' || !/^[A-Za-z0-9_-]{20}$/.test(token.id)) return null
    if (typeof token.redirect !== 'string') return null
    return token
  } catch {
    return null
  }
}

export async function waitKey(secret: string | undefined): Promise<ImportedKey> {
  // Without a configured secret (local development), a fresh key per isolate: polls that land on
  // another isolate end, which is harmless.
  const raw =
    secret === undefined || secret === ''
      ? crypto.getRandomValues(new Uint8Array(32))
      : new TextEncoder().encode(secret)
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

// ---------- Helpers ----------

/** The body as text, or null above the cap. */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > RELAY_LIMITS.maxRequestBodyBytes) return null
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > RELAY_LIMITS.maxRequestBodyBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.length
  }
  const text = new TextDecoder().decode(all)
  return byteLength(text) > RELAY_LIMITS.maxRequestBodyBytes ? null : text
}

/** A JSON-RPC 2.0 message or a non-empty batch of them; the relay is not a general tunnel. */
export function isJsonRpc(body: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return false
  }
  const one = (m: unknown) =>
    typeof m === 'object' && m !== null && !Array.isArray(m) && (m as { jsonrpc?: unknown }).jsonrpc === '2.0'
  if (Array.isArray(value)) return value.length > 0 && value.length <= 100 && value.every(one)
  return one(value)
}

/**
 * The key a source is limited by: an IPv4 address as it is, an IPv6 address by its /64, since
 * one host commonly holds a whole /64. Empty when Cloudflare didn't say.
 */
export function sourceKey(address: string): string {
  const value = address.trim().toLowerCase()
  if (!value.includes(':')) return value
  const [head = '', tail = ''] = value.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === '' ? [] : tail.split(':')
  const groups = value.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

async function allowed(limiter: RateLimiter, key: string): Promise<boolean> {
  try {
    return (await limiter.limit({ key })).success
  } catch {
    // A limiter that fails shuts, not opens.
    return false
  }
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  })
}

function tooMany(): Response {
  return Response.json({ error: 'too_many_requests' }, { status: 429, headers: { 'retry-after': '60' } })
}
