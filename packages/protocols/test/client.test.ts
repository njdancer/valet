// The client against a server that misbehaves: it fails closed, never hangs, and never reads more
// than its limits allow.

import { DEFAULT_USER, type FakeImap, type HostileContext } from '@valet/fake-imap'
import { afterEach, describe, expect, it } from 'vitest'
import { ImapError } from '../src/imap/client'
import { DEFAULT_WIRE_LIMITS } from '../src/imap/wire'
import { client, fake, signedIn } from './helpers'

let server: FakeImap | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    if (error instanceof ImapError) return error.failure
    throw error
  }
  throw new Error('did not fail')
}

const login = (c: Awaited<ReturnType<typeof client>>, password = DEFAULT_USER.password) =>
  c.login(Buffer.from(DEFAULT_USER.username), Buffer.from(password))

/** A server that answers `verb` with `reply(tag)` and everything else normally. */
const answering = (verb: string, reply: (tag: string, c: HostileContext) => string | Buffer) => ({
  hostile: (c: HostileContext) => (c.command.verb === verb ? reply(c.command.tag, c) : null),
})

describe('signing in', () => {
  it('signs in and reads the capabilities the server has after', async () => {
    server = await fake()
    const c = await client(server, 'read')
    expect(c.has('MOVE')).toBe(false)
    await login(c)
    expect(c.has('MOVE')).toBe(true)
    expect(server.logins).toEqual([{ username: DEFAULT_USER.username, ok: true }])
    await c.logout()
    expect(server.commands.at(-1)?.verb).toBe('LOGOUT')
  })

  it('reports a wrong password as auth, with the server’s code', async () => {
    server = await fake()
    const c = await client(server, 'read')
    const error = await login(c, 'wrong').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImapError)
    expect(error).toMatchObject({ failure: 'auth', code: 'AUTHENTICATIONFAILED' })
  })

  it('never sends a password when the server says LOGINDISABLED', async () => {
    server = await fake({ greeting: '* OK [CAPABILITY IMAP4rev1 LOGINDISABLED] hi' })
    const c = await client(server, 'read')
    expect(await failure(login(c))).toBe('unsupported')
    expect(server.commands.map((x) => x.verb)).not.toContain('LOGIN')
  })

  it('waits for the server’s go-ahead before a literal when it lacks LITERAL+', async () => {
    const user = { username: 'nick@icloud.test', password: 'pässwörd\r\n' }
    server = await fake({ users: [user], capabilities: { before: ['IMAP4rev1'], after: ['IMAP4rev1'] } })
    const c = await client(server, 'read')
    await c.login(Buffer.from(user.username), Buffer.from(user.password))
    expect(server.commands.find((x) => x.verb === 'LOGIN')?.line).toMatch(/\{12\}$/)
    expect(server.logins.at(-1)?.ok).toBe(true)
  })

  it('refuses a PREAUTH or BYE greeting', async () => {
    server = await fake({ greeting: '* PREAUTH welcome' })
    expect(await failure(client(server, 'read'))).toBe('malformed')
    await server.close()
    server = await fake({ greeting: '* BYE go away' })
    expect(await failure(client(server, 'read'))).toBe('closed')
  })

  it('gives up on a server that never greets', async () => {
    server = await fake({ greeting: '' })
    expect(await failure(client(server, 'read', { commandTimeoutMs: 200 }))).toMatch(/timeout|malformed/)
  })
})

describe('a hostile server', () => {
  it('fails on a tagged reply to some other command, and stays failed', async () => {
    server = await fake(answering('NOOP', () => 'V999 OK sure\r\n'))
    const { client: c } = await signedIn(server, 'read')
    expect(await failure(c.run({ verb: 'NOOP', args: [] }))).toBe('malformed')
    expect(await failure(c.run({ verb: 'CAPABILITY', args: [] }))).toBe('malformed')
  })

  it('fails on a go-ahead nobody asked for', async () => {
    server = await fake(answering('NOOP', () => '+ send it\r\n'))
    const { client: c } = await signedIn(server, 'read')
    expect(await failure(c.run({ verb: 'NOOP', args: [] }))).toBe('malformed')
  })

  it('fails on a reply it cannot parse', async () => {
    server = await fake(answering('NOOP', (tag) => `* LIST (\\x "/\r\n${tag} OK\r\n`))
    const { client: c } = await signedIn(server, 'read')
    expect(await failure(c.run({ verb: 'NOOP', args: [] }))).toBe('malformed')
  })

  it('times out a command the server never answers, and closes the connection', async () => {
    server = await fake(answering('NOOP', () => ''))
    const c = await client(server, 'read', { commandTimeoutMs: 300 })
    await login(c)
    expect(await failure(c.run({ verb: 'NOOP', args: [] }))).toBe('timeout')
    await new Promise((r) => setTimeout(r, 50))
    expect(server.open()).toBe(0)
  })

  it('stops reading a flood past the connection’s byte limit', async () => {
    const line = `* OK ${'x'.repeat(1000)}\r\n`
    server = await fake(answering('NOOP', () => line.repeat(200)))
    const c = await client(server, 'read', { maxBytesIn: 64 * 1024 })
    await login(c)
    expect(await failure(c.run({ verb: 'NOOP', args: [] }))).toBe('too-large')
  })

  it('refuses a literal past its limit before it arrives', async () => {
    server = await fake(answering('NOOP', () => '* 1 FETCH (BODY[] {999999999}\r\n'))
    const c = await client(server, 'read', { limits: { ...DEFAULT_WIRE_LIMITS, maxLiteralBytes: 1024 } })
    await login(c)
    expect(await failure(c.run({ verb: 'NOOP', args: [] }))).toBe('too-large')
  })

  it('fails when the server drops the connection mid-command', async () => {
    server = await fake(answering('NOOP', () => '* BYE bye\r\n'))
    const { client: c } = await signedIn(server, 'read')
    const pending = c.run({ verb: 'NOOP', args: [] })
    await server.close()
    server = null
    expect(await failure(pending)).toBe('closed')
  })

  it('keeps NO and BAD apart, with a code only when it is a plain name', async () => {
    server = await fake({
      hostile: (c) =>
        c.command.verb === 'NOOP'
          ? `${c.command.tag} NO [TRY\\CREATE] nope\r\n`
          : c.command.verb === 'LIST'
            ? `${c.command.tag} BAD [CLIENTBUG] bad\r\n`
            : null,
    })
    const { client: c } = await signedIn(server, 'read')
    expect(await c.run({ verb: 'NOOP', args: [] }).catch((e: unknown) => e)).toMatchObject({ failure: 'no', code: null })
    expect(await c.run({ verb: 'LIST', args: [{ string: '' }, { atom: '*' }] }).catch((e: unknown) => e)).toMatchObject({
      failure: 'bad',
      code: 'CLIENTBUG',
    })
  })

  it('refuses, before sending, what the session’s purpose does not allow', async () => {
    server = await fake()
    const { client: c } = await signedIn(server, 'read')
    const before = server.commands.length
    expect(await failure(c.run({ verb: 'SELECT', args: [{ mailbox: 'INBOX' }] }))).toBe('not-allowed')
    expect(await failure(c.run({ verb: 'DELETE', args: [{ mailbox: 'INBOX' }] }))).toBe('needs-irreversible')
    expect(await failure(c.run({ verb: 'LIST', args: [{ atom: 'a b' }] }))).toBe('invalid')
    expect(server.commands.length).toBe(before)
  })

  it('re-opens a folder to write after looking, but not the other way', async () => {
    server = await fake()
    const { client: c } = await signedIn(server, 'write')
    await c.open('INBOX', true)
    await c.open('INBOX', true)
    await c.open('INBOX', false)
    await c.open('INBOX', true)
    expect(server.commands.filter((x) => x.verb === 'EXAMINE' || x.verb === 'SELECT').map((x) => x.verb)).toEqual([
      'EXAMINE',
      'SELECT',
    ])
    expect(await failure(c.open('Nowhere', true))).toBe('no')
    expect(c.selected).toBeNull()
  })
})
