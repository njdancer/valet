// What the Node runtime needs from the egress broker (docs/adapter-kinds.md#f1-the-egress-broker,
// docs/node-runtime.md#tunnels). The broker is workstream A's; this is the seam between the two.
//
// For each process, the runtime asks for one tunnel per declared endpoint. A tunnel is a TCP
// listener on 127.0.0.1 that the broker owns: whatever connects to it is carried to that endpoint
// and nowhere else, with the broker's own checks (the SNI check, pacing, the upload budget) applied
// to it. The process's profile allows connections to these ports only, so the endpoint list is
// enforced by the broker and the operating system together; the shim inside the process only points
// ordinary npm packages at the right port.

/** An endpoint as the manifest names it: `host:port`, or `[v6]:port`. */
export type Endpoint = string

export interface TunnelSet {
  /** Endpoint (as normalised by endpointKey) to the loopback port that reaches it. */
  readonly ports: ReadonlyMap<string, number>
  /** Closes every listener and every connection through them. Safe to call more than once. */
  close(): void
}

/** Opens the tunnels for one process. Rejects if any endpoint can't be served. */
export type OpenTunnels = (endpoints: readonly Endpoint[]) => Promise<TunnelSet>

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6 = /^[0-9a-f:.]+$/

export interface ParsedEndpoint {
  readonly host: string
  readonly port: number
  /** `host:port`, lowercased, IPv6 without brackets: how the shim looks it up. */
  readonly key: string
}

/** Parses `host:port` (or `[v6]:port`). Throws on anything else. */
export function parseEndpoint(endpoint: Endpoint): ParsedEndpoint {
  if (typeof endpoint !== 'string' || endpoint.length > 300) throw new Error('not an endpoint')
  const lower = endpoint.toLowerCase()
  let host: string
  let portText: string
  if (lower.startsWith('[')) {
    const close = lower.indexOf(']')
    if (close === -1 || lower[close + 1] !== ':') throw new Error(`not an endpoint: ${endpoint}`)
    host = lower.slice(1, close)
    portText = lower.slice(close + 2)
    if (!IPV6.test(host) || !host.includes(':')) throw new Error(`not an endpoint: ${endpoint}`)
  } else {
    const colon = lower.lastIndexOf(':')
    if (colon === -1) throw new Error(`not an endpoint: ${endpoint}`)
    host = lower.slice(0, colon)
    portText = lower.slice(colon + 1)
    if (!(IPV4.test(host) || (HOST.test(host) && host.includes('.'))))
      throw new Error(`not an endpoint: ${endpoint}`)
  }
  if (!/^[1-9]\d{0,4}$/.test(portText)) throw new Error(`not an endpoint: ${endpoint}`)
  const port = Number(portText)
  if (port > 65535) throw new Error(`not an endpoint: ${endpoint}`)
  return { host, port, key: `${host}:${port}` }
}
