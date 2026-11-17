// The egress broker (docs/adapter-kinds.md#f1-the-egress-broker): the one place in the main
// process through which an adapter that isn't a browser adapter reaches the outside. One broker
// per adapter version, built from its manifest's endpoints; one RunContext per run, carrying the
// run's byte meter, its signal and where its connections are recorded.
//
// The runtime decides first whether a request may go at all (core's decideRequest: hosts,
// declarations, purpose; then pacing). The broker checks the endpoint again on its own, so nothing
// reaches a socket that isn't an exact declared endpoint, does every DNS lookup itself, spends the
// bytes from the run's upload budget before they leave, and records each connection with its byte
// counts. Refusals are ValetErrors at stage `egress` or `tool-run`; nothing here writes the audit
// log itself.

import {
  canonicalAddress,
  type ErrorClass,
  endpointOf,
  hostPort,
  type PrivateHost,
  ValetError,
} from '@valet/core'
import { type DialOptions, type DialTarget, type DialTesting, dial, type Lookup } from './dial'
import { type ExchangeResult, exchangeOn, MAX_REQUEST_BODY_BYTES, requestSize } from './http-client'
import type { RunMeter } from './meter'
import { type OpenTunnels, openTunnels, parseEndpoint, type TunnelEndpointRule } from './tunnel'
import { BrokerSocket } from './websocket'

export interface BrokerEndpoints {
  /** Exact public host names, reached on 443 only. */
  readonly egress: readonly string[]
  readonly privateHosts?: readonly PrivateHost[]
  /**
   * Exact `host:port` pairs a tunnel may reach (a `raw` adapter's `endpoints`), as parseEndpoint
   * reads them. The broker's own HTTPS never uses these.
   */
  readonly endpoints?: readonly string[]
}

export interface ConnectionRecord {
  /** `host:port`, a private host's as declared. */
  readonly endpoint: string
  readonly kind: 'https' | 'http' | 'websocket' | 'tunnel'
  readonly bytesUp: number
  readonly bytesDown: number
  readonly errorClass: ErrorClass | null
}

/** What one run brings to each of its connections. */
export interface RunContext {
  readonly meter: RunMeter
  readonly signal: AbortSignal
  /** Called once per connection when it ends, however it ends. Must not throw. */
  readonly record: (connection: ConnectionRecord) => void
}

export interface BrokerOptions {
  readonly lookup?: Lookup
  readonly ownAddresses?: () => readonly string[]
  readonly timeoutMs?: number
  /** Only tests set it (dial.ts). */
  readonly testing?: DialTesting
}

export interface BrokerRequest {
  readonly method: string
  /** Lower-case names, already checked by the runtime: no host, cookie, hop-by-hop or proxy header. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer | null
}

/** Where a URL goes, if it is one of this broker's endpoints. */
interface Resolved {
  readonly target: DialTarget
  readonly endpoint: string
  readonly secure: boolean
}

export class EgressBroker {
  private readonly egress: readonly string[]
  private readonly privateHosts: readonly PrivateHost[]
  private readonly tunnelEndpoints: ReadonlySet<string>

  constructor(
    endpoints: BrokerEndpoints,
    private readonly options: BrokerOptions = {},
  ) {
    // Exact hosts only: a pattern here would be a hole, whatever the manifest schema says.
    this.egress = endpoints.egress.filter((h) => !h.includes('*')).map((h) => h.toLowerCase())
    this.privateHosts = endpoints.privateHosts ?? []
    const keys = new Set<string>()
    for (const value of endpoints.endpoints ?? []) {
      const parsed = parseEndpoint(value)
      if (parsed !== null && canonicalAddress(parsed.host) === null) keys.add(`${parsed.host}:${parsed.port}`)
    }
    this.tunnelEndpoints = keys
  }

  /**
   * Tunnels for one call (tunnel.ts), in the Node runtime's shape. A public endpoint must be one of
   * `endpoints`; a private one, a declared private host. A public endpoint is TLS with an SNI
   * check unless `plainTcp` names it. `admit` takes a pacing slot per connection.
   */
  tunnels(
    run: RunContext,
    options: { readonly admit?: () => Promise<void>; readonly plainTcp?: readonly string[] } = {},
  ): OpenTunnels {
    const plain = new Set((options.plainTcp ?? []).map((e) => e.toLowerCase()))
    const rule = (endpoint: { host: string; port: number }): TunnelEndpointRule | null => {
      const key = `${endpoint.host}:${endpoint.port}`
      const host = this.privateHosts.find((p) => p.address === endpoint.host && p.port === endpoint.port)
      if (host !== undefined) {
        // An IP literal is its own name: no SNI to check, and the address is exact already.
        return {
          tls: false,
          target: { kind: 'private', address: host.address, port: host.port, scheme: 'http' },
        }
      }
      if (!this.tunnelEndpoints.has(key)) return null
      return { tls: !plain.has(key), target: { kind: 'public', host: endpoint.host, port: endpoint.port } }
    }
    return (endpoints) =>
      openTunnels(endpoints, rule, run, {
        dial: this.dialOptions(run.signal, []),
        ...(options.admit === undefined ? {} : { admit: options.admit }),
      })
  }

  /**
   * Sends one HTTP request and returns the whole response. Rejects `egress/host-not-allowed` for a
   * URL that isn't an exact endpoint, `egress/upload-budget` when the request doesn't fit the run's
   * budget (nothing is sent), and as dial and exchangeOn do otherwise.
   */
  async fetch(url: URL, request: BrokerRequest, run: RunContext): Promise<ExchangeResult> {
    const resolved = this.resolve(url)
    if (request.body !== null && request.body.byteLength > MAX_REQUEST_BODY_BYTES)
      throw new ValetError('tool-run', 'invalid')
    const exchange = { method: request.method, url, headers: request.headers, body: request.body }
    const size = requestSize(exchange)
    run.meter.spend(size)
    let down = 0
    const kind = resolved.secure ? 'https' : 'http'
    try {
      const socket = await dial(resolved.target, this.dialOptions(run.signal, ['http/1.1']))
      const result = await exchangeOn(socket, exchange, {
        signal: run.signal,
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
        onReceive: (bytes) => {
          down += bytes
          run.meter.receive(bytes)
        },
      })
      run.record({ endpoint: resolved.endpoint, kind, bytesUp: size, bytesDown: down, errorClass: null })
      return result
    } catch (error) {
      const valet = error instanceof ValetError ? error : new ValetError('egress', 'unavailable')
      run.record({
        endpoint: resolved.endpoint,
        kind,
        bytesUp: size,
        bytesDown: down,
        errorClass: valet.errorClass,
      })
      throw valet
    }
  }

  /**
   * Opens a WebSocket to `url` (https or http: the broker speaks wss or ws on the same endpoint).
   * The socket is closed when the run's signal aborts. Its connection is recorded when it closes.
   */
  async websocket(
    url: URL,
    options: { readonly protocols?: readonly string[]; readonly headers?: Readonly<Record<string, string>> },
    run: RunContext,
  ): Promise<BrokerSocket> {
    const resolved = this.resolve(url)
    let up = 0
    let down = 0
    const record = (errorClass: ErrorClass | null) =>
      run.record({ endpoint: resolved.endpoint, kind: 'websocket', bytesUp: up, bytesDown: down, errorClass })
    const wsUrl = new URL(url.href)
    wsUrl.protocol = resolved.secure ? 'wss:' : 'ws:'
    let socket: BrokerSocket
    try {
      const raw = await dial(resolved.target, this.dialOptions(run.signal, ['http/1.1']))
      socket = await BrokerSocket.open(raw, {
        url: wsUrl,
        ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        signal: run.signal,
        spend: (bytes) => {
          run.meter.spend(bytes)
          up += bytes
        },
        onReceive: (bytes) => {
          down += bytes
          run.meter.receive(bytes)
        },
      })
    } catch (error) {
      const valet = error instanceof ValetError ? error : new ValetError('egress', 'unavailable')
      record(valet.errorClass)
      throw valet
    }
    let recorded = false
    const finish = () => {
      if (recorded) return
      recorded = true
      socket.close()
      record(null)
    }
    run.signal.addEventListener('abort', finish, { once: true })
    if (run.signal.aborted) finish()
    return socket
  }

  /** The dial target for `url`, or `egress/host-not-allowed`. https and http only; wss/ws are mapped by the caller. */
  private resolve(url: URL): Resolved {
    const endpoint = endpointOf(url, this.egress, { privateHosts: this.privateHosts, exactPort: true })
    if (endpoint === null) throw new ValetError('egress', 'host-not-allowed')
    const host =
      endpoint.privateHost === undefined ? null : this.privateHosts.find((p) => p === endpoint.privateHost)
    if (host === null || host === undefined) {
      return {
        target: { kind: 'public', host: endpoint.host, port: 443 },
        endpoint: hostPort(endpoint.host, 443),
        secure: true,
      }
    }
    const scheme = host.scheme ?? 'https'
    return {
      target: {
        kind: 'private',
        address: host.address,
        port: host.port,
        scheme,
        ...(host.certSha256 === undefined ? {} : { certSha256: host.certSha256 }),
      },
      endpoint: endpoint.host,
      secure: scheme === 'https',
    }
  }

  private dialOptions(signal: AbortSignal, alpn: readonly string[]): DialOptions {
    return {
      signal,
      alpn,
      ...(this.options.lookup === undefined ? {} : { lookup: this.options.lookup }),
      ...(this.options.ownAddresses === undefined ? {} : { ownAddresses: this.options.ownAddresses }),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.testing === undefined ? {} : { testing: this.options.testing }),
    }
  }
}
