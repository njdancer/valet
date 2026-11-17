// The fake IMAP server itself, spoken to by hand over plain TCP: the commands Valet never sends
// (CLOSE, plain EXPUNGE, RFC822) behave as a real server's would, so tests can show Valet avoids them.

import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_USER, type FakeImap, parseMime, startFakeImap } from '../src/index'

let server: FakeImap | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const MESSAGE = 'From: a@b.test\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nhello\r\n'

/** Sends one command and resolves with everything up to its tagged reply. */
async function session(port: number) {
  const socket: Socket = connect({ host: '127.0.0.1', port })
  let buffer = ''
  socket.on('data', (d) => {
    buffer += d.toString('latin1')
  })
  const until = async (pattern: RegExp) => {
    for (let i = 0; i < 200 && !pattern.test(buffer); i++) await new Promise((r) => setTimeout(r, 10))
    const out = buffer
    buffer = ''
    return out
  }
  await until(/\* OK/)
  let n = 0
  return {
    send: async (command: string) => {
      const tag = `T${++n}`
      socket.write(`${tag} ${command}\r\n`)
      return until(new RegExp(`${tag} (OK|NO|BAD)`))
    },
    end: () => socket.destroy(),
  }
}

describe('the fake IMAP server', () => {
  it('signs in, and refuses anything before it', async () => {
    server = await startFakeImap({ plain: true })
    expect(server.cert).toBeNull()
    const s = await session(server.port)
    expect(await s.send('LIST "" *')).toMatch(/T1 BAD/)
    expect(await s.send('LOGIN wrong wrong')).toMatch(/T2 NO \[AUTHENTICATIONFAILED\]/)
    expect(await s.send(`LOGIN ${DEFAULT_USER.username} ${DEFAULT_USER.password}`)).toMatch(/T3 OK/)
    expect(await s.send('NOOP')).toMatch(/T4 OK/)
    expect(await s.send('UID FETCH 1 FLAGS')).toMatch(/T5 BAD No mailbox selected/)
    expect(await s.send('LOGOUT')).toMatch(/\* BYE/)
    s.end()
    expect(server.logins.map((l) => l.ok)).toEqual([false, true])
  })

  it('marks a message seen on a plain BODY[] fetch, and expunges on CLOSE', async () => {
    server = await startFakeImap({
      plain: true,
      mailboxes: { INBOX: [{ raw: MESSAGE, flags: ['\\Deleted'] }, { raw: MESSAGE }] },
    })
    const s = await session(server.port)
    await s.send(`LOGIN ${DEFAULT_USER.username} ${DEFAULT_USER.password}`)
    expect(await s.send('SELECT inbox')).toMatch(/READ-WRITE/)
    expect(await s.send('UID FETCH 2 (RFC822 BODY[TEXT]<0.3>)')).toMatch(
      /RFC822 \{\d+\}[\s\S]*BODY\[TEXT\]<0> \{3\}\r\nhel/,
    )
    expect(server.mailboxes.get('INBOX')?.messages[1]?.flags.has('\\Seen')).toBe(true)
    expect(await s.send('UID FETCH 1 (X-UNKNOWN)')).toMatch(/BAD Unknown fetch item/)
    expect(await s.send('UID SEARCH ON 1-Jan-2000 SMALLER 10 TEXT x BODY y SENTBEFORE 1-Jan-2000')).toMatch(
      /\* SEARCH\r\n/,
    )
    expect(await s.send('UID SEARCH BOGUS')).toMatch(/BAD/)
    expect(await s.send('UID STORE 2 FLAGS (\\Flagged)')).toMatch(/OK/)
    expect([...(server.mailboxes.get('INBOX')?.messages[1]?.flags ?? [])]).toEqual(['\\Flagged'])
    expect(await s.send('CLOSE')).toMatch(/OK/)
    expect(server.mailboxes.get('INBOX')?.messages.map((m) => m.uid)).toEqual([2])
    s.end()
  })

  it('expunges every \\Deleted message on a plain EXPUNGE, and refuses changes when examined', async () => {
    server = await startFakeImap({
      plain: true,
      mailboxes: { INBOX: [{ raw: MESSAGE, flags: ['\\Deleted'] }], Other: [] },
    })
    const s = await session(server.port)
    await s.send(`LOGIN ${DEFAULT_USER.username} ${DEFAULT_USER.password}`)
    await s.send('EXAMINE INBOX')
    expect(await s.send('UID STORE 1 +FLAGS (\\Seen)')).toMatch(/NO/)
    expect(await s.send('UID MOVE 1 Other')).toMatch(/NO/)
    expect(await s.send('EXPUNGE')).toMatch(/NO/)
    expect(await s.send('UNSELECT')).toMatch(/OK/)
    await s.send('SELECT INBOX')
    expect(await s.send('UID COPY 1 Nowhere')).toMatch(/NO \[TRYCREATE\]/)
    expect(await s.send('EXPUNGE')).toMatch(/\* 1 EXPUNGE/)
    expect(await s.send('XYZZY')).toMatch(/BAD Unknown command/)
    expect(await s.send('STATUS Nowhere (MESSAGES)')).toMatch(/NO/)
    expect(await s.send('SELECT Nowhere')).toMatch(/NO/)
    expect(await s.send('CREATE Other')).toMatch(/NO \[ALREADYEXISTS\]/)
    expect(await s.send('DELETE Nowhere')).toMatch(/NO/)
    expect(await s.send('APPEND Nowhere () {1+}\r\nx')).toMatch(/NO \[TRYCREATE\]/)
    s.end()
  })

  it('delivers mail as the next UID, and parses MIME', () => {
    const mime = parseMime(Buffer.from(MESSAGE))
    expect(mime.body.toString()).toBe('hello\r\n')
  })
})
