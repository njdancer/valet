// What the Node runtime needs from the egress broker (docs/adapter-kinds.md#f1-the-egress-broker,
// docs/node-runtime.md#tunnels). The broker is workstream A's; this is the seam between the two.
//
// For each process, the runtime asks for one tunnel per declared endpoint. A tunnel is a TCP
// listener on 127.0.0.1 that the broker owns: whatever connects to it is carried to that endpoint
// and nowhere else, with the broker's own checks (the SNI check, pacing, the upload budget) applied
// to it. The process's profile allows connections to these ports only, so the endpoint list is
// enforced by the broker and the operating system together; the shim inside the process only points
// ordinary npm packages at the right port.

import { parseEndpoint as parseCoreEndpoint } from '@valet/core'

/** An endpoint as the manifest names it: `host:port`, lower case, an IPv6 literal unbracketed. */
export type Endpoint = string

export interface TunnelSet {
  /** Endpoint (as normalised by endpointKey) to the loopback port that reaches it. */
  readonly ports: ReadonlyMap<string, number>
  /** Closes every listener and every connection through them. Safe to call more than once. */
  close(): void
}

/** Opens the tunnels for one process. Rejects if any endpoint can't be served. */
export type OpenTunnels = (endpoints: readonly Endpoint[]) => Promise<TunnelSet>

export interface ParsedEndpoint {
  readonly host: string
  readonly port: number
  /** `host:port`, lowercased, IPv6 without brackets: how the shim looks it up. */
  readonly key: string
}

/**
 * Parses an endpoint with core's parseEndpoint, the manifest's own rule (lower case, IP literals
 * canonical and unbracketed). Throws on anything else.
 */
export function parseEndpoint(endpoint: Endpoint): ParsedEndpoint {
  const parsed = typeof endpoint === 'string' && endpoint.length <= 300 ? parseCoreEndpoint(endpoint) : null
  if (parsed === null) throw new Error(`not an endpoint: ${String(endpoint).slice(0, 300)}`)
  return { host: parsed.host, port: parsed.port, key: `${parsed.host}:${parsed.port}` }
}
