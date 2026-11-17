// A small IMAP client: one connection, one command at a time, every command held to the session's
// purpose by checkCommand before a byte of it is written. It speaks only what Valet's operations
// need (operations.ts), so its whole command surface is the table in policy.ts.

import type { Duplex } from 'node:stream'
import { type Command, CommandRefused, checkCommand, encodeCommand, type SessionState } from './command'
import type { ImapPurpose as Purpose } from '@valet/core/imap-policy'
import { Atom, DEFAULT_WIRE_LIMITS, Framer, parseResponse, type Response, type Value, type WireLimits, WireError } from './wire'

/** Why an IMAP exchange failed, in words the host reports as error classes. */
export type ImapFailure =
  /** The server said NO (a missing folder, a refused login, a quota). */
  | 'no'
  /** The server said BAD: Valet sent something it didn't understand. */
  | 'bad'
  /** The server ended the connection, or it broke. */
  | 'closed'
  | 'timeout'
  /** The server sent something that isn't IMAP, or too much of it. */
  | 'malformed'
  | 'too-large'
  /** The server can't do what was asked (no UIDPLUS for UID EXPUNGE, say). */
  | 'unsupported'
  /** The login was refused. */
  | 'auth'
  /** checkCommand refused the command: nothing was sent. */
  | 'not-allowed'
  | 'needs-irreversible'
  | 'invalid'

export class ImapError extends Error {
  constructor(
    readonly failure: ImapFailure,
    /** The server's response code, when it gave one (`AUTHENTICATIONFAILED`, `NONEXISTENT`). */
    readonly code: string | null = null,
  ) {
    super(`imap: ${failure}${code === null ? '' : ` [${code}]`}`)
  }
}

export interface ClientOptions {
  readonly purpose: Purpose
  readonly limits?: WireLimits
  /** How long one command may take, its literals included. */
  readonly commandTimeoutMs?: number
  /** The most bytes the server may send over the whole connection. */
  readonly maxBytesIn?: number
}

export interface Result {
  readonly untagged: readonly Response[]
  readonly code: Value[] | null
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_BYTES_IN = 64 * 1024 * 1024

interface Waiting {
  readonly tag: string
  readonly untagged: Response[]
  readonly resolve: (result: Result) => void
  readonly reject: (error: ImapError) => void
  continuation: (() => void) | null
}

export class ImapClient {
  private readonly framer: Framer
  private readonly limits: WireLimits
  private next = 1
  private waiting: Waiting | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private failed: ImapError | null = null
  private bytesIn = 0
  private greeting: { resolve: (r: Response) => void; reject: (e: ImapError) => void } | null = null
  private capabilities = new Set<string>()
  private state: { purpose: Purpose; selected: SessionState['selected'] }

  private constructor(
    private readonly socket: Duplex,
    private readonly options: ClientOptions,
  ) {
    this.limits = options.limits ?? DEFAULT_WIRE_LIMITS
    this.framer = new Framer(this.limits)
    this.state = { purpose: options.purpose, selected: null }
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', () => this.fail(new ImapError('closed')))
    socket.on('close', () => this.fail(new ImapError('closed')))
  }

  /** Reads the server's greeting. PREAUTH is refused: Valet always signs in itself. */
  static async open(socket: Duplex, options: ClientOptions): Promise<ImapClient> {
    const client = new ImapClient(socket, options)
    const greeting = await client.withTimeout(
      new Promise<Response>((resolve, reject) => {
        client.greeting = { resolve, reject }
      }),
    )
    if (greeting.kind !== 'status' || greeting.status !== 'OK') {
      client.close()
      throw new ImapError(greeting.kind === 'status' && greeting.status === 'BYE' ? 'closed' : 'malformed')
    }
    client.noteCapabilities(greeting.code)
    return client
  }

  get selected(): SessionState['selected'] {
    return this.state.selected
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability.toUpperCase())
  }

  /** CAPABILITY, unless the greeting already listed them. */
  async loadCapabilities(force = false): Promise<void> {
    if (!force && this.capabilities.has('IMAP4REV1')) return
    const result = await this.run({ verb: 'CAPABILITY', args: [] })
    for (const r of result.untagged) {
      if (r.kind === 'data' && r.name === 'CAPABILITY') this.setCapabilities(r.values)
    }
  }

  /** LOGIN. The values are written as strings or literals, never pasted. */
  async login(username: Buffer, password: Buffer): Promise<void> {
    if (this.has('LOGINDISABLED')) throw new ImapError('unsupported')
    try {
      const result = await this.run({ verb: 'LOGIN', args: [{ string: username }, { string: password }] })
      this.noteCapabilities(result.code)
    } catch (error) {
      if (error instanceof ImapError && error.failure === 'no') throw new ImapError('auth', error.code)
      throw error
    }
    // Capabilities may change once signed in.
    this.capabilities.clear()
    await this.loadCapabilities(true)
  }

  /** Opens `folder`: EXAMINE for a read-only look, SELECT only when the session may write. */
  async open(folder: string, readOnly: boolean): Promise<Result> {
    if (this.state.selected?.folder === folder && (!this.state.selected.readOnly || readOnly)) {
      return { untagged: [], code: null }
    }
    this.state = { ...this.state, selected: null }
    const result = await this.run({ verb: readOnly ? 'EXAMINE' : 'SELECT', args: [{ mailbox: folder }] })
    this.state = { ...this.state, selected: { folder, readOnly } }
    return result
  }

  /** Runs one command, after the ones before it. Rejects with ImapError. */
  run(command: Command): Promise<Result> {
    const job = this.queue.then(() => this.exchange(command))
    this.queue = job.catch(() => undefined)
    return job
  }

  /** LOGOUT if the connection is still up, then closes it. Never throws. */
  async logout(): Promise<void> {
    if (this.failed === null) {
      try {
        await this.run({ verb: 'LOGOUT', args: [] })
      } catch {}
    }
    this.close()
  }

  close(): void {
    this.fail(new ImapError('closed'))
    this.socket.destroy()
  }

  private async exchange(command: Command): Promise<Result> {
    if (this.failed !== null) throw this.failed
    try {
      checkCommand(command, this.state)
    } catch (error) {
      if (error instanceof CommandRefused) throw new ImapError(error.reason)
      throw error
    }
    const tag = `V${this.next++}`
    let segments: ReturnType<typeof encodeCommand>
    try {
      segments = encodeCommand(tag, command, this.has('LITERAL+'))
    } catch {
      throw new ImapError('invalid')
    }
    const done = new Promise<Result>((resolve, reject) => {
      this.waiting = { tag, untagged: [], resolve, reject, continuation: null }
    })
    const send = async () => {
      for (const segment of segments) {
        if ('literal' in segment) {
          await new Promise<void>((resolve) => {
            if (this.waiting !== null) this.waiting.continuation = resolve
          })
          this.socket.write(segment.literal)
        } else this.socket.write(segment.text)
      }
    }
    void send()
    try {
      return await this.withTimeout(done)
    } finally {
      this.waiting = null
    }
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    const ms = this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ImapError('timeout')
        this.fail(error)
        this.socket.destroy()
        reject(error)
      }, ms)
    })
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
  }

  private onData(chunk: Buffer): void {
    if (this.failed !== null) return
    this.bytesIn += chunk.length
    if (this.bytesIn > (this.options.maxBytesIn ?? DEFAULT_MAX_BYTES_IN)) {
      this.fail(new ImapError('too-large'))
      this.socket.destroy()
      return
    }
    this.framer.push(chunk)
    try {
      for (;;) {
        const bytes = this.framer.take()
        if (bytes === null) return
        this.onResponse(parseResponse(bytes, this.limits))
        if (this.failed !== null) return
      }
    } catch (error) {
      this.fail(new ImapError(error instanceof WireError ? error.reason : 'malformed'))
      this.socket.destroy()
    }
  }

  private onResponse(response: Response): void {
    if (this.greeting !== null) {
      const greeting = this.greeting
      this.greeting = null
      greeting.resolve(response)
      return
    }
    const waiting = this.waiting
    if (response.kind === 'status' && response.status === 'BYE') {
      // The server is ending the connection; a LOGOUT expects it, anything else fails.
      waiting?.untagged.push(response)
      return
    }
    if (waiting === null) {
      // Untagged data between commands (EXISTS, an alert) carries nothing Valet needs.
      if (response.kind === 'tagged' || response.kind === 'continue') this.fail(new ImapError('malformed'))
      return
    }
    if (response.kind === 'continue') {
      const resume = waiting.continuation
      if (resume === null) return this.fail(new ImapError('malformed'))
      waiting.continuation = null
      resume()
      return
    }
    if (response.kind === 'tagged') {
      if (response.tag !== waiting.tag) return this.fail(new ImapError('malformed'))
      if (response.status === 'OK') waiting.resolve({ untagged: waiting.untagged, code: response.code })
      else waiting.reject(new ImapError(response.status === 'NO' ? 'no' : 'bad', codeName(response.code)))
      return
    }
    if (waiting.untagged.length >= 100_000) return this.fail(new ImapError('too-large'))
    waiting.untagged.push(response)
  }

  private fail(error: ImapError): void {
    if (this.failed !== null) return
    this.failed = error
    this.greeting?.reject(error)
    this.greeting = null
    this.waiting?.reject(error)
  }

  private noteCapabilities(code: Value[] | null): void {
    if (code !== null && code[0] instanceof Atom && code[0].value.toUpperCase() === 'CAPABILITY') {
      this.setCapabilities(code.slice(1))
    }
  }

  private setCapabilities(values: readonly Value[]): void {
    this.capabilities = new Set(
      values.filter((v): v is Atom => v instanceof Atom).map((v) => v.value.toUpperCase()).slice(0, 200),
    )
  }
}

/** A response code's name (`TRYCREATE`), or null. */
export function codeName(code: Value[] | null): string | null {
  const first = code?.[0]
  return first instanceof Atom && /^[A-Za-z-]{1,40}$/.test(first.value) ? first.value.toUpperCase() : null
}
