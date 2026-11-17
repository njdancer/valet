// The protocol host's entry point (docs/imap.md#the-protocol-host). Valet's own IMAP client runs
// here, in a Node process under the same deny-by-default Seatbelt profile as a raw adapter, whose
// only network is the egress broker's tunnel to the one declared endpoint. So parsing hostile mail
// never happens in Valet's main process. Bundled into one script at build time (build.ts).
//
// The channel to Valet is file descriptor 3: newline-separated JSON, both ways.
//   Valet → host: boot (the tunnel port, endpoint, purpose, folders), login (once), op, signInMail,
//                 end.
//   host → Valet: ready, result (for login, op and signInMail, by id).
// Valet checks what comes back as untrusted; the purpose and folder rules are enforced here too.

import { type TLSSocket, connect as tlsConnect } from 'node:tls'
import { isOperation, type ImapPurpose as Purpose } from '@valet/core/imap-policy'
import { ImapClient, ImapError } from '../imap/client'
import { Operations } from '../imap/operations'
import { findSignInMail, type SignInQuery } from '../imap/signin'
import { serveChannel } from './channel'

interface Boot {
  readonly t: 'boot'
  readonly tunnels: Readonly<Record<string, number>>
  readonly endpoint: string
  readonly purpose: Purpose
  readonly folders: readonly string[] | null
  /** Tests only: the certificate to trust in place of Node's own roots. */
  readonly ca?: string
}

let boot: Boot | null = null
let client: ImapClient | null = null
let operations: Operations | null = null

const failure = (error: unknown) =>
  error instanceof ImapError
    ? { failure: error.failure, code: error.code }
    : { failure: 'malformed', code: null }

function connect(b: Boot): Promise<TLSSocket> {
  const port = b.tunnels[b.endpoint]
  const host = b.endpoint.slice(0, b.endpoint.lastIndexOf(':'))
  if (port === undefined) return Promise.reject(new ImapError('closed'))
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: host,
      // Node checks the certificate against `servername`, the endpoint's real name, not the loopback
      // address the tunnel listens on; the broker checks the same name in the ClientHello.
      ...(b.ca === undefined ? {} : { ca: b.ca }),
      minVersion: 'TLSv1.2',
    })
    socket.once('secureConnect', () => resolve(socket))
    socket.once('error', () => reject(new ImapError('closed')))
  })
}

async function login(id: number, username: string, password: string): Promise<void> {
  if (boot === null || client !== null) throw new ImapError('invalid')
  const socket = await connect(boot)
  const opened = await ImapClient.open(socket, { purpose: boot.purpose })
  client = opened
  await opened.login(Buffer.from(username, 'utf8'), Buffer.from(password, 'utf8'))
  operations = new Operations(opened, { folders: boot.folders, purpose: boot.purpose })
  post({ t: 'result', id, ok: true, value: null })
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const id = typeof message['id'] === 'number' ? message['id'] : 0
  try {
    switch (message['t']) {
      case 'login':
        if (typeof message['username'] !== 'string' || typeof message['password'] !== 'string')
          throw new ImapError('invalid')
        return await login(id, message['username'], message['password'])
      case 'op': {
        if (operations === null) throw new ImapError('closed')
        const op = message['op']
        const args = message['args']
        if (!isOperation(op) || !Array.isArray(args)) throw new ImapError('invalid')
        const value = await operations.run(op, args)
        post({ t: 'result', id, ok: true, value: value ?? null })
        return
      }
      case 'signInMail': {
        if (client === null || boot?.purpose !== 'read') throw new ImapError('not-allowed')
        const value = await findSignInMail(client, message['query'] as SignInQuery)
        post({ t: 'result', id, ok: true, value })
        return
      }
      case 'end':
        await client?.logout()
        process.exit(0)
        return
      default:
        throw new ImapError('invalid')
    }
  } catch (error) {
    post({ t: 'result', id, ok: false, ...failure(error) })
  }
}

const { post } = serveChannel<Boot>(
  (b) => {
    boot = b
  },
  handle,
)
