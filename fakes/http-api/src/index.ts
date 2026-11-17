// A fake HTTP API on loopback, over TLS with a test certificate (see README.md). Plain Node.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { generateTestCertificate } from '@valet/fake-woolworths-site'
import { type WebSocket, WebSocketServer } from 'ws'

export interface SeenRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
  /** The TLS server name the client asked for, or null over plain http. */
  readonly servername: string | null
}

export interface FakeApi {
  /** The port it listens on, on 127.0.0.1. */
  readonly port: number
  /** PEM of the certificate it serves (absent for a plain http server). */
  readonly cert: string | null
  /** Every request it received, in order, WebSocket upgrades included. */
  readonly seen: SeenRequest[]
  /** Every WebSocket message it received. */
  readonly socketMessages: string[]
  close(): Promise<void>
}

export interface FakeApiOptions {
  /** Names the certificate covers. Default api.example.test and feeds.example.test. */
  readonly hosts?: readonly string[]
  /** Serve plain http instead of https (a device on the person's network, say). */
  readonly plain?: boolean
}

export const ITEMS = [
  { id: 1, title: 'First item', score: 10 },
  { id: 2, title: 'Second item', score: 7 },
]

export const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example News</title>
    <link>https://feeds.example.test/</link>
    <description>Things that happened</description>
    <item>
      <title>First &amp; foremost</title>
      <link>https://feeds.example.test/1</link>
      <guid isPermaLink="false">item-1</guid>
      <pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
    </item>
    <item>
      <title>Second</title>
      <link>https://feeds.example.test/2</link>
      <guid>https://feeds.example.test/2</guid>
      <pubDate>Tue, 17 Nov 2026 09:00:00 GMT</pubDate>
      <description>Plain text &#8212; with an entity</description>
    </item>
  </channel>
</rss>`

export const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <link href="https://feeds.example.test/atom"/>
  <updated>2026-11-17T09:00:00Z</updated>
  <id>urn:example:feed</id>
  <entry>
    <title type="text">Atom entry</title>
    <link rel="alternate" href="https://feeds.example.test/a1"/>
    <id>urn:example:a1</id>
    <updated>2026-11-17T09:00:00Z</updated>
    <summary>Summary text</summary>
    <author><name>Alex</name></author>
  </entry>
</feed>`

export const CALDAV_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/alex/home/</d:href>
    <d:propstat><d:prop><d:displayname>Home</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`

/** Starts the fake. Its routes are listed in route() below. */
export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const seen: SeenRequest[] = []
  const socketMessages: string[] = []
  const cert =
    options.plain === true
      ? null
      : await generateTestCertificate(options.hosts ?? ['api.example.test', 'feeds.example.test'])
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: { ...req.headers },
        body,
        servername: servernameOf(req),
      })
      route(req, res, body)
    })
  }
  const server: Server =
    cert === null ? createHttpServer(handler) : createHttpsServer({ key: cert.key, cert: cert.cert }, handler)
  const sockets = new Set<Duplex>()
  server.on('connection', (s: Duplex) => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
  })
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: { ...req.headers },
      body: '',
      servername: servernameOf(req),
    })
    if (!(req.url ?? '').startsWith('/ws/')) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => socketRoute(req.url ?? '', ws, socketMessages))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    cert: cert?.cert ?? null,
    seen,
    socketMessages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

function servernameOf(req: IncomingMessage): string | null {
  const socket = req.socket as { servername?: unknown }
  return typeof socket.servername === 'string' ? socket.servername : null
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): undefined {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(value))
  return undefined
}

function route(req: IncomingMessage, res: ServerResponse, body: string): undefined {
  const url = new URL(req.url ?? '/', 'https://fake.invalid')
  const path = url.pathname
  const method = req.method ?? 'GET'
  if (path === '/v1/items' && method === 'GET')
    return json(res, 200, { items: ITEMS }, { 'set-cookie': 'track=1' })
  if (path.startsWith('/v1/items/') && method === 'GET') {
    const item = ITEMS.find((i) => String(i.id) === path.slice('/v1/items/'.length))
    return item === undefined ? json(res, 404, { error: 'not found' }) : json(res, 200, item)
  }
  if (path === '/v1/echo') return json(res, 200, { method, url: req.url, headers: req.headers, body })
  if (path === '/v1/redirect') {
    res.writeHead(302, { location: 'https://evil.example.test/steal' })
    return void res.end()
  }
  if (path === '/v1/loop') {
    res.writeHead(307, { location: '/v1/loop' })
    return void res.end()
  }
  if (path === '/v1/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return void res.end(Buffer.alloc(5 * 1024 * 1024, 97))
  }
  if (path === '/v1/big-declared') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(100 * 1024 * 1024),
    })
    return void res.write(Buffer.alloc(1024))
  }
  if (path === '/v1/endless') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    const tick = setInterval(() => {
      if (!res.write('x'.repeat(64 * 1024))) return
    }, 1)
    res.on('close', () => clearInterval(tick))
    return
  }
  if (path === '/v1/hang') return // never answers
  if (path === '/v1/gzip-bomb') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    return void res.end(gzipSync(Buffer.alloc(50 * 1024 * 1024, 48)))
  }
  if (path === '/v1/headers-flood') {
    const headers: Record<string, string> = {}
    for (let i = 0; i < 2000; i++) headers[`x-flood-${i}`] = 'y'.repeat(100)
    res.writeHead(200, headers)
    return void res.end('{}')
  }
  if (path === '/v1/limited') return json(res, 429, { error: 'slow down' })
  if (path === '/v1/forbidden') {
    res.writeHead(403, { 'content-type': 'text/html' })
    return void res.end('<html>Access Denied</html>')
  }
  if (path === '/v1/download') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return void res.end(Buffer.alloc(Number(url.searchParams.get('bytes') ?? '1024'), 98))
  }
  if (path === '/feed.xml') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    return void res.end(RSS_FEED)
  }
  if (path === '/atom.xml') {
    res.writeHead(200, { 'content-type': 'application/atom+xml' })
    return void res.end(ATOM_FEED)
  }
  if (path.startsWith('/calendars/')) {
    if (method === 'PROPFIND' || method === 'REPORT') {
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      return void res.end(CALDAV_MULTISTATUS)
    }
    if (method === 'MKCALENDAR' || method === 'MKCOL') {
      res.writeHead(201)
      return void res.end()
    }
    if (method === 'MOVE' || method === 'COPY') {
      res.writeHead(201, { 'content-type': 'text/plain' })
      return void res.end(String(req.headers['destination'] ?? ''))
    }
  }
  json(res, 404, { error: 'no route', method, path })
}

function socketRoute(url: string, ws: WebSocket, received: string[]): void {
  if (url.startsWith('/ws/echo')) {
    ws.on('message', (data: Buffer, binary: boolean) => {
      received.push(data.toString('utf8'))
      ws.send(data, { binary })
    })
    return
  }
  if (url.startsWith('/ws/ticker')) {
    let n = 0
    const tick = setInterval(() => ws.send(JSON.stringify({ tick: ++n })), 20)
    ws.on('message', (data: Buffer) => received.push(data.toString('utf8')))
    ws.on('close', () => clearInterval(tick))
    return
  }
  if (url.startsWith('/ws/flood')) {
    const tick = setInterval(() => {
      for (let i = 0; i < 100; i++) ws.send('f'.repeat(1024))
    }, 1)
    ws.on('close', () => clearInterval(tick))
    return
  }
  if (url.startsWith('/ws/huge')) {
    ws.send(Buffer.alloc(2 * 1024 * 1024, 65))
    return
  }
  ws.close(1008)
}
