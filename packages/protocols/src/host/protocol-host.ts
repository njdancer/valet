// The protocol host's entry point (docs/imap.md#the-protocol-host). Valet's own IMAP client runs
// here, in a Node process under the same deny-by-default Seatbelt profile as a raw adapter, whose
// only network is the egress broker's tunnel to the one declared endpoint. So parsing hostile mail
// never happens in Valet's main process. Bundled into one script at build time (build.ts).
//
// Valet's own SMTP client runs here too, for one send per host (workstream G): boot says which.
//
// The channel to Valet is file descriptor 3: newline-separated JSON, both ways.
//   Valet → host: boot (the protocol, tunnel port, endpoint, purpose, folders or recipients), login
//                 (once), op, signInMail, send, end.
//   host → Valet: ready, result (for login, op and signInMail, by id).
// Valet checks what comes back as untrusted; the purpose and folder rules are enforced here too.

import { Socket } from 'node:net'
import { type TLSSocket, connect as tlsConnect } from 'node:tls'
import { isOperation, type ImapPurpose as Purpose } from '@valet/core/imap-policy'
import {
  buildMailMessage,
  checkMailMessage,
  envelopeRecipients,
  isMailAddress,
  isMessageId,
  recipientAllowed,
} from '@valet/core/smtp-policy'
import { ImapClient, ImapError } from '../imap/client'
import { Operations } from '../imap/operations'
import { findSignInMail, type SignInQuery } from '../imap/signin'
import { SmtpClient, SmtpError } from '../smtp/client'

const MAX_LINE = 4_100_000

interface Boot {
  readonly t: 'boot'
  /** Left out: IMAP, as before SMTP. */
  readonly protocol?: 'imap' | 'smtp'
  /** SMTP only: the manifest's recipients list, or null for anyone. */
  readonly recipients?: readonly string[] | null
  readonly tunnels: Readonly<Record<string, number>>
  readonly endpoint: string
  readonly purpose: Purpose
  readonly folders: readonly string[] | null
  /** Tests only: the certificate to trust in place of Node's own roots. */
  readonly ca?: string
}

const channel = new Socket({ fd: 3, readable: true, writable: true })
channel.setEncoding('utf8')
const post = (message: object) => {
  try {
    channel.write(`${JSON.stringify(message)}\n`)
  } catch {}
}

let boot: Boot | null = null
let client: ImapClient | null = null
let operations: Operations | null = null
let busy = Promise.resolve()
let smtp: { readonly client: SmtpClient; readonly from: string; sent: boolean } | null = null

const failure = (error: unknown) =>
  error instanceof ImapError || error instanceof SmtpError
    ? { failure: error.failure, code: error.code }
    : { failure: 'malformed', code: null }

/** The tunnel's port for the endpoint, and the endpoint's host name. */
function tunnel(b: Boot): { readonly port: number; readonly host: string } | null {
  const port = b.tunnels[b.endpoint]
  return port === undefined ? null : { port, host: b.endpoint.slice(0, b.endpoint.lastIndexOf(':')) }
}

/** SMTP: TLS from the first byte on 465, else plain TCP that must turn into TLS with STARTTLS. */
async function smtpLogin(id: number, b: Boot, username: string, password: string): Promise<void> {
  if (smtp !== null) throw new SmtpError('invalid')
  // From is the account Valet signs in as: it must be a plain address to be one.
  if (!isMailAddress(username)) throw new SmtpError('auth')
  const t = tunnel(b)
  if (t === null) throw new SmtpError('closed')
  const tlsOptions = {
    servername: t.host,
    ...(b.ca === undefined ? {} : { ca: b.ca }),
    minVersion: 'TLSv1.2' as const,
  }
  const implicit = b.endpoint.endsWith(':465')
  const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
    const s = implicit
      ? tlsConnect({ host: '127.0.0.1', port: t.port, ...tlsOptions })
      : new Socket().connect(t.port, '127.0.0.1')
    s.once(implicit ? 'secureConnect' : 'connect', () => resolve(s))
    s.once('error', () => reject(new SmtpError('closed')))
  })
  const client = await SmtpClient.open(socket, {
    secure: implicit,
    upgrade: (plain) =>
      new Promise((resolve, reject) => {
        const tls = tlsConnect({ socket: plain as Socket, ...tlsOptions })
        tls.once('secureConnect', () => resolve(tls))
        tls.once('error', () => reject(new SmtpError('closed')))
      }),
  })
  smtp = { client, from: username, sent: false }
  await client.login(username, password)
  post({ t: 'result', id, ok: true, value: null })
}

/** One send: checked again here, built here with From the signed-in account, and sent once. */
async function smtpSend(id: number, b: Boot, value: unknown): Promise<void> {
  if (smtp === null || smtp.sent) throw new SmtpError('invalid')
  const v = (value ?? {}) as Record<string, unknown>
  const message = checkMailMessage(v['message'])
  if (message === null || !isMessageId(v['messageId']) || typeof v['date'] !== 'number')
    throw new SmtpError('invalid')
  const recipients = envelopeRecipients(message)
  if (!recipients.every((r) => recipientAllowed(r, b.recipients ?? null))) throw new SmtpError('invalid')
  const data = buildMailMessage(smtp.from, message, { messageId: v['messageId'], date: v['date'] })
  // One message per host: a second send in the same call starts a new host, and a new confirmation.
  smtp.sent = true
  const accepted = await smtp.client.send(smtp.from, recipients, data)
  post({ t: 'result', id, ok: true, value: { accepted } })
}

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
        if (boot?.protocol === 'smtp')
          return await smtpLogin(id, boot, message['username'], message['password'])
        return await login(id, message['username'], message['password'])
      case 'send':
        if (boot?.protocol !== 'smtp') throw new ImapError('not-allowed')
        return await smtpSend(id, boot, message['value'])
      case 'op': {
        if (boot?.protocol === 'smtp' || operations === null) throw new ImapError('closed')
        const op = message['op']
        const args = message['args']
        if (!isOperation(op) || !Array.isArray(args)) throw new ImapError('invalid')
        const value = await operations.run(op, args)
        post({ t: 'result', id, ok: true, value: value ?? null })
        return
      }
      case 'signInMail': {
        if (boot?.protocol === 'smtp' || client === null || boot?.purpose !== 'read')
          throw new ImapError('not-allowed')
        const value = await findSignInMail(client, message['query'] as SignInQuery)
        post({ t: 'result', id, ok: true, value })
        return
      }
      case 'end':
        await client?.logout()
        await smtp?.client.quit()
        process.exit(0)
        return
      default:
        throw new ImapError('invalid')
    }
  } catch (error) {
    post({ t: 'result', id, ok: false, ...failure(error) })
  }
}

let buffer = ''
channel.on('data', (chunk: string) => {
  buffer += chunk
  if (buffer.length > MAX_LINE) process.exit(1)
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      process.exit(1)
    }
    if (boot === null) {
      if (message['t'] !== 'boot') process.exit(1)
      boot = message as unknown as Boot
      post({ t: 'ready' })
    } else {
      busy = busy.then(() => handle(message))
    }
    index = buffer.indexOf('\n')
  }
})
channel.on('end', () => process.exit(0))
channel.on('error', () => process.exit(1))
