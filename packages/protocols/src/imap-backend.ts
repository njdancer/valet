// The runtime's ImapBackend for one adapter version (docs/imap.md): each call gets a fresh protocol
// host, reached through the egress broker's tunnel to the manifest's one IMAP endpoint. The broker
// checks the endpoint, the TLS server name and the upload budget on every byte the host sends.

import { type ImapProtocol, ValetError } from '@valet/core'
import { type BrokerOptions, EgressBroker } from '@valet/egress'
import type { ImapBackend, ImapCall, ImapConnection } from '@valet/runtime'
import { ImapHostSession, type ProtocolHostOptions } from './host-session'

export interface ImapBackendOptions {
  readonly protocol: ImapProtocol
  readonly host: ProtocolHostOptions
  /** The broker's own options: tests route the endpoint to a fake server. */
  readonly broker?: BrokerOptions
}

export function imapBackend(options: ImapBackendOptions): ImapBackend {
  const { protocol } = options
  const broker = new EgressBroker({ egress: [], endpoints: [protocol.endpoint] }, options.broker ?? {})
  return {
    endpoint: protocol.endpoint,
    folders: protocol.folders ?? null,
    async connect(call: ImapCall): Promise<ImapConnection> {
      const session = await ImapHostSession.start({
        host: options.host,
        endpoint: protocol.endpoint,
        purpose: call.purpose,
        folders: protocol.folders ?? null,
        openTunnels: broker.tunnels(call.run, { admit: call.admit }),
        signIn: call.signIn,
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
export const UNAVAILABLE_IMAP: Pick<ImapBackend, 'connect'> = {
  connect: () => Promise.reject(new ValetError('tool-run', 'unavailable')),
}
