// A small SMTP submission client (RFC 5321, 6409, 3207, 4954): one connection, one message, no
// pipelining. It speaks only what sending one message needs, and it never signs in or sends a byte
// of mail before TLS: on any port but 465 the server must offer STARTTLS, and whatever the server
// sent after its STARTTLS reply but before the handshake is refused (the STARTTLS injection attack).
//
// Every line it writes is built here from checked values (smtp-policy.ts), never from tool code's
// text: addresses can hold no space, angle bracket or line break, and the message itself goes as
// DATA, dot-stuffed, with every line CRLF.

import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { isMailAddress } from '@valet/core/smtp-policy'

/** Why an SMTP exchange failed, in the words the host reports (host-session.ts hostError). */
export type SmtpFailure =
  /** The server refused: a sender or recipient it won't take, or a message it won't send. */
  | 'no'
  /** The server ended the connection, or it broke. */
  | 'closed'
  | 'timeout'
  /** The server sent something that isn't SMTP, or too much of it. */
  | 'malformed'
  | 'too-large'
  /** No STARTTLS where it is needed, or no AUTH Valet can use. */
  | 'unsupported'
  /** The sign-in was refused. */
  | 'auth'
  | 'invalid'

export class SmtpError extends Error {
  constructor(
    readonly failure: SmtpFailure,
    /** The server's reply code, when it gave one. */
    readonly code: string | null = null,
  ) {
    super(`smtp: ${failure}${code === null ? '' : ` [${code}]`}`)
  }
}

export interface Reply {
  readonly code: number
  readonly lines: readonly string[]
}

const MAX_LINE = 2048
const MAX_REPLY_LINES = 64
const DEFAULT_TIMEOUT_MS = 30_000
/** What the server may send in all: replies only, so a little. */
const MAX_BYTES_IN = 256 * 1024
/** EHLO's argument: an address literal says nothing about the Mac. */
const EHLO_NAME = '[127.0.0.1]'

export interface SmtpClientOptions {
  readonly commandTimeoutMs?: number
}

export class SmtpClient {
  private buffer = ''
  private bytesIn = 0
  private waiting: { resolve: (r: Reply) => void; reject: (e: SmtpError) => void } | null = null
  private replies: (Reply | SmtpError)[] = []
  private pendingLines: string[] = []
  private dead: SmtpError | null = null
  private extensions = new Map<string, string>()
  private secure: boolean
  private readonly timeoutMs: number

  private constructor(
    private socket: Duplex,
    secure: boolean,
    options: SmtpClientOptions,
  ) {
    this.secure = secure
    this.timeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.attach(socket)
  }

  /**
   * Opens a session on `socket`: reads the greeting and sends EHLO. `secure` is true when the
   * socket is TLS already (port 465); otherwise `upgrade` turns it into TLS after STARTTLS.
   */
  static async open(
    socket: Duplex,
    options: SmtpClientOptions & {
      readonly secure: boolean
      readonly upgrade: (plain: Duplex) => Promise<TLSSocket>
    },
  ): Promise<SmtpClient> {
    const client = new SmtpClient(socket, options.secure, options)
    try {
      client.expect(await client.next(), [220])
      await client.ehlo()
      if (!client.secure) {
        if (!client.extensions.has('STARTTLS')) throw new SmtpError('unsupported')
        client.expect(await client.command('STARTTLS'), [220])
        // Anything the server sent after its reply, before the handshake, would be read as if it
        // came over TLS: refused, not believed.
        if (client.buffer !== '' || client.replies.length > 0 || client.pendingLines.length > 0)
          throw new SmtpError('malformed')
        client.detach()
        client.buffer = ''
        client.replies = []
        client.pendingLines = []
        const tls = await options.upgrade(client.socket)
        client.socket = tls
        client.secure = true
        client.attach(tls)
        client.extensions = new Map()
        // The capabilities said before TLS are forgotten: only the ones said over TLS count.
        await client.ehlo()
      }
      return client
    } catch (error) {
      client.destroy()
      throw error instanceof SmtpError ? error : new SmtpError('closed')
    }
  }

  /** Signs in with AUTH PLAIN, or AUTH LOGIN if that is all the server offers. Only over TLS. */
  async login(username: string, password: string): Promise<void> {
    if (!this.secure) throw new SmtpError('unsupported')
    if (/[\0\r\n]/.test(username) || /[\0\r\n]/.test(password)) throw new SmtpError('invalid')
    const mechanisms = (this.extensions.get('AUTH') ?? '').toUpperCase().split(/\s+/)
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
    let reply: Reply
    if (mechanisms.includes('PLAIN')) {
      reply = await this.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`, true)
    } else if (mechanisms.includes('LOGIN')) {
      this.expect(await this.command('AUTH LOGIN'), [334])
      this.expect(await this.command(b64(username), true), [334])
      reply = await this.command(b64(password), true)
    } else {
      throw new SmtpError('unsupported')
    }
    if (reply.code === 535 || reply.code === 534 || reply.code === 530)
      throw new SmtpError('auth', String(reply.code))
    this.expect(reply, [235])
  }

  /**
   * Sends one message: MAIL FROM, a RCPT TO per recipient, DATA. If the server refuses any
   * recipient, nothing is sent (RSET) and it fails `no`. `data` is the whole message, CRLF lines.
   */
  async send(from: string, recipients: readonly string[], data: string): Promise<number> {
    if (!this.secure) throw new SmtpError('unsupported')
    if (!isMailAddress(from) || recipients.length === 0 || !recipients.every(isMailAddress))
      throw new SmtpError('invalid')
    if (!/^[\x20-\x7e\r\n]*$/.test(data) || /\r(?!\n)|(?<!\r)\n/.test(data)) throw new SmtpError('invalid')
    const size = this.extensions.get('SIZE')
    if (size !== undefined && /^\d+$/.test(size) && Number(size) > 0 && data.length > Number(size))
      throw new SmtpError('too-large')
    this.expect(await this.command(`MAIL FROM:<${from}>`), [250])
    for (const to of recipients) {
      const reply = await this.command(`RCPT TO:<${to}>`)
      if (reply.code !== 250 && reply.code !== 251) {
        await this.command('RSET').catch(() => undefined)
        throw new SmtpError(reply.code >= 400 ? 'no' : 'malformed', String(reply.code))
      }
    }
    this.expect(await this.command('DATA'), [354])
    // Dot-stuffing (RFC 5321 4.5.2): a line that starts with "." gets another, so no line of the
    // message can end the DATA early.
    const body = data.endsWith('\r\n') ? data : `${data}\r\n`
    const stuffed = body.replace(/(^|\r\n)\./g, '$1..')
    this.write(`${stuffed}.\r\n`)
    const done = await this.next()
    if (done.code >= 400 && done.code < 600) throw new SmtpError('no', String(done.code))
    this.expect(done, [250])
    return recipients.length
  }

  /** QUIT, then the connection closes. Never throws. */
  async quit(): Promise<void> {
    try {
      if (this.dead === null) await this.command('QUIT')
    } catch {}
    this.destroy()
  }

  destroy(): void {
    this.fail(new SmtpError('closed'))
    this.socket.destroy()
  }

  private async ehlo(): Promise<void> {
    const reply = await this.command(`EHLO ${EHLO_NAME}`)
    this.expect(reply, [250])
    for (const line of reply.lines.slice(1)) {
      const [keyword, ...rest] = line.split(' ')
      if (keyword !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(keyword))
        this.extensions.set(keyword.toUpperCase(), rest.join(' '))
    }
  }

  private expect(reply: Reply, codes: readonly number[]): void {
    if (codes.includes(reply.code)) return
    throw new SmtpError(reply.code >= 400 && reply.code < 600 ? 'no' : 'malformed', String(reply.code))
  }

  /** Writes one command line and reads its reply. `secret`: the line is never kept for errors. */
  private async command(line: string, _secret = false): Promise<Reply> {
    if (/[\r\n]/.test(line) || line.length > 1000) throw new SmtpError('invalid')
    this.write(`${line}\r\n`)
    return this.next()
  }

  private write(text: string): void {
    if (this.dead !== null) throw this.dead
    this.socket.write(text)
  }

  private next(): Promise<Reply> {
    const queued = this.replies.shift()
    if (queued !== undefined)
      return queued instanceof SmtpError ? Promise.reject(queued) : Promise.resolve(queued)
    if (this.dead !== null) return Promise.reject(this.dead)
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new SmtpError('timeout')
        this.fail(error)
        this.socket.destroy()
      }, this.timeoutMs)
      this.waiting = {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
    })
  }

  private readonly onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('latin1')
    this.bytesIn += text.length
    if (this.bytesIn > MAX_BYTES_IN) {
      this.broken(new SmtpError('too-large'))
      return
    }
    this.buffer += text
    let index = this.buffer.indexOf('\r\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      this.onLine(line)
      if (this.dead !== null) return
      index = this.buffer.indexOf('\r\n')
    }
    if (this.buffer.length > MAX_LINE) this.broken(new SmtpError('malformed'))
  }

  private readonly onClose = () => this.fail(new SmtpError('closed'))

  private onLine(line: string): void {
    const match = /^([2-5][0-9][0-9])([ -])(.*)$/.exec(line) ?? /^([2-5][0-9][0-9])()$/.exec(line)
    if (match === null || line.length > MAX_LINE) {
      this.broken(new SmtpError('malformed'))
      return
    }
    const code = match[1] as string
    if (this.pendingLines.length > 0 && !this.pendingLines[0]?.startsWith(code)) {
      this.broken(new SmtpError('malformed'))
      return
    }
    this.pendingLines.push(`${code} ${match[3] ?? ''}`)
    if (this.pendingLines.length > MAX_REPLY_LINES) {
      this.broken(new SmtpError('malformed'))
      return
    }
    if (match[2] === '-') return
    const reply: Reply = { code: Number(code), lines: this.pendingLines.map((l) => l.slice(4)) }
    this.pendingLines = []
    this.deliver(reply)
  }

  private deliver(value: Reply | SmtpError): void {
    const waiting = this.waiting
    if (waiting === null) {
      this.replies.push(value)
      return
    }
    this.waiting = null
    if (value instanceof SmtpError) waiting.reject(value)
    else waiting.resolve(value)
  }

  private broken(error: SmtpError): void {
    this.fail(error)
    this.socket.destroy()
  }

  private fail(error: SmtpError): void {
    if (this.dead !== null) return
    this.dead = error
    const waiting = this.waiting
    this.waiting = null
    waiting?.reject(error)
  }

  private attach(socket: Duplex): void {
    socket.on('data', this.onData)
    socket.on('close', this.onClose)
    socket.on('error', this.onClose)
  }

  private detach(): void {
    this.socket.off('data', this.onData)
    this.socket.off('close', this.onClose)
    this.socket.off('error', this.onClose)
  }
}
