// The blind relay (docs/blind-relay.md). It accepts TCP connections on one port and reads exactly
// one thing from each: the server name in TLS's first message. A connection for a Mac's name is
// passed, byte for byte and still encrypted, down the WebSocket that Mac keeps open to the relay.
// TLS ends on the Mac, so the relay never holds a key that could read a request, a tool call, a
// result or an approval. It keeps no accounts, no registry and no traffic, and logs only counts.
//
// The one name the relay answers itself is its own control host, where Macs dial in. Its TLS ends
// here, with the relay's own certificate; what travels inside is the Mac's sign-in and the
// encrypted bytes of other connections.
//
// A Mac signs in with the Worker relay's challenge: its transport key signs the nonce, and its
// approval key (whose id is the macId, and so the name) vouches for the transport key with the
// binding made once with Touch ID. Both checks need nothing stored, so a relay that restarts has
// lost nothing.

import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { createServer as createNetServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { type SecureContext, TLSSocket } from 'node:tls'
import {
  macIdForHost,
  parseClientHello,
  RELAY_PROTOCOL_VERSION,
  relayAuthPayload,
  relayHelloSchema,
  SIGNING_DOMAINS,
  TUNNEL_LIMITS,
  TUNNEL_PATH_PREFIX,
  TUNNEL_PROTOCOL_VERSION,
  TunnelMux,
  tunnelHost,
  verifyP256,
  verifyRelayBinding,
} from '@valet/core'
import { type WebSocket, WebSocketServer } from 'ws'

export interface BlindRelayOptions {
  /** The relay's own name, where Macs dial in: e.g. relay.valet.example. */
  readonly controlHost: string
  /** Macs are `<macId>.<macDomain>`. */
  readonly macDomain: string
  /** The relay's TLS for its control host. Read per connection, so a renewed certificate applies. */
  readonly controlCertificate: () => SecureContext | null
  /** TLS-ALPN-01 for the control host's own certificate, when the relay is getting one. */
  readonly controlAcmeChallenge?: (serverName: string) => SecureContext | null
  readonly port?: number
  readonly host?: string
  /** Macs the relay refuses, by macId (abuse reports). Read on every sign-in and connection. */
  readonly denied?: () => ReadonlySet<string>
  readonly limits?: Partial<BlindRelayLimits>
  /** One line per event, counts only: never a payload, a path or a header. */
  readonly log?: (line: string) => void
  /** For tests: TUNNEL_LIMITS.window otherwise. Both ends must agree. */
  readonly window?: number
  readonly version?: string
}

export interface BlindRelayLimits {
  /** Connections to one Mac at once. */
  readonly streamsPerMac: number
  /** Connections waiting for their first message at once, over all callers. */
  readonly pendingHellos: number
  /** How long a Mac has to answer the challenge. */
  readonly helloTimeoutMs: number
  /** A connection with no bytes either way for this long is closed. */
  readonly idleMs: number
  /**
   * A Mac link that sends nothing (not even its ping) for this long is dead though no close came:
   * it is dropped, so callers aren't piped into it, and the Mac dials again.
   */
  readonly silentMs: number
  /** How long a caller for a Mac that is between links waits for it to come back. */
  readonly macGraceMs: number
}

const DEFAULT_LIMITS: BlindRelayLimits = {
  streamsPerMac: TUNNEL_LIMITS.maxStreamsPerMac,
  pendingHellos: 2000,
  helloTimeoutMs: 15_000,
  idleMs: 10 * 60_000,
  silentMs: 45_000,
  macGraceMs: 10_000,
}

const CLOSE_BAD_FRAME = 4400
const CLOSE_AUTH_FAILED = 4401
const CLOSE_DENIED = 4403
const CLOSE_REPLACED = 4409

interface MacLink {
  readonly socket: WebSocket
  readonly mux: TunnelMux
  /** Bytes each way since the last counts line. */
  up: number
  down: number
  connections: number
  /** When the Mac last sent anything on this link. */
  heard: number
}

export interface RunningBlindRelay {
  readonly port: number
  /** Macs signed in now, by macId. */
  macs(): readonly string[]
  close(): Promise<void>
}

export async function startBlindRelay(options: BlindRelayOptions): Promise<RunningBlindRelay> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const log = options.log ?? (() => undefined)
  const controlHost = options.controlHost.toLowerCase()
  const origin = `https://${controlHost}`
  const denied = options.denied ?? (() => new Set<string>())
  const macs = new Map<string, MacLink>()
  /** Callers waiting for a Mac that is between links, by macId. */
  const waiting = new Map<string, Set<(link: MacLink) => void>>()
  const silence = setInterval(
    () => {
      const now = Date.now()
      for (const [macId, link] of macs)
        if (now - link.heard > limits.silentMs) {
          log(`mac silent ${macId}`)
          link.socket.terminate()
        }
    },
    Math.min(10_000, limits.silentMs / 3),
  )
  silence.unref()
  const raw = new Set<Socket>()
  let pending = 0

  // ---- The control host: HTTP for a health check, WebSocket for Macs.
  const wss = new WebSocketServer({ noServer: true, maxPayload: TUNNEL_LIMITS.maxDataBytes + 1024 })
  const control = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`ok ${options.version ?? 'dev'} ${macs.size}\n`)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found\n')
  })
  control.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Only connections whose TLS ended here reach this server, so the name was already checked.
    const macId = macIdFromPath(req.url ?? '')
    if (macId === null) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => signIn(ws, macId))
  })

  function signIn(ws: WebSocket, macId: string): void {
    const nonce = randomBytes(32).toString('base64url')
    let signedIn = false
    const timer = setTimeout(() => ws.close(CLOSE_AUTH_FAILED, 'too slow'), limits.helloTimeoutMs)
    ws.send(JSON.stringify({ type: 'challenge', v: RELAY_PROTOCOL_VERSION, nonce, relay: origin }))
    ws.on('message', (data, isBinary) => {
      if (!signedIn) {
        if (isBinary) return ws.close(CLOSE_BAD_FRAME, 'hello first')
        clearTimeout(timer)
        if (!checkHello(String(data), macId, nonce)) return ws.close(CLOSE_AUTH_FAILED, 'refused')
        if (denied().has(macId)) return ws.close(CLOSE_DENIED, 'refused')
        signedIn = true
        return online(ws, macId)
      }
      const link = macs.get(macId)
      if (link?.socket !== ws) return
      link.heard = Date.now()
      if (!isBinary) {
        if (String(data) === 'ping') ws.send('pong')
        return
      }
      link.mux.receive(toBytes(data))
    })
    ws.on('close', () => {
      clearTimeout(timer)
      const link = macs.get(macId)
      if (link?.socket !== ws) return
      macs.delete(macId)
      link.mux.close()
      log(`mac offline ${macId} up=${link.up} down=${link.down} connections=${link.connections}`)
    })
    ws.on('error', () => undefined)
  }

  function checkHello(text: string, macId: string, nonce: string): boolean {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return false
    }
    const hello = relayHelloSchema.safeParse(value)
    if (!hello.success) return false
    const h = hello.data
    if (h.role !== 'mac' || h.id !== macId || h.transportKey === undefined) return false
    if (!verifyRelayBinding(h)) return false
    const payload = relayAuthPayload({ nonce, relay: origin, role: 'mac', id: macId })
    return verifyP256(h.transportKey, SIGNING_DOMAINS.relayAuth, payload, h.signature)
  }

  function online(ws: WebSocket, macId: string): void {
    const previous = macs.get(macId)
    if (previous !== undefined) {
      macs.delete(macId)
      previous.mux.close()
      previous.socket.close(CLOSE_REPLACED, 'replaced')
    }
    const link: MacLink = {
      socket: ws,
      up: 0,
      down: 0,
      connections: 0,
      heard: Date.now(),
      mux: new TunnelMux({
        ...(options.window === undefined ? {} : { window: options.window }),
        send: (frame) => ws.send(frame),
        onViolation: () => ws.close(CLOSE_BAD_FRAME, 'bad frame'),
      }),
    }
    macs.set(macId, link)
    ws.send(
      JSON.stringify({
        type: 'ready',
        v: TUNNEL_PROTOCOL_VERSION,
        host: tunnelHost(macId, options.macDomain),
      }),
    )
    log(`mac online ${macId}`)
    const callers = waiting.get(macId)
    waiting.delete(macId)
    for (const resume of callers ?? []) resume(link)
  }

  /** Holds a caller for a Mac that is between links until it is back, or the grace runs out. */
  function waitForMac(socket: Socket, first: Buffer, macId: string): void {
    const callers = waiting.get(macId) ?? new Set<(link: MacLink) => void>()
    waiting.set(macId, callers)
    const resume = (link: MacLink) => {
      clearTimeout(timer)
      if (socket.destroyed) return
      if (link.mux.size >= limits.streamsPerMac) return void socket.destroy()
      pipeToMac(socket, first, link)
    }
    const give = () => {
      callers.delete(resume)
      if (callers.size === 0 && waiting.get(macId) === callers) waiting.delete(macId)
    }
    log(`holding a caller for ${macId}`)
    const timer = setTimeout(() => {
      give()
      log(`refused offline ${macId}`)
      socket.destroy()
    }, limits.macGraceMs)
    socket.once('close', () => {
      clearTimeout(timer)
      give()
    })
    callers.add(resume)
  }

  // ---- Port 443: read the server name, then answer the control host or pipe to a Mac.
  const server: Server = createNetServer((socket) => {
    raw.add(socket)
    socket.on('close', () => raw.delete(socket))
    socket.on('error', () => undefined)
    if (pending >= limits.pendingHellos) return void socket.destroy()
    pending++
    let counted = true
    const done = () => {
      if (counted) pending--
      counted = false
    }
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => {
      done()
      socket.destroy()
    }, TUNNEL_LIMITS.clientHelloTimeoutMs)
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      const first = Buffer.concat(chunks)
      const hello = parseClientHello(first)
      if (hello.state === 'partial' && size < TUNNEL_LIMITS.maxClientHelloBytes) return
      clearTimeout(timer)
      done()
      socket.off('data', onData)
      socket.pause()
      if (hello.state !== 'complete') {
        log(`refused ${hello.state} hello`)
        return void socket.destroy()
      }
      // No name can't be a Mac's: the control host answers it, as for a Mac dialling an address.
      if (hello.serverName === null || hello.serverName === controlHost)
        return serveControl(socket, first, hello.alpn)
      const macId = macIdForHost(hello.serverName, options.macDomain)
      const link = macId === null ? undefined : macs.get(macId)
      if (macId === null || denied().has(macId)) {
        log(`refused name ${hello.serverName.slice(0, 100)}`)
        return void socket.destroy()
      }
      if (link === undefined) return waitForMac(socket, first, macId)
      if (link.mux.size >= limits.streamsPerMac) return void socket.destroy()
      pipeToMac(socket, first, link)
    }
    socket.on('data', onData)
    socket.on('end', () => {
      clearTimeout(timer)
      done()
      socket.destroy()
    })
  })

  function serveControl(socket: Socket, first: Buffer, alpn: readonly string[]): void {
    socket.unshift(first)
    if (alpn.includes('acme-tls/1')) {
      const context = options.controlAcmeChallenge?.(controlHost) ?? null
      if (context === null) return void socket.destroy()
      const tls = new TLSSocket(socket, {
        isServer: true,
        secureContext: context,
        ALPNProtocols: ['acme-tls/1'],
      })
      tls.on('error', () => tls.destroy())
      tls.on('secure', () => tls.end())
      return
    }
    const context = options.controlCertificate()
    if (context === null) return void socket.destroy()
    const tls = new TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'] })
    tls.on('error', () => tls.destroy())
    control.emit('connection', tls)
  }

  function pipeToMac(socket: Socket, first: Buffer, link: MacLink): void {
    const stream = link.mux.open({ source: socket.remoteAddress ?? '' })
    link.connections++
    socket.setTimeout(limits.idleMs, () => socket.destroy())
    stream.on('error', () => socket.destroy())
    socket.on('error', () => stream.destroy())
    socket.on('close', () => stream.destroy())
    stream.on('close', () => socket.destroy())
    stream.on('data', (chunk: Buffer) => {
      link.down += chunk.length
    })
    socket.on('data', (chunk: Buffer) => {
      link.up += chunk.length
    })
    stream.write(first)
    link.up += first.length
    socket.pipe(stream)
    stream.pipe(socket)
    socket.resume()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: options.port ?? 443, host: options.host ?? '0.0.0.0' }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  log(`listening ${port} control=${controlHost} macs=*.${options.macDomain}`)

  return {
    port,
    macs: () => [...macs.keys()],
    async close() {
      clearInterval(silence)
      for (const link of macs.values()) {
        link.mux.close()
        link.socket.terminate()
      }
      macs.clear()
      for (const socket of raw) socket.destroy()
      wss.close()
      control.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function macIdFromPath(path: string): string | null {
  if (!path.startsWith(TUNNEL_PATH_PREFIX)) return null
  const id = path.slice(TUNNEL_PATH_PREFIX.length)
  return /^[0-9a-f]{32}$/.test(id) ? id : null
}

function toBytes(data: unknown): Uint8Array {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[])
  return new Uint8Array(0)
}
