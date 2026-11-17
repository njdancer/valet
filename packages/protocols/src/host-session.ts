// Valet's side of the protocol host (docs/imap.md#the-protocol-host): starts one sandboxed host
// process for one call, signs it in with a kept credential just in time, and relays operations to
// it. The process is untrusted from here: every message it sends is checked, and an answer that
// doesn't fit fails the call. When the call ends, however it ends, the process is killed and its
// tunnel closed.

import { type SecretValue, ValetError } from '@valet/core'
import type { Operation, ImapPurpose as Purpose } from '@valet/core/imap-policy'
import { type NodeChannel, type OpenTunnels, sandboxedNode } from '@valet/node-runtime'
import { isPlainJson } from '@valet/runtime/protocol'
import type { ImapFailure } from './imap/client'
import type { SignInQuery, SignInResult } from './imap/signin'

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
  /** Left out: IMAP. */
  readonly protocol?: 'imap' | 'smtp'
  /** SMTP only: the manifest's recipients list, which the host checks again; null for anyone. */
  readonly recipients?: readonly string[] | null
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
  switch (failure as ImapFailure) {
    case 'not-allowed':
    case 'needs-irreversible':
      return new ValetError('request-surface', 'command-not-allowed')
    case 'invalid':
      return new ValetError('tool-run', 'invalid')
    case 'auth':
      return new ValetError('credential', 'auth-failed')
    case 'unsupported':
      return new ValetError('egress', 'unsupported')
    case 'timeout':
      return new ValetError('timeout', 'timed-out')
    case 'no':
      return code === 'NONEXISTENT' || code === 'TRYCREATE'
        ? new ValetError('egress', 'not-found')
        : code === 'ALREADYEXISTS'
          ? new ValetError('egress', 'invalid')
          : new ValetError('egress', 'unavailable')
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

export class ImapHostSession {
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private ended: ValetError | null = null
  private ready: Pending | null = null

  private constructor(
    private readonly channel: NodeChannel,
    private readonly timeoutMs: number,
  ) {
    channel.onMessage((message) => this.onMessage(message))
    channel.onExit(() => this.fail(new ValetError('egress', 'unavailable')))
  }

  /** Starts the host, waits for it, and signs it in. Rejects with a ValetError; nothing is left running. */
  static async start(options: StartOptions): Promise<ImapHostSession> {
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
        endpoint: options.endpoint,
        purpose: options.purpose,
        folders: options.folders,
        ...(options.protocol === 'smtp' ? { protocol: 'smtp', recipients: options.recipients ?? null } : {}),
        ...(host.testCa === undefined ? {} : { ca: host.testCa }),
      }),
    })
    const session = new ImapHostSession(start(), host.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS)
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
      let password: string
      try {
        // The host signs in with these and keeps nothing else of them; they never reach tool code.
        username = values.username?.reveal((v) => v) ?? ''
        password = values.secret.reveal((v) => v)
      } finally {
        values.username?.dispose()
        values.secret.dispose()
      }
      if (username === '') throw new ValetError('credential', 'field-missing')
      await session.request({ t: 'login', username, password })
      return session
    } catch (error) {
      session.close()
      options.signal.removeEventListener('abort', abort)
      if (options.signal.aborted) throw new ValetError('tool-run', 'aborted')
      throw error instanceof ValetError ? error : new ValetError('egress', 'unavailable')
    }
  }

  /** One ctx.imap operation. Its arguments were checked already; the host checks them again. */
  operation(op: Operation, args: readonly unknown[]): Promise<unknown> {
    return this.request({ t: 'op', op, args })
  }

  /**
   * SMTP: sends the one message this host may send. The host checks it again, builds it with From
   * the signed-in account, and refuses a second send.
   */
  async sendMail(value: {
    readonly message: unknown
    readonly messageId: string
    readonly date: number
  }): Promise<{ readonly accepted: number }> {
    const answer = await this.request({ t: 'send', value })
    if (answer !== null && typeof answer === 'object' && !Array.isArray(answer)) {
      const a = answer as Record<string, unknown>
      if (Object.keys(a).length === 1 && Number.isInteger(a['accepted']) && (a['accepted'] as number) > 0)
        return { accepted: a['accepted'] as number }
    }
    throw new ValetError('egress', 'unexpected-shape')
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

  private request(message: Record<string, unknown>): Promise<unknown> {
    if (this.ended !== null) return Promise.reject(this.ended)
    const id = this.next++
    const answer = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.channel.send({ ...message, id })
    return this.within(answer).finally(() => this.pending.delete(id))
  }

  private within<T>(work: Promise<T>): Promise<T> {
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
