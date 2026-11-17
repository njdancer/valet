// Sending mail end to end (workstream G): the bundled protocol host in its own Node process (under
// Seatbelt on macOS), reaching a real SMTP server implementation (smtp-server, a fake on loopback)
// only through the egress broker's tunnel, over STARTTLS or TLS, signed in just in time. And what
// the host refuses on its own, as if the runtime's checks were bypassed.

import { mkdtemp } from 'node:fs/promises'
import { type AddressInfo, createServer as createTcpServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkMailMessage, SecretValue, type SmtpProtocol } from '@valet/core'
import { generateTestCertificate } from '@valet/fake-woolworths-site'
import { SMTPServer, type SMTPServerOptions } from 'smtp-server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ImapHostSession } from '../src/host-session'
import { smtpBackend } from '../src/smtp-backend'
import { builtHost, mac, run } from './helpers'

const USER = { username: 'nick@icloud.test', password: 'app-specific-password-1' }

interface Received {
  readonly from: string
  readonly to: readonly string[]
  readonly data: string
}

interface Fake {
  readonly port: number
  readonly received: Received[]
  readonly auths: { username: string; method: string }[]
  close(): Promise<void>
}

let cert: { key: string; cert: string }
beforeAll(async () => {
  cert = await generateTestCertificate(['smtp.mail.me.com'])
}, 30_000)

const servers: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function fakeSmtp(options: Partial<SMTPServerOptions> = {}): Promise<Fake> {
  const received: Received[] = []
  const auths: Fake['auths'] = []
  const server = new SMTPServer({
    key: cert.key,
    cert: cert.cert,
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    disableReverseLookup: true,
    onConnect: (_session, cb) => cb(),
    onAuth: (auth, _session, cb) => {
      auths.push({ username: auth.username ?? '', method: auth.method })
      if (auth.username === USER.username && auth.password === USER.password)
        cb(null, { user: auth.username })
      else cb(new Error('Invalid username or password'))
    },
    onMailFrom: (address, _session, cb) => cb(),
    onRcptTo: (address, _session, cb) => {
      if (address.address.endsWith('@refused.test')) {
        const e = new Error('No such user') as Error & { responseCode: number }
        e.responseCode = 550
        cb(e)
      } else cb()
    },
    onData: (stream, session, cb) => {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((r) => r.address),
          data: Buffer.concat(chunks).toString('latin1'),
        })
        cb()
      })
    },
    ...options,
  })
  server.on('error', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = ((server as unknown as { server: Server }).server.address() as AddressInfo).port
  const fake: Fake = {
    port,
    received,
    auths,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  servers.push(fake)
  return fake
}

async function host() {
  return {
    nodeBinary: process.execPath,
    hostScript: await builtHost(),
    home: await mkdtemp(join(tmpdir(), 'valet-home-')),
    withoutSeatbelt: !mac,
    testCa: cert.cert,
    operationTimeoutMs: 10_000,
  }
}

const brokerTo = (port: number) => ({
  lookup: (_name: string, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
    cb(null, [{ address: '127.0.0.1', family: 4 }]),
  testing: { allowAddresses: ['127.0.0.1'], route: () => ({ address: '127.0.0.1', port }) },
})

const signIn =
  (user = USER) =>
  async () => ({
    username: SecretValue.fromString(user.username),
    secret: SecretValue.fromString(user.password),
  })

async function backendFor(port: number, protocol: Partial<SmtpProtocol> = {}) {
  return smtpBackend({
    protocol: { endpoint: 'smtp.mail.me.com:587', credential: 'mail', ...protocol },
    host: await host(),
    broker: brokerTo(port),
  })
}

const call = (r = run(), user = USER) => ({
  run: r,
  admit: async () => {},
  signIn: signIn(user),
  signal: r.controller.signal,
})

function message(extra: Record<string, unknown> = {}) {
  const m = checkMailMessage({
    to: ['ann@example.com'],
    cc: ['bob@example.com'],
    bcc: ['carl@example.com'],
    subject: 'Dinner on Friday',
    text: 'Hi both,\n.\nSee you at 7.\n',
    ...extra,
  })
  if (m === null) throw new Error('refused')
  return m
}

const decodeBody = (data: string) =>
  Buffer.from((data.split('\r\n\r\n')[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8')

describe('sending mail through the protocol host', () => {
  it('sends over STARTTLS, From the signed-in account, with Bcc in the envelope only', async () => {
    const server = await fakeSmtp()
    const backend = await backendFor(server.port)
    const r = run(1024 * 1024)
    const connection = await backend.connect(call(r))
    expect(
      await connection.send({ message: message(), messageId: '<m1@smtp.mail.me.com>', date: 0 }),
    ).toEqual({
      accepted: 3,
    })
    await connection.end()
    expect(server.auths).toEqual([{ username: USER.username, method: 'PLAIN' }])
    expect(server.received).toHaveLength(1)
    const [got] = server.received as [Received]
    expect(got.from).toBe(USER.username)
    expect(got.to).toEqual(['ann@example.com', 'bob@example.com', 'carl@example.com'])
    expect(got.data).toMatch(/^From: nick@icloud\.test\r\nTo: ann@example\.com\r\nCc: bob@example\.com\r\n/)
    expect(got.data).not.toContain('carl@example.com')
    expect(got.data).toContain('Message-ID: <m1@smtp.mail.me.com>\r\n')
    // The lone "." line arrives as the text's own line, not the end of the DATA.
    expect(decodeBody(got.data)).toBe('Hi both,\r\n.\r\nSee you at 7.\r\n')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.records).toEqual([expect.objectContaining({ endpoint: 'smtp.mail.me.com:587', kind: 'tunnel' })])
  })

  it('sends over TLS from the first byte on 465', async () => {
    const server = await fakeSmtp({ secure: true })
    const backend = await backendFor(server.port, { endpoint: 'smtp.mail.me.com:465' })
    const connection = await backend.connect(call(run(1024 * 1024)))
    await connection.send({ message: message(), messageId: '<m2@smtp.mail.me.com>', date: 0 })
    await connection.end()
    expect(server.received).toHaveLength(1)
  })

  it('never signs in without TLS: a server that doesn’t offer STARTTLS gets no password', async () => {
    const server = await fakeSmtp({ hideSTARTTLS: true, allowInsecureAuth: true })
    const backend = await backendFor(server.port)
    await expect(backend.connect(call())).rejects.toMatchObject({ errorClass: 'unsupported' })
    expect(server.auths).toEqual([])
  })

  it('reports a refused sign-in as auth-failed, and sends nothing', async () => {
    const server = await fakeSmtp()
    const backend = await backendFor(server.port)
    await expect(backend.connect(call(run(), { ...USER, password: 'wrong' }))).rejects.toMatchObject({
      stage: 'credential',
      errorClass: 'auth-failed',
    })
    expect(server.received).toEqual([])
  })

  it('sends nothing at all when the server refuses any recipient', async () => {
    const server = await fakeSmtp()
    const backend = await backendFor(server.port)
    const connection = await backend.connect(call(run(1024 * 1024)))
    await expect(
      connection.send({
        message: message({ cc: ['nobody@refused.test'] }),
        messageId: '<m3@smtp.mail.me.com>',
        date: 0,
      }),
    ).rejects.toBeInstanceOf(Error)
    await connection.end()
    expect(server.received).toEqual([])
  })

  it('refuses a username that isn’t a plain address, so From can’t carry a header', async () => {
    const server = await fakeSmtp()
    const backend = await backendFor(server.port)
    await expect(
      backend.connect(
        call(run(), { username: 'nick@icloud.test\r\nBcc: eve@evil.test', password: USER.password }),
      ),
    ).rejects.toMatchObject({ errorClass: 'auth-failed' })
    expect(server.auths).toEqual([])
  })
})

describe('the host on its own, as if the runtime’s checks were skipped', () => {
  async function session(server: Fake, protocol: Partial<SmtpProtocol> = {}) {
    const r = run(1024 * 1024)
    return ImapHostSession.start({
      host: await host(),
      protocol: 'smtp',
      recipients: protocol.recipients ?? null,
      endpoint: 'smtp.mail.me.com:587',
      purpose: 'irreversible',
      folders: null,
      openTunnels: (await backendBroker(server.port)).tunnels(r, { plainTcp: ['smtp.mail.me.com:587'] }),
      signIn: signIn(),
      signal: r.controller.signal,
    })
  }

  async function backendBroker(port: number) {
    const { EgressBroker } = await import('@valet/egress')
    return new EgressBroker({ egress: [], endpoints: ['smtp.mail.me.com:587'] }, brokerTo(port))
  }

  it('refuses headers, smuggled recipients and recipients off the list, and a second send', async () => {
    const server = await fakeSmtp()
    const s = await session(server, { recipients: ['@example.com'] })
    const base = { to: ['ann@example.com'], subject: 'Hi', text: 'Hello' }
    for (const bad of [
      { ...base, subject: 'Hi\r\nBcc: eve@evil.test' },
      { ...base, to: ['ann@example.com>\r\nRCPT TO:<eve@evil.test'] },
      { ...base, to: ['ann@example.com, eve@evil.test'] },
      { ...base, to: ['eve@evil.test'] },
      { ...base, bcc: ['eve@evil.test'] },
      { ...base, headers: { From: 'ceo@example.com' } },
      { ...base, from: 'ceo@example.com' },
    ])
      await expect(
        s.sendMail({ message: bad, messageId: '<x@smtp.mail.me.com>', date: 0 }),
      ).rejects.toBeInstanceOf(Error)
    await expect(
      s.sendMail({ message: base, messageId: '<x@y>\r\nBcc: eve@evil.test', date: 0 }),
    ).rejects.toBeInstanceOf(Error)
    expect(server.received).toEqual([])
    await s.sendMail({ message: base, messageId: '<ok@smtp.mail.me.com>', date: 0 })
    await expect(
      s.sendMail({ message: base, messageId: '<again@smtp.mail.me.com>', date: 0 }),
    ).rejects.toBeInstanceOf(Error)
    await s.end()
    expect(server.received).toHaveLength(1)
    expect(server.received[0]?.to).toEqual(['ann@example.com'])
  })

  it('refuses IMAP operations on an SMTP host', async () => {
    const server = await fakeSmtp()
    const s = await session(server)
    await expect(s.operation('listFolders', [])).rejects.toBeInstanceOf(Error)
    await expect(s.signInMail({} as never)).rejects.toBeInstanceOf(Error)
    await s.end()
  })
})

describe('a hostile server', () => {
  /** A raw TCP server that speaks just enough SMTP, then misbehaves at STARTTLS. */
  async function injecting(): Promise<{ port: number; sawAuth: () => boolean }> {
    let auth = false
    const server = createTcpServer((socket) => {
      socket.write('220 smtp.mail.me.com ESMTP\r\n')
      socket.on('data', (chunk) => {
        const text = chunk.toString('latin1')
        if (/^AUTH/im.test(text)) auth = true
        if (/^EHLO/i.test(text)) socket.write('250-smtp.mail.me.com\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n')
        // The STARTTLS injection attack: a reply smuggled in after "go ahead", before TLS.
        else if (/^STARTTLS/i.test(text)) socket.write('220 Go ahead\r\n250 AUTH PLAIN\r\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) })
    return { port: (server.address() as AddressInfo).port, sawAuth: () => auth }
  }

  it('refuses what a server smuggles in after STARTTLS, and never sends the password', async () => {
    const server = await injecting()
    const backend = await backendFor(server.port)
    await expect(backend.connect(call())).rejects.toBeInstanceOf(Error)
    expect(server.sawAuth()).toBe(false)
  })
})
