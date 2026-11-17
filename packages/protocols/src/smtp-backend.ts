// The runtime's SmtpBackend for one adapter version (workstream G): each send gets a fresh protocol
// host, reached through the egress broker's tunnel to the manifest's one SMTP endpoint. On 465 the
// tunnel checks the TLS server name like any TLS endpoint. On a STARTTLS port the first bytes are
// plain SMTP, so the tunnel carries them as plain TCP; the host's own client refuses to sign in or
// send before TLS, and checks the server's certificate against the endpoint's name.

import { type SmtpProtocol, ValetError } from '@valet/core'
import { type BrokerOptions, EgressBroker } from '@valet/egress'
import type { SmtpBackend, SmtpCall, SmtpConnection } from '@valet/runtime'
import { ImapHostSession, type ProtocolHostOptions } from './host-session'

export interface SmtpBackendOptions {
  readonly protocol: SmtpProtocol
  readonly host: ProtocolHostOptions
  /** The broker's own options: tests route the endpoint to a fake server. */
  readonly broker?: BrokerOptions
}

export function smtpBackend(options: SmtpBackendOptions): SmtpBackend {
  const { protocol } = options
  const broker = new EgressBroker({ egress: [], endpoints: [protocol.endpoint] }, options.broker ?? {})
  const startTls = !protocol.endpoint.endsWith(':465')
  return {
    endpoint: protocol.endpoint,
    recipients: protocol.recipients ?? null,
    async connect(call: SmtpCall): Promise<SmtpConnection> {
      const session = await ImapHostSession.start({
        host: options.host,
        protocol: 'smtp',
        recipients: protocol.recipients ?? null,
        endpoint: protocol.endpoint,
        // Unused by SMTP; the host refuses every IMAP message on an SMTP boot.
        purpose: 'irreversible',
        folders: null,
        openTunnels: broker.tunnels(call.run, {
          admit: call.admit,
          ...(startTls ? { plainTcp: [protocol.endpoint] } : {}),
        }),
        signIn: call.signIn,
        signal: call.signal,
      })
      return {
        send: (value) => session.sendMail(value),
        end: () => session.end(),
      }
    },
  }
}

/** Refuses every send: for a protocol adapter on a Mac without the runtime's Node binary. */
export const UNAVAILABLE_SMTP: Pick<SmtpBackend, 'connect'> = {
  connect: () => Promise.reject(new ValetError('tool-run', 'unavailable')),
}
