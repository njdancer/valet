// Fake services for the example adapters (examples/, docs/adapter-kinds.md#h-example-adapters), on
// loopback: one HTTPS server that answers as Hacker News's API, BBC News's RSS feeds, GitHub's
// release feeds and iCloud's CalDAV and CardDAV, by the Host it was asked for; a home hub on the
// person's network (plain http, with a WebSocket API); and a Redis-style cache over TLS. Every
// request, socket message and cache command is recorded, so a test can check what reached it.
//
// `route` is for the egress broker's test hooks: it sends each declared endpoint to the right one.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { createServer as createTlsServer, type TLSSocket } from 'node:tls'
import { generateTestCertificate } from '@valet/fake-woolworths-site'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  BBC_FEEDS,
  BBC_HOST,
  CALDAV_HOST,
  CALDAV_PARTITION,
  CARDDAV_HOST,
  CARDDAV_PARTITION,
  type Calendar,
  GITHUB_HOST,
  GITHUB_RELEASES,
  HN_HOST,
  HN_ITEMS,
  HN_LISTS,
  HUB_PORT,
  HUB_TOKEN,
  type HubEntity,
  initialCalendars,
  initialEntities,
  REDIS_DATA,
  REDIS_PASSWORD,
  REDIS_PORT,
  REDIS_USER,
  TLS_HOSTS,
} from './data'
import { caldav, carddav } from './dav'

export * from './data'
export { authorized, icsOf, vcardOf } from './dav'

export interface SeenRequest {
  readonly host: string
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
  /** The TLS server name asked for; null on the hub's plain http. */
  readonly servername: string | null
}

export interface ExampleServices {
  /** PEM of the self-signed certificate every TLS service serves: trust it as the CA. */
  readonly cert: string
  readonly httpsPort: number
  readonly hubPort: number
  readonly redisPort: number
  readonly seen: SeenRequest[]
  /** Every message the hub received, as text. */
  readonly hubMessages: string[]
  /** Every cache command, as its words; AUTH's password replaced with "***". */
  readonly redisCommands: string[][]
  /** The TLS server names cache connections asked for. */
  readonly redisServernames: (string | null)[]
  readonly calendars: Calendar[]
  readonly entities: HubEntity[]
  /** For the broker's `testing.route`: 443 to HTTPS, the hub's and the cache's ports to theirs. */
  route(address: string, port: number): { address: string; port: number }
  close(): Promise<void>
}

export async function startExampleServices(): Promise<ExampleServices> {
  const cert = await generateTestCertificate(TLS_HOSTS)
  const seen: SeenRequest[] = []
  const hubMessages: string[] = []
  const redisCommands: string[][] = []
  const redisServernames: (string | null)[] = []
  const calendars = initialCalendars()
  const entities = initialEntities()
  const sockets = new Set<Duplex>()
  const track = (s: Duplex) => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
  }

  const collect = (req: IncomingMessage, then: (body: string) => void) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => then(Buffer.concat(chunks).toString('utf8')))
  }
  const record = (req: IncomingMessage, body: string) => {
    const socket = req.socket as { servername?: unknown }
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '')
    seen.push({
      host,
      method: req.method ?? '',
      url: req.url ?? '',
      headers: { ...req.headers },
      body,
      servername: typeof socket.servername === 'string' ? socket.servername : null,
    })
    return host
  }

  const https = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) =>
    collect(req, (body) => {
      const host = record(req, body)
      // The certificate's name must be the host asked for: a request sent under another name is
      // what a misdirected client would do.
      const servername = (req.socket as { servername?: unknown }).servername
      if (servername !== host) return plain(res, 421, 'misdirected')
      if (host === HN_HOST) return hackerNews(req, res)
      if (host === BBC_HOST) return bbc(req, res)
      if (host === GITHUB_HOST) return github(req, res)
      if (host === CALDAV_HOST || host === CALDAV_PARTITION) return caldav(req, res, host, body, calendars)
      if (host === CARDDAV_HOST || host === CARDDAV_PARTITION) return carddav(req, res, host, body)
      return plain(res, 404, 'no such host')
    }),
  )
  https.on('connection', track)

  const hub = createHttpServer((req, res) =>
    collect(req, (body) => {
      record(req, body)
      plain(res, 404, 'use the WebSocket API')
    }),
  )
  hub.on('connection', track)
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  hub.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    record(req, '')
    if (req.url !== '/api/websocket') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (req.headers.authorization !== `Bearer ${HUB_TOKEN}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => hubSession(ws, entities, hubMessages))
  })

  const redis = createTlsServer({ key: cert.key, cert: cert.cert }, (socket) => {
    redisServernames.push(typeof socket.servername === 'string' ? socket.servername : null)
    redisSession(socket, redisCommands)
  })
  redis.on('connection', track)
  redis.on('secureConnection', track)

  const listen = (server: { listen: (port: number, host: string, cb: () => void) => unknown }) =>
    new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  await Promise.all([listen(https), listen(hub), listen(redis)])
  const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port
  const httpsPort = port(https)
  const hubPort = port(hub)
  const redisPort = port(redis)
  return {
    cert: cert.cert,
    httpsPort,
    hubPort,
    redisPort,
    seen,
    hubMessages,
    redisCommands,
    redisServernames,
    calendars,
    entities,
    route: (_address, p) => ({
      address: '127.0.0.1',
      port: p === HUB_PORT ? hubPort : p === REDIS_PORT ? redisPort : httpsPort,
    }),
    close: async () => {
      for (const client of wss.clients) client.terminate()
      for (const s of sockets) s.destroy()
      await Promise.all(
        [https, hub, redis].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      )
    },
  }
}

function plain(res: ServerResponse, status: number, text: string): true {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(text)
  return true
}

function json(res: ServerResponse, value: unknown): true {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
  return true
}

/** Hacker News's Firebase API: lists of ids, and one item or user per request. */
function hackerNews(req: IncomingMessage, res: ServerResponse): true {
  const path = new URL(req.url ?? '/', 'https://x').pathname
  if (req.method !== 'GET') return plain(res, 405, '')
  const list = /^\/v0\/([a-z]+)\.json$/.exec(path)
  if (list !== null && HN_LISTS[list[1] as string] !== undefined)
    return json(res, HN_LISTS[list[1] as string])
  const item = /^\/v0\/item\/(\d+)\.json$/.exec(path)
  if (item !== null) return json(res, HN_ITEMS.find((i) => String(i.id) === item[1]) ?? null)
  return plain(res, 404, '')
}

function bbc(req: IncomingMessage, res: ServerResponse): true {
  const path = new URL(req.url ?? '/', 'https://x').pathname
  const feed = BBC_FEEDS[path]
  if (req.method !== 'GET' || feed === undefined) return plain(res, 404, '')
  res.writeHead(200, { 'content-type': 'application/rss+xml' })
  res.end(feed)
  return true
}

function github(req: IncomingMessage, res: ServerResponse): true {
  const path = new URL(req.url ?? '/', 'https://x').pathname
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\.atom$/.exec(path)
  const releases = match === null ? undefined : GITHUB_RELEASES[`${match[1]}/${match[2]}`]
  if (req.method !== 'GET' || match === null || releases === undefined) return plain(res, 404, 'Not Found')
  const repo = `${match[1]}/${match[2]}`
  const entries = releases
    .map(
      (r) =>
        `<entry><id>tag:github.com,2008:Repository/1/${r.tag}</id><updated>${r.date}</updated>` +
        `<link rel="alternate" type="text/html" href="https://github.com/${repo}/releases/tag/${r.tag}"/>` +
        `<title>${r.tag}</title><content type="html">${r.notes.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</content>` +
        '<author><name>releaser</name></author></entry>',
    )
    .join('')
  res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' })
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">` +
      `<id>tag:github.com,2008:https://github.com/${repo}/releases</id><title>Release notes from ${match[2]}</title>` +
      `<updated>${releases[0]?.date ?? ''}</updated><link rel="alternate" type="text/html" href="https://github.com/${repo}/releases"/>` +
      `${entries}</feed>`,
  )
  return true
}

/**
 * The hub's WebSocket API, shaped like a home-automation hub's: the token on the upgrade, then
 * numbered requests (get_states, call_service) each answered by a result with the same id.
 */
function hubSession(ws: WebSocket, entities: HubEntity[], messages: string[]): void {
  ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.11.0' }))
  ws.on('message', (data) => {
    const text = String(data)
    messages.push(text)
    let message: { id?: unknown; type?: unknown; domain?: unknown; service?: unknown; target?: unknown }
    try {
      message = JSON.parse(text)
    } catch {
      return ws.close(1003, 'not json')
    }
    const id = message.id
    const reply = (value: object) => ws.send(JSON.stringify({ id, type: 'result', ...value }))
    if (typeof id !== 'number') return ws.close(1003, 'no id')
    if (message.type === 'get_states') return reply({ success: true, result: entities })
    if (message.type === 'call_service') {
      const target = message.target as { entity_id?: unknown } | undefined
      const entity = entities.find((e) => e.entity_id === target?.entity_id)
      const domain = String(message.domain)
      const service = String(message.service)
      if (entity === undefined || !entity.entity_id.startsWith(`${domain}.`))
        return reply({ success: false, error: { code: 'not_found', message: 'Entity not found' } })
      const next =
        domain === 'light'
          ? { turn_on: 'on', turn_off: 'off', toggle: entity.state === 'on' ? 'off' : 'on' }[service]
          : domain === 'lock'
            ? { lock: 'locked', unlock: 'unlocked' }[service]
            : undefined
      if (next === undefined)
        return reply({ success: false, error: { code: 'invalid_format', message: 'Service not found' } })
      entity.state = next
      entity.last_changed = '2026-11-17T09:00:00Z'
      // A state change also goes out as an event, as a hub sends to subscribers.
      ws.send(
        JSON.stringify({
          type: 'event',
          event: { event_type: 'state_changed', data: { entity_id: entity.entity_id } },
        }),
      )
      return reply({ success: true, result: { context: { id: 'ctx-1' } } })
    }
    return reply({ success: false, error: { code: 'unknown_command', message: 'Unknown command.' } })
  })
}

/**
 * A Redis-style cache speaking RESP2 over TLS: AUTH (user and password, or the password alone),
 * GET, SCAN with MATCH and COUNT, and PING. The reader's account reads every key but `secret:*`
 * and writes nothing, as an ACL would hold it.
 */
function redisSession(socket: TLSSocket | Socket, commands: string[][]): void {
  let buffer = Buffer.alloc(0)
  let authed = false
  const write = (text: string) => socket.write(text)
  const bulk = (value: string | null) =>
    value === null ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`
  socket.on('error', () => undefined)
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const parsed = readCommand(buffer)
      if (parsed === null) return
      if (parsed === 'bad') {
        write('-ERR Protocol error\r\n')
        socket.end()
        return
      }
      buffer = buffer.subarray(parsed.used)
      const [name = '', ...args] = parsed.words
      const verb = name.toUpperCase()
      commands.push(verb === 'AUTH' ? ['AUTH', ...args.slice(0, -1), '***'] : [verb, ...args])
      if (verb === 'AUTH') {
        const ok =
          (args.length === 2 && args[0] === REDIS_USER && args[1] === REDIS_PASSWORD) ||
          (args.length === 1 && args[0] === REDIS_PASSWORD)
        authed = ok
        write(ok ? '+OK\r\n' : '-WRONGPASS invalid username-password pair or user is disabled.\r\n')
        continue
      }
      if (!authed) {
        write('-NOAUTH Authentication required.\r\n')
        continue
      }
      if (verb === 'PING') write('+PONG\r\n')
      else if (verb === 'GET' && args.length === 1) {
        const key = args[0] as string
        if (key.startsWith('secret:'))
          write('-NOPERM User reader has no permissions to access one of the keys used as arguments\r\n')
        else write(bulk(REDIS_DATA[key] ?? null))
      } else if (verb === 'SCAN') {
        const at = args.findIndex((a) => a.toUpperCase() === 'MATCH')
        const pattern = at === -1 ? '*' : (args[at + 1] ?? '*')
        const re = new RegExp(
          `^${pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replaceAll('*', '.*')
            .replaceAll('?', '.')}$`,
        )
        const keys = Object.keys(REDIS_DATA).filter((k) => re.test(k) && !k.startsWith('secret:'))
        write(`*2\r\n${bulk('0')}*${keys.length}\r\n${keys.map(bulk).join('')}`)
      } else if (['SET', 'DEL', 'FLUSHALL', 'FLUSHDB', 'CONFIG'].includes(verb))
        write(`-NOPERM User reader has no permissions to run the '${name.toLowerCase()}' command\r\n`)
      else write(`-ERR unknown command '${name}'\r\n`)
    }
  })
}

/** One RESP array of bulk strings off the front of `buffer`: null if incomplete. */
function readCommand(buffer: Buffer): { words: string[]; used: number } | null | 'bad' {
  if (buffer.length === 0) return null
  if (buffer[0] !== 0x2a) return 'bad'
  let at = 0
  const line = (): string | null => {
    const end = buffer.indexOf('\r\n', at)
    if (end === -1) return null
    const text = buffer.subarray(at, end).toString('utf8')
    at = end + 2
    return text
  }
  const head = line()
  if (head === null) return null
  const count = Number(head.slice(1))
  if (!Number.isInteger(count) || count < 1 || count > 64) return 'bad'
  const words: string[] = []
  for (let i = 0; i < count; i++) {
    const size = line()
    if (size === null) return null
    if (!size.startsWith('$')) return 'bad'
    const length = Number(size.slice(1))
    if (!Number.isInteger(length) || length < 0 || length > 65_536) return 'bad'
    if (buffer.length < at + length + 2) return null
    words.push(buffer.subarray(at, at + length).toString('utf8'))
    at += length + 2
  }
  return { words, used: at }
}
