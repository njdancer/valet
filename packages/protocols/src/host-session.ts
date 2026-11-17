// Valet's side of the protocol hosts (docs/imap.md#the-protocol-host, docs/sftp.md): starts one
// sandboxed host process for one call, signs it in with a kept credential just in time, and relays operations to
// it. The process is untrusted from here: every message it sends is checked, and an answer that
// doesn't fit fails the call. When the call ends, however it ends, the process is killed and its
// tunnel closed.

import { SecretValue, ValetError } from '@valet/core'
import type { Operation, ImapPurpose as Purpose } from '@valet/core/imap-policy'
import type { SftpPurpose, SftpRoot } from '@valet/core/sftp-policy'
import { type NodeChannel, type OpenTunnels, sandboxedNode } from '@valet/node-runtime'
import { isPlainJson } from '@valet/runtime/protocol'
import type { ImapFailure } from './imap/client'
import type { SignInQuery, SignInResult } from './imap/signin'
import type { SftpFailure } from './sftp/wire'

export interface ProtocolHostOptions {
  /** The runtime's own Node binary (never Electron run as Node). */
  readonly nodeBinary: string
  /** The bundled protocol host (build.ts). */
  readonly hostScript: string
  /** The person's home folder, for the never-grantable places under it. */
  readonly home: string
  readonly alsoForbidden?: readonly string[]
  /** How long one operation may take, the host's own start included. Default 60 s. */
  readonly operationTimeoutMs?: number
  readonly onStderr?: (text: string) => void
  /** Tests only, off macOS: run without Seatbelt. The app never sets it. */
  readonly withoutSeatbelt?: boolean
  /** Tests only: the certificate the host trusts in place of Node's roots. */
  readonly testCa?: string
  /** Tests only: called with each profile the host ran under. */
  readonly onProfile?: (profile: string) => void
}

export interface SignInValues {
  readonly username: SecretValue | null
  readonly secret: SecretValue
}

export interface StartOptions {
  readonly host: ProtocolHostOptions
  /** `host:port`, exactly as the credential and manifest declare it. */
  readonly endpoint: string
  readonly purpose: Purpose
  readonly folders: readonly string[] | null
  /** The broker's tunnels for this call. */
  readonly openTunnels: OpenTunnels
  /** The kept credential, asked for only once the host is up. Its values are disposed here. */
  readonly signIn: () => Promise<SignInValues>
  readonly signal: AbortSignal
}

export const DEFAULT_OPERATION_TIMEOUT_MS = 60_000

/** How a failure the host reports reaches tool code. */
export function hostError(failure: unknown, code: unknown): ValetError {
  switch (failure as ImapFailure | SftpFailure) {
    case 'not-allowed':
    case 'needs-irreversible':
      return new ValetError('request-surface', 'command-not-allowed')
    case 'invalid':
      return new ValetError('tool-run', 'invalid')
    case 'auth':
      return new ValetError('credential', 'auth-failed')
    case 'host-key':
      return new ValetError('egress', 'host-key-mismatch')
    case 'unsupported':
      return new ValetError('egress', 'unsupported')
    case 'timeout':
      return new ValetError('timeout', 'timed-out')
    case 'no':
      switch (code) {
        case 'NONEXISTENT':
        case 'TRYCREATE':
          return new ValetError('egress', 'not-found')
        case 'ALREADYEXISTS':
        case 'NOTEMPTY':
          return new ValetError('egress', 'invalid')
        case 'DENIED':
          return new ValetError('egress', 'blocked-by-site')
        case 'UNSUPPORTED':
          return new ValetError('egress', 'unsupported')
        default:
          return new ValetError('egress', 'unavailable')
      }
    case 'too-large':
    case 'malformed':
      return new ValetError('egress', 'unexpected-shape')
    default:
      return new ValetError('egress', 'unavailable')
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: ValetError) => void
}

/** What any protocol host needs to start: one endpoint, its boot message, and how to sign in. */
interface LaunchOptions {
  readonly host: ProtocolHostOptions
  readonly endpoint: string
  /** The boot message's fields beyond `t` and `tunnels`. */
  readonly boot: Readonly<Record<string, unknown>>
  readonly openTunnels: OpenTunnels
  readonly signIn: () => Promise<SignInValues>
  /** The login message's fields, from the revealed username and secret. */
  readonly login: (username: string, secret: string) => Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

/**
 * One protocol host process for one call: started under the profile, signed in just in time, then
 * asked for operations. Everything it sends is checked; anything unexpected kills it.
 */
export class HostSession {
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private ended: ValetError | null = null
  private ready: Pending | null = null

  protected constructor(
    private readonly channel: NodeChannel,
    private readonly timeoutMs: number,
  ) {
    channel.onMessage((message) => this.onMessage(message))
    channel.onExit(() => this.fail(new ValetError('egress', 'unavailable')))
  }

  /** Starts a host, waits for it, and signs it in. Rejects with a ValetError; nothing is left running. */
  protected static async launch<S extends HostSession>(
    make: (channel: NodeChannel, timeoutMs: number) => S,
    options: LaunchOptions,
  ): Promise<S> {
    if (options.signal.aborted) throw new ValetError('tool-run', 'aborted')
    const host = options.host
    const start = sandboxedNode({
      nodeBinary: host.nodeBinary,
      hostScript: host.hostScript,
      home: host.home,
      endpoints: [options.endpoint],
      openTunnels: options.openTunnels,
      ...(host.alsoForbidden === undefined ? {} : { alsoForbidden: host.alsoForbidden }),
      ...(host.onStderr === undefined ? {} : { onStderr: host.onStderr }),
      ...(host.onProfile === undefined ? {} : { onProfile: host.onProfile }),
      ...(host.withoutSeatbelt === true ? { withoutSeatbelt: true } : {}),
      boot: (tunnels) => ({
        t: 'boot',
        tunnels,
        ...options.boot,
        ...(host.testCa === undefined ? {} : { ca: host.testCa }),
      }),
    })
    const session = make(start(), host.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS)
    const abort = () => session.close()
    options.signal.addEventListener('abort', abort, { once: true })
    try {
      await session.within(
        new Promise((resolve, reject) => {
          session.ready = { resolve, reject }
        }),
      )
      const values = await options.signIn()
      let username: string
      let secret: string
      try {
        // The host signs in with these and keeps nothing else of them; they never reach tool code.
        username = values.username?.reveal((v) => v) ?? ''
        secret = values.secret.reveal((v) => v)
      } finally {
        values.username?.dispose()
        values.secret.dispose()
      }
      if (username === '') throw new ValetError('credential', 'field-missing')
      await session.request({ t: 'login', ...options.login(username, secret) })
      return session
    } catch (error) {
      session.close()
      options.signal.removeEventListener('abort', abort)
      if (options.signal.aborted) throw new ValetError('tool-run', 'aborted')
      throw error instanceof ValetError ? error : new ValetError('egress', 'unavailable')
    }
  }

  /** One operation. Its arguments were checked already; the host checks them again. */
  operation(op: string, args: readonly unknown[]): Promise<unknown> {
    return this.request({ t: 'op', op, args })
  }

  /** Signs out and ends the process. Never throws; safe to call more than once. */
  async end(): Promise<void> {
    if (this.ended !== null) return
    try {
      this.channel.send({ t: 'end' })
    } catch {}
    // A short grace for LOGOUT, then the process is killed whatever it is doing.
    await new Promise((resolve) => setTimeout(resolve, 200).unref?.())
    this.close()
  }

  close(): void {
    this.fail(new ValetError('tool-run', 'aborted'))
    this.channel.kill()
  }

  protected request(message: Record<string, unknown>): Promise<unknown> {
    if (this.ended !== null) return Promise.reject(this.ended)
    const id = this.next++
    const answer = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.channel.send({ ...message, id })
    return this.within(answer).finally(() => this.pending.delete(id))
  }

  protected within<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ValetError('timeout', 'timed-out')
        this.fail(error)
        this.channel.kill()
        reject(error)
      }, this.timeoutMs)
    })
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
  }

  private onMessage(message: unknown): void {
    if (this.ended !== null) return
    if (!isPlainJson(message) || message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.broken()
      return
    }
    const m = message as Record<string, unknown>
    if (m['t'] === 'ready' && this.ready !== null) {
      const ready = this.ready
      this.ready = null
      ready.resolve(undefined)
      return
    }
    const pending = m['t'] === 'result' && typeof m['id'] === 'number' ? this.pending.get(m['id']) : undefined
    if (pending === undefined || typeof m['id'] !== 'number') {
      this.broken()
      return
    }
    this.pending.delete(m['id'])
    if (m['ok'] === true) pending.resolve(m['value'] ?? null)
    else pending.reject(hostError(m['failure'], m['code']))
  }

  /** The host said something it never says: it is not to be believed again. */
  private broken(): void {
    this.fail(new ValetError('egress', 'unexpected-shape'))
    this.channel.kill()
  }

  private fail(error: ValetError): void {
    if (this.ended !== null) return
    this.ended = error
    this.ready?.reject(error)
    this.ready = null
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }
}

/** The IMAP host (docs/imap.md#the-protocol-host): Valet's own client, signed in with a password. */
export class ImapHostSession extends HostSession {
  /** Starts the host, waits for it, and signs it in. Rejects with a ValetError; nothing is left running. */
  static start(options: StartOptions): Promise<ImapHostSession> {
    return HostSession.launch((channel, timeoutMs) => new ImapHostSession(channel, timeoutMs), {
      host: options.host,
      endpoint: options.endpoint,
      boot: { endpoint: options.endpoint, purpose: options.purpose, folders: options.folders },
      openTunnels: options.openTunnels,
      signIn: options.signIn,
      login: (username, password) => ({ username, password }),
      signal: options.signal,
    })
  }

  /** One ctx.imap operation. Its arguments were checked already; the host checks them again. */
  override operation(op: Operation, args: readonly unknown[]): Promise<unknown> {
    return super.operation(op, args)
  }

  /** The built-in sign-in lookup. The host refuses it unless it was started to read. */
  async signInMail(query: SignInQuery): Promise<SignInResult> {
    const value = await this.request({ t: 'signInMail', query })
    if (value !== null && typeof value === 'object') {
      const v = value as Record<string, unknown>
      if (v['found'] === false && Object.keys(v).length === 1) return { found: false }
      if (v['found'] === true && typeof v['value'] === 'string' && Object.keys(v).length === 2)
        return { found: true, value: v['value'] }
    }
    throw new ValetError('egress', 'unexpected-shape')
  }
}

export interface SftpStartOptions {
  /** Its hostScript is the bundled SFTP host (build.ts writeSftpHost). */
  readonly host: ProtocolHostOptions
  /** `host:port`, exactly as the credential and manifest declare it. */
  readonly endpoint: string
  readonly purpose: SftpPurpose
  readonly roots: readonly SftpRoot[]
  readonly hostKeySha256: string
  readonly openTunnels: OpenTunnels
  /** The kept ssh-key credential, asked for only once the host is up. Its values are disposed here. */
  readonly signIn: () => Promise<SignInValues>
  /** The manifest's username, for an item that has none (a key Valet made). */
  readonly username?: string | undefined
  readonly signal: AbortSignal
}

/** The SFTP host (docs/sftp.md#the-protocol-host): ssh2 and Valet's own SFTP client, key sign-in. */
export class SftpHostSession extends HostSession {
  static start(options: SftpStartOptions): Promise<SftpHostSession> {
    return HostSession.launch((channel, timeoutMs) => new SftpHostSession(channel, timeoutMs), {
      host: options.host,
      endpoint: options.endpoint,
      boot: {
        endpoint: options.endpoint,
        purpose: options.purpose,
        roots: options.roots,
        hostKeySha256: options.hostKeySha256,
      },
      openTunnels: options.openTunnels,
      signIn: async () => {
        const values = await options.signIn()
        // The item's own username wins; a key Valet made has none, so the manifest names the account.
        if (values.username !== null || options.username === undefined) return values
        return { username: SecretValue.fromString(options.username), secret: values.secret }
      },
      login: (username, key) => ({ username, key }),
      signal: options.signal,
    })
  }
}
