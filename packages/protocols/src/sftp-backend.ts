// The runtime's SftpBackend for one adapter version (docs/sftp.md): each call gets a fresh SFTP
// host, reached through the egress broker's tunnel to the manifest's one SSH endpoint. SSH isn't
// TLS, so the broker has no server name to check; the pinned host key does that job, in the host,
// before any sign-in is sent. The broker still holds the connection to the one endpoint, resolves
// and checks its address itself, and counts every byte against the upload budget.

import { canonicalAddress, parseEndpoint, type SftpProtocol, ValetError } from '@valet/core'
import { type BrokerOptions, EgressBroker } from '@valet/egress'
import type { SftpBackend, SftpCall, SftpConnection } from '@valet/runtime'
import { type ProtocolHostOptions, SftpHostSession } from './host-session'

export interface SftpBackendOptions {
  readonly protocol: SftpProtocol
  /** Its hostScript is the bundled SFTP host (build.ts writeSftpHost). */
  readonly host: ProtocolHostOptions
  /** The broker's own options: tests route the endpoint to a fake server. */
  readonly broker?: BrokerOptions
}

export function sftpBackend(options: SftpBackendOptions): SftpBackend {
  const { protocol } = options
  const endpoint = parseEndpoint(protocol.endpoint)
  if (endpoint === null) throw new ValetError('manifest', 'invalid')
  // A NAS on the person's network is a private host: its address is exact, and nothing else is.
  const local = canonicalAddress(endpoint.host) !== null
  const broker = new EgressBroker(
    local
      ? { egress: [], privateHosts: [{ address: endpoint.host, port: endpoint.port }] }
      : { egress: [], endpoints: [protocol.endpoint] },
    options.broker ?? {},
  )
  return {
    endpoint: protocol.endpoint,
    roots: protocol.roots,
    async connect(call: SftpCall): Promise<SftpConnection> {
      const session = await SftpHostSession.start({
        host: options.host,
        endpoint: protocol.endpoint,
        purpose: call.purpose,
        roots: protocol.roots,
        hostKeySha256: protocol.hostKeySha256,
        openTunnels: broker.tunnels(call.run, {
          admit: call.admit,
          ...(local ? {} : { plainTcp: [protocol.endpoint] }),
        }),
        signIn: call.signIn,
        username: protocol.username,
        signal: call.signal,
      })
      return {
        operation: (op, args) => session.operation(op, args),
        end: () => session.end(),
      }
    },
  }
}

/** Refuses every call: for a protocol adapter on a Mac without the runtime's Node binary. */
export const UNAVAILABLE_SFTP: Pick<SftpBackend, 'connect'> = {
  connect: () => Promise.reject(new ValetError('tool-run', 'unavailable')),
}
