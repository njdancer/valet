// The protocol host end to end: the bundled host script in its own Node process (under Seatbelt on
// macOS), reaching the fake server only through the egress broker's tunnel, signed in just in
// time, and refusing what its purpose doesn't allow at every layer.

import type { FakeImap } from '@valet/fake-imap'
import { DEFAULT_USER } from '@valet/fake-imap'
import { ValetError } from '@valet/core'
import { afterEach, describe, expect, it } from 'vitest'
import { imapBackend } from '../src/imap-backend'
import { ImapHostSession } from '../src/host-session'
import { brokerTo, fake, hostOptions, mac, run, signIn } from './helpers'

let server: FakeImap | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const endpoint = 'imap.mail.me.com:993'

async function backend(folders?: string[]) {
  server = await fake()
  return imapBackend({
    protocol: { endpoint, credential: 'mail', ...(folders === undefined ? {} : { folders }) },
    host: await hostOptions(server),
    broker: brokerTo(server),
  })
}

const call = (purpose: 'read' | 'write' | 'irreversible', r = run()) => ({
  purpose,
  run: r,
  admit: async () => {},
  signIn: signIn(),
  signal: r.controller.signal,
})

describe('the protocol host', () => {
  it('reads mail through the tunnel, signed in, without marking it read', async () => {
    const b = await backend()
    const r = run()
    const connection = await b.connect(call('read', r))
    const found = (await connection.operation('search', ['INBOX', { seen: false }])) as { uids: number[] }
    expect(found.uids).toEqual([1])
    const message = (await connection.operation('message', ['INBOX', 1])) as { text: string }
    expect(message.text).toContain('Thanks for your order')
    await connection.end()
    const box = server?.mailboxes.get('INBOX')
    expect([...(box?.messages[0]?.flags ?? [])]).toEqual([])
    const verbs = server?.commands.map((c) => c.verb)
    expect(verbs).toContain('EXAMINE')
    expect(verbs).not.toContain('SELECT')
    expect(server?.commands.every((c) => !/BODY\[/.test(c.line))).toBe(true)
    expect(server?.servernames).toEqual(['imap.mail.me.com'])
    expect(server?.logins).toEqual([{ username: DEFAULT_USER.username, ok: true }])
    // The tunnel's connection is recorded with its bytes, never their content.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.records).toEqual([expect.objectContaining({ endpoint, kind: 'tunnel', errorClass: null })])
  })

  it('refuses a write from a read session in the host itself', async () => {
    const b = await backend()
    const connection = await b.connect(call('read'))
    await expect(connection.operation('setFlags', ['INBOX', [1], { add: ['\\Flagged'] }])).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    await expect(connection.operation('move', ['INBOX', [1], 'Archive'])).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    await connection.end()
    expect(server?.commands.some((c) => /STORE|MOVE|SELECT/.test(c.verb))).toBe(false)
  })

  it('writes from a write session, and keeps \\Deleted for an irreversible one', async () => {
    const b = await backend()
    const writer = await b.connect(call('write'))
    await writer.operation('setFlags', ['INBOX', [1], { add: ['\\Flagged'] }])
    await expect(writer.operation('setFlags', ['INBOX', [1], { add: ['\\Deleted'] }])).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    await expect(writer.operation('expunge', ['INBOX', [1]])).rejects.toMatchObject({ errorClass: 'command-not-allowed' })
    await writer.end()
    expect([...(server?.mailboxes.get('INBOX')?.messages[0]?.flags ?? [])]).toEqual(['\\Flagged'])

    const remover = await b.connect(call('irreversible'))
    await remover.operation('setFlags', ['INBOX', [1], { add: ['\\Deleted'] }])
    expect(await remover.operation('expunge', ['INBOX', [1]])).toEqual({ folder: 'INBOX', removed: 1 })
    await remover.end()
    expect(server?.mailboxes.get('INBOX')?.messages.map((m) => m.uid)).toEqual([2])
  })

  it('keeps to the manifest’s folders', async () => {
    const b = await backend(['INBOX'])
    const connection = await b.connect(call('write'))
    expect(((await connection.operation('listFolders', [])) as { path: string }[]).map((f) => f.path)).toEqual(['INBOX'])
    await expect(connection.operation('copy', ['INBOX', [1], 'Archive'])).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    await expect(connection.operation('status', ['Archive'])).rejects.toMatchObject({ errorClass: 'command-not-allowed' })
    await connection.end()
    expect(server?.commands.some((c) => c.line.includes('Archive'))).toBe(false)
  })

  it('reports a refused login as auth-failed', async () => {
    const b = await backend()
    const r = run()
    await expect(
      b.connect({ ...call('read', r), signIn: signIn({ username: DEFAULT_USER.username, password: 'wrong' }) }),
    ).rejects.toMatchObject({ stage: 'credential', errorClass: 'auth-failed' })
  })

  it('stops when the call ends', async () => {
    const b = await backend()
    const r = run()
    const connection = await b.connect(call('read', r))
    r.controller.abort()
    await expect(connection.operation('listFolders', [])).rejects.toBeInstanceOf(ValetError)
  })

  it('reaches nothing but its tunnel', async () => {
    // The broker refuses any endpoint but the declared one before the host ever starts.
    server = await fake()
    const r = run()
    await expect(
      ImapHostSession.start({
        host: await hostOptions(server),
        endpoint: 'imap.evil.test:993',
        purpose: 'read',
        folders: null,
        openTunnels: imapBackendTunnels(),
        signIn: signIn(),
        signal: r.controller.signal,
      }),
    ).rejects.toBeInstanceOf(ValetError)
    expect(server.logins).toEqual([])
  })

  it.runIf(mac)('runs under the Seatbelt profile on macOS', async () => {
    server = await fake()
    const profiles: string[] = []
    const b = imapBackend({
      protocol: { endpoint, credential: 'mail' },
      host: await hostOptions(server, { onProfile: (p) => profiles.push(p) }),
      broker: brokerTo(server),
    })
    const connection = await b.connect(call('read'))
    expect(((await connection.operation('listFolders', [])) as unknown[]).length).toBeGreaterThan(0)
    await connection.end()
    expect(profiles[0]).toContain('(deny default)')
  })
})

function imapBackendTunnels() {
  // A tunnel set that has only the real endpoint: asking for another is refused.
  return async (endpoints: readonly string[]) => {
    if (endpoints.some((e) => e !== endpoint)) throw new ValetError('egress', 'host-not-allowed')
    return { ports: new Map<string, number>(), close: () => {} }
  }
}
