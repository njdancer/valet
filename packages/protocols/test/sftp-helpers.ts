// Helpers for the SFTP tests: the fake server, a signed-in client over ssh2 straight to it (no host
// process), and the SFTP host end to end through the broker.

import { mkdtemp } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretValue } from '@valet/core'
import type { SftpPurpose, SftpRoot } from '@valet/core/sftp-policy'
import { type FakeSftp, type FakeSftpOptions, startFakeSftp } from '@valet/fake-sftp'
import { writeSftpHost } from '../src/build'
import type { ProtocolHostOptions } from '../src/host-session'
import { SftpClient } from '../src/sftp/client'
import { SftpOperations } from '../src/sftp/operations'
import { openSsh } from '../src/sftp/ssh'

export const FILES = {
  '/docs/readme.txt': 'Hello from the NAS.\n',
  '/docs/notes/': '',
  '/docs/notes/a.md': '# A\n',
  '/inbox/': '',
  '/scratch/': '',
  '/scratch/old.txt': 'old',
  '/private/secret.txt': 'not for tools',
} as const

export async function fakeSftp(options: FakeSftpOptions = {}): Promise<FakeSftp> {
  return startFakeSftp({ files: FILES, ...options })
}

/** The usual roots, under the fake's root: read docs, write inbox, everything in scratch. */
export function roots(server: FakeSftp): SftpRoot[] {
  return [
    { path: server.path('/docs'), access: 'read' },
    { path: server.path('/inbox'), access: 'write' },
    { path: server.path('/scratch'), access: 'irreversible' },
  ]
}

export function tcp(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, noDelay: true })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** A client and operations over ssh2 straight to the fake: the host's code, in this process. */
export async function signedIn(
  server: FakeSftp,
  purpose: SftpPurpose,
  declared: readonly SftpRoot[] = roots(server),
) {
  const ssh = await openSsh(await tcp(server.port), {
    username: server.username,
    privateKey: server.clientKey.private,
    hostKeySha256: server.hostKeySha256,
    timeoutMs: 5_000,
  })
  const client = await SftpClient.open(ssh.channel, { purpose, roots: declared, requestTimeoutMs: 5_000 })
  const ops = await SftpOperations.start(client)
  return { ssh, client, ops, close: () => ssh.close() }
}

// --- The SFTP host, end to end --------------------------------------------------------------------

export const mac = process.platform === 'darwin'

let hostScript: Promise<string> | null = null

/** The bundled SFTP host, built once per test file into a temporary folder. */
export function builtSftpHost(): Promise<string> {
  hostScript ??= mkdtemp(join(tmpdir(), 'valet-sftp-host-')).then((dir) =>
    writeSftpHost(join(dir, 'sftp-host.cjs')),
  )
  return hostScript
}

/** Host options for tests: this Node, Seatbelt on macOS only. */
export async function sftpHostOptions(extra: Partial<ProtocolHostOptions> = {}): Promise<ProtocolHostOptions> {
  const home = await mkdtemp(join(tmpdir(), 'valet-home-'))
  return {
    nodeBinary: process.execPath,
    hostScript: await builtSftpHost(),
    home,
    withoutSeatbelt: !mac,
    operationTimeoutMs: 15_000,
    ...extra,
  } as ProtocolHostOptions
}

/** Broker options that send the endpoint to the fake server. */
export function brokerToSftp(server: FakeSftp) {
  return {
    lookup: (_name: string, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }]),
    testing: { allowAddresses: ['127.0.0.1'], route: () => ({ address: '127.0.0.1', port: server.port }) },
  }
}

/** The fake's key as the credential gate would hand it over: no username in the item. */
export const keySignIn = (server: FakeSftp, username: string | null = null) => async () => ({
  username: username === null ? null : SecretValue.fromString(username),
  secret: SecretValue.fromString(server.clientKey.private),
})
