// The SSH connection under ctx.sftp (docs/sftp.md#the-ssh-connection): ssh2's client over the
// broker's tunnel, with the server's host key pinned before anything else happens, a key-only
// sign-in, modern algorithms only, no compression, and nothing but the `sftp` subsystem asked for.
// Valet's own SFTP client (client.ts) speaks on the channel this returns.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { Client, type ConnectConfig } from 'ssh2'
import { SftpError } from './wire'

/**
 * Only these, strongest first. No SHA-1 anywhere, no CBC, and no compression, so a hostile server
 * can't make the host inflate anything. chacha20-poly1305 is left out: ssh2 does it in WebAssembly.
 */
export const ALGORITHMS: NonNullable<ConnectConfig['algorithms']> = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group14-sha256',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
  cipher: ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr'],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ],
  compress: ['none'],
}

/** Whether `key` (the server's public key blob) is the pinned one: `SHA256:` and unpadded base64. */
export function matchesPin(key: Buffer, pin: string): boolean {
  if (!pin.startsWith('SHA256:')) return false
  const want = Buffer.from(pin.slice(7), 'base64')
  const got = createHash('sha256').update(key).digest()
  return want.length === 32 && timingSafeEqual(want, got)
}

export interface SshOptions {
  readonly username: string
  /** The private key, in OpenSSH (or PEM) form. Used for the sign-in and dropped. */
  readonly privateKey: string
  readonly hostKeySha256: string
  /** For the handshake and sign-in together. Default 20 s. */
  readonly timeoutMs?: number
}

export interface SshSession {
  /** The `sftp` subsystem's channel. */
  readonly channel: Duplex
  close(): void
}

/**
 * Signs in over `socket` and opens the sftp subsystem. Rejects with SftpError: 'host-key' if the
 * server's key isn't the pinned one (checked on every key exchange, before any sign-in is sent),
 * 'auth' if the key is refused, 'closed' or 'timeout' otherwise.
 */
export function openSsh(socket: Socket, options: SshOptions): Promise<SshSession> {
  const client = new Client()
  let hostKeyRefused = false
  let settled = false
  return new Promise<SshSession>((resolve, reject) => {
    const fail = (error: SftpError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end()
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new SftpError('timeout')), options.timeoutMs ?? 20_000)
    client.on('error', (error: Error & { level?: string }) => {
      if (hostKeyRefused) return fail(new SftpError('host-key'))
      if (error.level === 'client-authentication') return fail(new SftpError('auth'))
      fail(new SftpError('closed'))
    })
    client.on('close', () => fail(new SftpError(hostKeyRefused ? 'host-key' : 'closed')))
    client.on('ready', () => {
      client.subsys('sftp', (error, channel) => {
        if (error !== undefined && error !== null) return fail(new SftpError('unsupported'))
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          channel,
          close: () => {
            try {
              channel.destroy()
            } catch {}
            client.end()
            socket.destroy()
          },
        })
      })
    })
    try {
      client.connect({
        sock: socket,
        username: options.username,
        privateKey: options.privateKey,
        // Every key exchange, the first and any later one, must show the pinned key.
        hostVerifier: (key: Buffer) => {
          const ok = matchesPin(key, options.hostKeySha256)
          if (!ok) hostKeyRefused = true
          return ok
        },
        algorithms: ALGORITHMS,
        tryKeyboard: false,
        keepaliveInterval: 0,
        readyTimeout: options.timeoutMs ?? 20_000,
        // No agent, no password: the one key Valet holds for this credential.
        agent: undefined,
        agentForward: false,
        ident: 'Valet',
      } as ConnectConfig)
    } catch {
      // ssh2 refuses a key it can't read before connecting.
      fail(new SftpError('auth'))
    }
  })
}
