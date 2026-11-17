// The SFTP host's entry point (docs/sftp.md#the-protocol-host): ssh2's SSH client and Valet's own
// SFTP client run here, in a Node process under the same deny-by-default Seatbelt profile as a raw
// adapter, whose only network is the egress broker's tunnel to the one declared endpoint. So a
// hostile server's packets are never parsed in Valet's main process. Bundled into one script at
// build time (build.ts), apart from the IMAP host, so neither carries the other's code.
//
// The channel to Valet is file descriptor 3 (channel.ts):
//   Valet → host: boot (the tunnel port, endpoint, purpose, roots, pinned host key), login (once),
//                 op, end.
//   host → Valet: ready, result (for login and op, by id).
// Valet checks what comes back as untrusted; the purpose and root rules are enforced here too.

import { connect as tcpConnect, type Socket } from 'node:net'
import { isSftpOperation, type SftpPurpose, type SftpRoot } from '@valet/core/sftp-policy'
import { SftpClient } from '../sftp/client'
import { SftpOperations } from '../sftp/operations'
import { openSsh, type SshSession } from '../sftp/ssh'
import { SftpError } from '../sftp/wire'
import { serveChannel } from './channel'

interface Boot {
  readonly t: 'boot'
  readonly tunnels: Readonly<Record<string, number>>
  readonly endpoint: string
  readonly purpose: SftpPurpose
  readonly roots: readonly SftpRoot[]
  readonly hostKeySha256: string
}

let boot: Boot | null = null
let ssh: SshSession | null = null
let client: SftpClient | null = null
let operations: SftpOperations | null = null

const failure = (error: unknown) =>
  error instanceof SftpError
    ? { failure: error.failure, code: error.code }
    : { failure: 'malformed', code: null }

function connect(b: Boot): Promise<Socket> {
  const port = b.tunnels[b.endpoint]
  if (port === undefined) return Promise.reject(new SftpError('closed'))
  return new Promise((resolve, reject) => {
    // Small requests one at a time: without this, Nagle's algorithm holds each one back.
    const socket = tcpConnect({ host: '127.0.0.1', port, noDelay: true })
    socket.once('connect', () => resolve(socket))
    socket.once('error', () => reject(new SftpError('closed')))
  })
}

async function login(id: number, username: string, key: string): Promise<void> {
  if (boot === null || ssh !== null) throw new SftpError('invalid')
  const socket = await connect(boot)
  ssh = await openSsh(socket, { username, privateKey: key, hostKeySha256: boot.hostKeySha256 })
  client = await SftpClient.open(ssh.channel, { purpose: boot.purpose, roots: boot.roots })
  operations = await SftpOperations.start(client)
  post({ t: 'result', id, ok: true, value: null })
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const id = typeof message['id'] === 'number' ? message['id'] : 0
  try {
    switch (message['t']) {
      case 'login':
        if (typeof message['username'] !== 'string' || typeof message['key'] !== 'string')
          throw new SftpError('invalid')
        return await login(id, message['username'], message['key'])
      case 'op': {
        if (operations === null) throw new SftpError('closed')
        const op = message['op']
        const args = message['args']
        if (!isSftpOperation(op) || !Array.isArray(args)) throw new SftpError('invalid')
        const value = await operations.run(op, args)
        post({ t: 'result', id, ok: true, value: value ?? null })
        return
      }
      case 'end':
        client?.close()
        ssh?.close()
        process.exit(0)
        return
      default:
        throw new SftpError('invalid')
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
