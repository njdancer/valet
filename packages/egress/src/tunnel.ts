// Tunnels for adapters that open their own sockets (`raw`, on the Node runtime: docs/adapter-kinds.md#raw).
// The runtime asks for one loopback listener per declared endpoint for one call; whatever connects
// to a listener is carried to that endpoint and nowhere else. The broker never decrypts what goes
// through, so it holds each connection to what it can see:
//
// - the endpoint is exact (host and port as declared), dialled at an address the broker resolved
//   and checked itself, as for its own HTTPS (dial.ts);
// - on a TLS endpoint the first bytes must be a ClientHello naming exactly the endpoint's host
//   (sni.ts), so one CDN address can't be used to reach someone else's service. Nothing is sent
//   upstream until that is read;
// - every byte sent is spent from the call's upload budget before it is written; past it both ends
//   are closed and the connection recorded as `upload-budget`;
// - each connection takes one pacing slot (`admit`) before it is dialled, and everything closes
//   when the call's signal aborts.

import { createServer, type Server, type Socket } from 'node:net'
import { type ErrorClass, hostPort, parseEndpoint, ValetError } from '@valet/core'
import type { RunContext } from './broker'
import { type DialOptions, type DialTarget, dial } from './dial'
import { MAX_CLIENT_HELLO_BYTES, readClientHello } from './sni'

/** One call's tunnels: a listener per endpoint, by endpoint as the caller named it. */
export interface TunnelSet {
  readonly ports: ReadonlyMap<string, number>
  close(): void
  /**
   * From now on, carries connections to these endpoints only (named as when opened): every open
   * connection to any other is closed at once, and a new one is refused. Narrows only: a later
   * call can't widen it again. A raw adapter's tunnels are restricted when it is given an entrusted
   * credential, to the endpoints that credential is for (docs/adapter-kinds.md#f2-secrets-version-2).
   */
  restrict(endpoints: readonly string[]): void
}

/** The runtime's view (packages/node-runtime): listeners for `endpoints`, by endpoint. */
export type OpenTunnels = (endpoints: readonly string[]) => Promise<TunnelSet>

/** How long a client has to send its ClientHello. */
export const HELLO_TIMEOUT_MS = 10_000
/** Connections one tunnel set may carry at once. */
export const MAX_TUNNEL_CONNECTIONS = 16

export { parseEndpoint }

export interface TunnelEndpointRule {
  /** The endpoint's traffic must be TLS with this host as its SNI. False only for a plain-TCP protocol. */
  readonly tls: boolean
  /** The dial target the broker resolved for it. */
  readonly target: DialTarget
}

export interface TunnelOptions {
  /** One pacing slot per connection, before it is dialled; a rejection refuses the connection. */
  readonly admit?: () => Promise<void>
  readonly dial: DialOptions
  /** How long a client may take to send its ClientHello. */
  readonly helloTimeoutMs?: number
}

/**
 * Opens one listener per endpoint, for one call. `rules` says, for each endpoint the broker allows,
 * where it goes and whether it is TLS; an endpoint it doesn't know is refused before anything
 * listens. Everything closes when `run.signal` aborts, or on close().
 */
export async function openTunnels(
  endpoints: readonly string[],
  rules: (endpoint: { host: string; port: number }) => TunnelEndpointRule | null,
  run: RunContext,
  options: TunnelOptions,
): Promise<TunnelSet> {
  if (run.signal.aborted) throw new ValetError('tool-run', 'aborted')
  const plan: { key: string; endpoint: { host: string; port: number }; rule: TunnelEndpointRule }[] = []
  for (const value of new Set(endpoints)) {
    const endpoint = parseEndpoint(value)
    const rule = endpoint === null ? null : rules(endpoint)
    if (endpoint === null || rule === null) throw new ValetError('egress', 'host-not-allowed')
    plan.push({ key: value, endpoint, rule })
  }
  const servers: Server[] = []
  const live = new Set<Socket>()
  /** Each client connection's endpoint, as the caller named it. */
  const endpointOf = new Map<Socket, string>()
  /** Null until restrict(): every planned endpoint may be carried. */
  let allowed: Set<string> | null = null
  const permits = (key: string) => allowed === null || allowed.has(key)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const server of servers) server.close()
    for (const socket of live) socket.destroy()
    run.signal.removeEventListener('abort', close)
  }
  run.signal.addEventListener('abort', close, { once: true })
  const ports = new Map<string, number>()
  try {
    for (const { key, endpoint, rule } of plan) {
      const server = createServer({ pauseOnConnect: true }, (client) => {
        if (closed || live.size >= MAX_TUNNEL_CONNECTIONS) {
          client.destroy()
          return
        }
        if (!permits(key)) {
          client.destroy()
          run.record({
            endpoint: hostPort(endpoint.host, endpoint.port),
            kind: 'tunnel',
            bytesUp: 0,
            bytesDown: 0,
            errorClass: 'host-not-allowed',
          })
          return
        }
        live.add(client)
        endpointOf.set(client, key)
        client.once('close', () => {
          live.delete(client)
          endpointOf.delete(client)
        })
        void carry(client, endpoint, rule, run, options, live, () => permits(key))
      })
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          // A listener's later error (an accept that fails, out of file descriptors) would otherwise
          // be unhandled and end Valet's main process: the call's tunnels close instead (red team F).
          server.on('error', close)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new ValetError('egress', 'unavailable')
      ports.set(key, address.port)
    }
  } catch (error) {
    close()
    throw error instanceof ValetError ? error : new ValetError('egress', 'unavailable')
  }
  const restrict = (endpoints: readonly string[]) => {
    const next = new Set(endpoints.filter((e) => permits(e)))
    allowed = next
    for (const [client, key] of endpointOf) if (!next.has(key)) client.destroy()
  }
  return { ports, close, restrict }
}

async function carry(
  client: Socket,
  endpoint: { host: string; port: number },
  rule: TunnelEndpointRule,
  run: RunContext,
  options: TunnelOptions,
  live: Set<Socket>,
  permitted: () => boolean,
): Promise<void> {
  const key = hostPort(endpoint.host, endpoint.port)
  let up = 0
  let down = 0
  let recorded = false
  let upstream: Socket | null = null
  const end = (errorClass: ErrorClass | null) => {
    if (!recorded) {
      recorded = true
      run.record({ endpoint: key, kind: 'tunnel', bytesUp: up, bytesDown: down, errorClass })
    }
    client.destroy()
    upstream?.destroy()
  }
  client.on('error', () => end(up === 0 && down === 0 ? 'unavailable' : null))
  // Bytes the client sends before the upstream exists, held (and counted) until it does.
  const held: Buffer[] = []
  let heldBytes = 0
  const spend = (chunk: Buffer): boolean => {
    try {
      run.meter.spend(chunk.byteLength)
      up += chunk.byteLength
      return true
    } catch {
      end('upload-budget')
      return false
    }
  }
  try {
    await options.admit?.()
  } catch {
    end('rate-limited')
    return
  }
  if (run.signal.aborted) return end('aborted')
  // The ClientHello, read before anything is dialled.
  if (rule.tls) {
    const hello = await new Promise<'ok' | ErrorClass>((resolve) => {
      const timer = setTimeout(() => resolve('timed-out'), options.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
      const onData = (chunk: Buffer) => {
        held.push(chunk)
        heldBytes += chunk.byteLength
        const read = readClientHello(Buffer.concat(held, heldBytes))
        if (read.kind === 'incomplete' && heldBytes <= MAX_CLIENT_HELLO_BYTES) return
        clearTimeout(timer)
        client.removeListener('data', onData)
        client.pause()
        resolve(read.kind === 'hello' && read.serverName === endpoint.host ? 'ok' : 'sni-mismatch')
      }
      client.on('data', onData)
      client.once('close', () => {
        clearTimeout(timer)
        resolve('aborted')
      })
      client.resume()
    })
    if (hello !== 'ok') return end(hello)
  }
  // Restricted while it waited for its slot or its ClientHello: nothing has been sent yet.
  if (!permitted()) return end('host-not-allowed')
  for (const chunk of held) if (!spend(chunk)) return
  try {
    upstream = await dial(rule.target, { ...options.dial, signal: run.signal, passThrough: true })
  } catch (error) {
    return end(error instanceof ValetError ? error.errorClass : 'unavailable')
  }
  if (recorded || !permitted()) {
    upstream.destroy()
    if (!recorded) end('host-not-allowed')
    return
  }
  live.add(upstream)
  const up$ = upstream
  up$.once('close', () => {
    live.delete(up$)
    end(null)
  })
  up$.on('error', () => end(null))
  client.once('close', () => end(null))
  up$.on('data', (chunk: Buffer) => {
    down += chunk.byteLength
    run.meter.receive(chunk.byteLength)
    if (!client.write(chunk)) {
      up$.pause()
      client.once('drain', () => up$.resume())
    }
  })
  for (const chunk of held) up$.write(chunk)
  client.on('data', (chunk: Buffer) => {
    if (!spend(chunk)) return
    if (!up$.write(chunk)) {
      client.pause()
      up$.once('drain', () => client.resume())
    }
  })
  client.resume()
}
