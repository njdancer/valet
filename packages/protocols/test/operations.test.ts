// What ctx.imap does, against the fake server: each operation's result, the commands it sends, and
// every argument a hostile tool could pass refused before anything reaches the wire.

import type { FakeImap } from '@valet/fake-imap'
import { afterEach, describe, expect, it } from 'vitest'
import { ImapError } from '../src/imap/client'
import { imapDate, LIMITS, searchTerms } from '../src/imap/operations'
import { fake, MESSAGE, MULTIPART, signedIn } from './helpers'

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

const sent = (s: FakeImap) => s.commands.map((c) => c.verb)

describe('reading', () => {
  it('lists folders with their special use, and only the allowed ones', async () => {
    server = await fake({ specialUse: { 'Sent Messages': '\\Sent' }, mailboxes: { Entwürfe: [] } })
    const { ops } = await signedIn(server, 'read')
    const all = await ops.listFolders()
    expect(all.map((f) => f.path).sort()).toEqual(['Entwürfe', 'INBOX', 'Sent Messages'])
    expect(all.find((f) => f.path === 'Sent Messages')).toMatchObject({ specialUse: '\\Sent', delimiter: '/' })
    const { ops: some } = await signedIn(server, 'read', ['inbox', 'Entwürfe'])
    expect((await some.listFolders()).map((f) => f.path).sort()).toEqual(['Entwürfe', 'INBOX'])
  })

  it('reads a folder’s status', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'read')
    expect(await ops.status('inbox')).toMatchObject({ folder: 'INBOX', messages: 2, unseen: 1, uidNext: 3 })
    expect(await failure(ops.status('Nowhere'))).toBe('no')
  })

  it('searches newest first with EXAMINE, never SELECT', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'read')
    expect(await ops.search('INBOX', undefined, undefined)).toMatchObject({ total: 2, uids: [2, 1] })
    expect(await ops.search('INBOX', { seen: false }, { limit: 1 })).toMatchObject({ total: 1, uids: [1] })
    expect(await ops.search('INBOX', { or: [{ from: 'shop.test' }, { from: 'cafe@' }] }, null)).toMatchObject({
      uids: [2, 1],
    })
    expect(await ops.search('INBOX', { not: { from: 'shop.test' } }, undefined)).toMatchObject({ uids: [2] })
    expect(await ops.search('INBOX', { subject: 'Café' }, undefined)).toMatchObject({ total: 0 })
    expect(server.commands.find((c) => c.line.includes('CHARSET UTF-8'))).toBeDefined()
    expect(sent(server)).toContain('EXAMINE')
    expect(sent(server)).not.toContain('SELECT')
  })

  it('fetches envelopes without marking anything read', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'read')
    const { messages } = await ops.fetch('INBOX', [1, 2, 99])
    expect(messages.map((m) => m.uid)).toEqual([2, 1])
    expect(messages[1]).toMatchObject({ flags: [], envelope: { subject: 'Your order', from: [{ address: 'orders@shop.test' }] } })
    expect(server.mailboxes.get('INBOX')?.messages[0]?.flags.has('\\Seen')).toBe(false)
  })

  it('reads a message’s text and HTML, decoded, and lists its attachments', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'read')
    const m = await ops.message('INBOX', 2, undefined)
    expect(m.text).toBe('Café menu today')
    expect(m.html).toBe('<p>Café menu today</p>')
    expect(m.attachments).toEqual([{ part: '2', type: 'application/pdf', filename: 'menu.pdf', size: expect.any(Number) }])
    expect(m.envelope?.subject).toBe('Menu 🍕')
    const short = await ops.message('INBOX', 1, { maxTextChars: 6 })
    expect(short).toMatchObject({ text: 'Thanks', truncated: true })
    expect(await failure(ops.message('INBOX', 42, undefined))).toBe('no')
    for (const line of server.commands.filter((c) => c.verb === 'UID FETCH').map((c) => c.line))
      expect(line).not.toMatch(/BODY\[/)
    expect(server.mailboxes.get('INBOX')?.messages[0]?.flags.has('\\Seen')).toBe(false)
  })

  it('reads an attachment’s bytes, capped', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'read')
    const got = await ops.attachment('INBOX', 2, '2', undefined)
    expect(Buffer.from(got.base64, 'base64').toString()).toBe('%PDF-1.4 fake')
    expect(got).toMatchObject({ type: 'application/pdf', filename: 'menu.pdf', truncated: false })
    const capped = await ops.attachment('INBOX', 2, '2', { maxBytes: 4 })
    expect(capped).toMatchObject({ base64: Buffer.from('%PDF').toString('base64'), truncated: true })
    expect(await failure(ops.attachment('INBOX', 2, '9', undefined))).toBe('no')
  })
})

describe('changing mail', () => {
  it('sets flags only in a session that may write', async () => {
    server = await fake()
    const { ops: reader } = await signedIn(server, 'read')
    expect(await failure(reader.setFlags('INBOX', [1], { add: ['\\Flagged'] }))).toBe('not-allowed')
    const { ops } = await signedIn(server, 'write')
    expect(await ops.setFlags('INBOX', [1], { add: ['\\FLAGGED', 'shopping'], remove: ['\\seen'] })).toEqual({
      folder: 'INBOX',
      uids: 1,
    })
    expect([...(server.mailboxes.get('INBOX')?.messages[0]?.flags ?? [])].sort()).toEqual(['\\Flagged', 'shopping'])
    expect(await failure(ops.setFlags('INBOX', [1], { add: ['\\Deleted'] }))).toBe('needs-irreversible')
    expect(server.mailboxes.get('INBOX')?.messages[0]?.flags.has('\\Deleted')).toBe(false)
  })

  it('copies and moves between allowed folders', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'write', ['INBOX', 'Archive'])
    expect(await ops.run('copy', ['INBOX', [1], 'Archive'])).toMatchObject({ uids: 1 })
    expect(await ops.run('move', ['INBOX', [2], 'Archive'])).toMatchObject({ to: 'Archive' })
    expect(server.mailboxes.get('Archive')?.messages).toHaveLength(2)
    expect(server.mailboxes.get('INBOX')?.messages).toHaveLength(1)
    expect(await failure(ops.run('copy', ['INBOX', [1], 'Trash']))).toBe('not-allowed')
  })

  it('moves only when the server has MOVE', async () => {
    server = await fake({ capabilities: { after: ['IMAP4rev1', 'UIDPLUS', 'LITERAL+'] } })
    const { ops } = await signedIn(server, 'write')
    expect(await failure(ops.run('move', ['INBOX', [1], 'Archive']))).toBe('unsupported')
  })

  it('appends a message, as a literal', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'write')
    expect(await ops.append('Archive', MESSAGE.replace(/\r\n/g, '\n'), { flags: ['\\Seen'] })).toEqual({
      folder: 'Archive',
      bytes: Buffer.byteLength(MESSAGE),
    })
    expect(server.mailboxes.get('Archive')?.messages[0]?.flags.has('\\Seen')).toBe(true)
    expect(await failure(ops.append('Archive', 'no headers here', undefined))).toBe('invalid')
    expect(await failure(ops.append('Archive', 'X: y\0', undefined))).toBe('invalid')
    expect(await failure(ops.append('Archive', `X: ${'y'.repeat(LIMITS.appendBytesMax)}`, undefined))).toBe('invalid')
    expect(await failure(ops.append('Archive', MESSAGE, { flags: ['\\Deleted'] }))).toBe('needs-irreversible')
    const { ops: reader } = await signedIn(server, 'read')
    expect(await failure(reader.append('Archive', MESSAGE, undefined))).toBe('not-allowed')
  })

  it('creates and deletes folders, never INBOX', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'write')
    expect(await ops.createFolder('Receipts')).toEqual({ folder: 'Receipts' })
    expect(await failure(ops.createFolder('inbox'))).toBe('invalid')
    expect(await failure(ops.deleteFolder('Receipts'))).toBe('needs-irreversible')
    const { ops: all } = await signedIn(server, 'irreversible')
    expect(await all.deleteFolder('Receipts')).toEqual({ folder: 'Receipts' })
    expect(await failure(all.deleteFolder('INBOX'))).toBe('invalid')
    expect(server.mailboxes.has('Receipts')).toBe(false)
  })

  it('expunges just the named messages, with UID EXPUNGE', async () => {
    server = await fake({
      mailboxes: { INBOX: [{ raw: MESSAGE, flags: ['\\Deleted'] }, { raw: MULTIPART, flags: ['\\Deleted'] }] },
    })
    const { ops } = await signedIn(server, 'irreversible')
    expect(await ops.expunge('INBOX', [2])).toEqual({ folder: 'INBOX', removed: 1 })
    expect(server.mailboxes.get('INBOX')?.messages.map((m) => m.uid)).toEqual([1])
    expect(sent(server)).not.toContain('EXPUNGE')
    expect(sent(server)).not.toContain('CLOSE')
  })

  it('expunges only when the server has UIDPLUS', async () => {
    server = await fake({ capabilities: { after: ['IMAP4rev1', 'MOVE'] } })
    const { ops } = await signedIn(server, 'irreversible')
    expect(await failure(ops.expunge('INBOX', [1]))).toBe('unsupported')
  })
})

describe('arguments', () => {
  it.each([
    ['a folder that is not a string', () => ['status', [42]]],
    ['an empty folder', () => ['status', ['']]],
    ['a folder with a wildcard', () => ['status', ['IN*']]],
    ['a folder with a line break', () => ['status', ['INBOX\r\nA1 DELETE x']]],
    ['a long folder', () => ['status', ['x'.repeat(201)]]],
    ['no UIDs', () => ['fetch', ['INBOX', []]]],
    ['a zero UID', () => ['fetch', ['INBOX', [0]]]],
    ['a fractional UID', () => ['fetch', ['INBOX', [1.5]]]],
    ['a UID past 2^32', () => ['fetch', ['INBOX', [2 ** 32]]]],
    ['UIDs as a string', () => ['fetch', ['INBOX', '1:*']]],
    ['too many UIDs to fetch', () => ['fetch', ['INBOX', Array.from({ length: 101 }, (_, i) => i + 1)]]],
    ['a part with a section keyword', () => ['attachment', ['INBOX', 1, '1.HEADER', undefined]]],
    ['a part with brackets', () => ['attachment', ['INBOX', 1, '1] BODY[', undefined]]],
    ['a part of zero', () => ['attachment', ['INBOX', 1, '0', undefined]]],
    ['a huge maxBytes', () => ['attachment', ['INBOX', 1, '1', { maxBytes: 10 ** 9 }]]],
    ['options that are a list', () => ['message', ['INBOX', 1, []]]],
    ['a search limit of zero', () => ['search', ['INBOX', {}, { limit: 0 }]]],
    ['a search limit past the most', () => ['search', ['INBOX', {}, { limit: 501 }]]],
    ['an unknown search key', () => ['search', ['INBOX', { raw: 'ALL' }, undefined]]],
    ['a search text with a line break', () => ['search', ['INBOX', { from: 'a\r\nb' }, undefined]]],
    ['an empty search text', () => ['search', ['INBOX', { subject: '' }, undefined]]],
    ['a bad date', () => ['search', ['INBOX', { since: '2026-02-30' }, undefined]]],
    ['a flag key that is not a boolean', () => ['search', ['INBOX', { seen: 'yes' }, undefined]]],
    ['a negative size', () => ['search', ['INBOX', { larger: -1 }, undefined]]],
    ['a bad header name', () => ['search', ['INBOX', { header: { name: 'X Y', value: 'z' } }, undefined]]],
    ['an empty NOT', () => ['search', ['INBOX', { not: {} }, undefined]]],
    ['an OR with one side', () => ['search', ['INBOX', { or: [{ seen: true }] }, undefined]]],
    ['an unknown flag', () => ['setFlags', ['INBOX', [1], { add: ['\\Recent'] }]]],
    ['a keyword with a space', () => ['setFlags', ['INBOX', [1], { add: ['a b'] }]]],
    ['no flag change', () => ['setFlags', ['INBOX', [1], {}]]],
    ['a message that is not a string', () => ['append', ['INBOX', { raw: 'x' }, undefined]]],
  ] as [string, () => [string, unknown[]]][])('refuses %s before sending it', async (_name, make) => {
    server = await fake()
    const { ops } = await signedIn(server, 'irreversible')
    const before = server.commands.length
    const [operation, args] = make()
    expect(await failure(ops.run(operation as never, args))).toBe('invalid')
    expect(server.commands.slice(before).map((c) => c.verb)).toEqual([])
  })

  it('keeps tools to the manifest’s folders, before asking the server', async () => {
    server = await fake()
    const { ops } = await signedIn(server, 'irreversible', ['INBOX'])
    const before = server.commands.length
    for (const call of [
      () => ops.status('Archive'),
      () => ops.search('Archive', {}, undefined),
      () => ops.run('copy', ['INBOX', [1], 'Archive']),
      () => ops.createFolder('Archive2'),
      () => ops.deleteFolder('Archive'),
      () => ops.append('Archive', MESSAGE, undefined),
    ])
      expect(await failure(call())).toBe('not-allowed')
    expect(server.commands.length).toBe(before)
  })
})

describe('search criteria', () => {
  it('writes dates the IMAP way', () => {
    expect(imapDate('2026-11-07')).toBe('7-Nov-2026')
    expect(() => imapDate('2026-13-01')).toThrow(ImapError)
    expect(() => imapDate('7 Nov 2026')).toThrow(ImapError)
  })

  it('bounds nesting and the number of terms', () => {
    const nested = { not: { not: { not: { seen: true } } } }
    expect(searchTerms(nested)).toHaveLength(2)
    expect(() => searchTerms({ not: nested })).toThrow(ImapError)
    const many = { ...Object.fromEntries(['from', 'to', 'cc', 'subject', 'body', 'text'].map((k) => [k, 'x'])), seen: true }
    expect(() => searchTerms({ ...many, or: [many, many] })).toThrow(ImapError)
    expect(searchTerms({ uids: [3, 1, 2], header: { name: 'List-Id', value: 'x' }, larger: 10 })).toEqual([
      { atom: 'UID' },
      { uids: [3, 1, 2] },
      { atom: 'HEADER' },
      { string: 'List-Id' },
      { string: 'x' },
      { atom: 'LARGER' },
      { number: 10 },
    ])
  })

  it('ignores inherited and undefined keys, and refuses a prototype key', () => {
    expect(searchTerms({ from: undefined })).toEqual([])
    expect(() => searchTerms(JSON.parse('{"__proto__": {"from": "x"}}'))).toThrow(ImapError)
  })
})
