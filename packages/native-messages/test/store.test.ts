import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { looksLikeCode } from '../src/codes'
import { DirectMessagesFiles } from '../src/direct-files'
import { MessagesFilesError } from '../src/files'
import { appleDate, attachmentPath, handleKey, MessagesStore, MessagesStoreError } from '../src/store'
import { ADA, BANK, BOB, buildFixture, type FixturePaths, GROUP, PHOTO, SECRET_CHAT } from './fixture'

let dir: string
let paths: FixturePaths
let files: DirectMessagesFiles

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'valet-messages-'))
  paths = buildFixture(dir)
  files = new DirectMessagesFiles(paths)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function store(options: { hidden?: string[]; hideCodes?: boolean } = {}): MessagesStore {
  return new MessagesStore(files, {
    hidden: () => new Set(options.hidden ?? [SECRET_CHAT]),
    hideCodes: () => options.hideCodes ?? true,
  })
}

describe('MessagesStore', () => {
  it('lists conversations newest first, merging SMS and iMessage, with Contacts names', async () => {
    const { chats, nextOffset } = await store().chats()
    expect(nextOffset).toBeNull()
    expect(chats.map((c) => c.id)).toEqual([BANK, GROUP, BOB, ADA])
    const ada = chats.find((c) => c.id === ADA)
    expect(ada).toMatchObject({
      name: 'Ada Example',
      group: false,
      participants: [{ handle: ADA, name: 'Ada Example' }],
      unread: 1,
    })
    expect([...(ada?.services ?? [])].sort()).toEqual(['SMS', 'iMessage'])
    expect(ada?.lastMessage).toMatchObject({ fromMe: false, text: '[2 attachments]' })
    const group = chats.find((c) => c.id === GROUP)
    expect(group).toMatchObject({ name: 'Climbing crew', group: true })
    expect(group?.participants.map((p) => p.name)).toEqual(['Ada Example', null, 'Bob Sample'])
    expect(chats.find((c) => c.id === BOB)?.name).toBe('Bob Sample')
  })

  it('never shows a hidden conversation', async () => {
    const s = store()
    expect((await s.chats()).chats.some((c) => c.id === SECRET_CHAT)).toBe(false)
    await expect(s.conversation(SECRET_CHAT)).rejects.toEqual(new MessagesStoreError('not-found'))
    expect((await s.search({ text: 'surprise' })).messages).toEqual([])
    expect((await s.search({ chatId: SECRET_CHAT })).messages).toEqual([])
    await expect(s.attachment(17, 1)).rejects.toEqual(new MessagesStoreError('not-found'))
    // Shown once the person unhides it.
    const open = store({ hidden: [] })
    expect((await open.search({ text: 'surprise' })).messages.map((m) => m.id)).toEqual([17])
    expect((await open.attachment(17, 1)).data).toEqual(PHOTO)
    // The settings list has every conversation.
    expect((await s.allChats()).map((c) => c.id)).toContain(SECRET_CHAT)
  })

  it('filters conversations by name, number or address', async () => {
    const s = store()
    expect((await s.chats({ text: 'ada' })).chats.map((c) => c.id)).toEqual([ADA])
    expect((await s.chats({ text: 'climbing' })).chats.map((c) => c.id)).toEqual([GROUP])
    expect((await s.chats({ text: '0400 111' })).chats.map((c) => c.id).sort()).toEqual([ADA, GROUP].sort())
    const page = await s.chats({ limit: 2 })
    expect(page.chats).toHaveLength(2)
    expect(page.nextOffset).toBe(2)
    expect((await s.chats({ limit: 2, offset: 2 })).chats.map((c) => c.id)).toEqual([BOB, ADA])
  })

  it('reads a conversation oldest first, with archived text, attachments, reactions and replies', async () => {
    const { chat, messages, earlier, later } = await store().conversation(ADA)
    expect(chat.id).toBe(ADA)
    expect(earlier).toBeNull()
    expect(later).toBeNull()
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3, 4])
    expect(messages[0]).toMatchObject({
      from: { handle: ADA, name: 'Ada Example' },
      text: 'Climbing on Saturday?',
      reactions: [{ fromMe: false, kind: 'emoji', emoji: '🧗' }],
    })
    // The like was taken back.
    expect(messages[1]).toMatchObject({ fromMe: true, from: null, reactions: [] })
    expect(messages[2]).toMatchObject({ text: 'Running late, sorry', service: 'SMS' })
    expect(messages[3]).toMatchObject({
      text: null,
      unread: true,
      attachments: [
        { index: 1, name: 'IMG_0001.png', type: 'image/png' },
        { index: 2, name: 'Audio Message.caf', type: 'audio/x-caf' },
      ],
      reactions: [{ fromMe: true, kind: 'love' }],
    })
    const group = await store().conversation(GROUP)
    expect(group.messages.map((m) => m.id)).toEqual([10, 11, 12, 13, 18])
    expect(group.messages[1]).toMatchObject({ replyTo: 10, from: { name: 'Bob Sample' } })
    expect(group.messages[2]).toMatchObject({ edited: true, fromMe: true })
    expect(group.messages[3]).toMatchObject({ unsent: true, text: null })
  })

  it('pages back and forward through a conversation', async () => {
    const s = store()
    const newest = await s.conversation(ADA, { limit: 2 })
    expect(newest.messages.map((m) => m.id)).toEqual([3, 4])
    expect(newest.earlier).toBe(3)
    expect(newest.later).toBeNull()
    const older = await s.conversation(ADA, { limit: 2, before: 3 })
    expect(older.messages.map((m) => m.id)).toEqual([1, 2])
    expect(older.earlier).toBeNull()
    expect(older.later).toBe(2)
    const forward = await s.conversation(ADA, { limit: 1, after: 2 })
    expect(forward.messages.map((m) => m.id)).toEqual([3])
    expect(forward.later).toBe(3)
    expect((await s.conversation(ADA, { limit: 5, after: 3 })).later).toBeNull()
    // A message from another conversation isn't an anchor here.
    await expect(s.conversation(ADA, { before: 10 })).rejects.toEqual(new MessagesStoreError('not-found'))
    await expect(s.conversation('+61499000000')).rejects.toEqual(new MessagesStoreError('not-found'))
  })

  it('hides one-time codes from agents, and never matches them', async () => {
    const s = store()
    const bank = await s.conversation(BANK)
    expect(bank.messages[0]).toMatchObject({ id: 15, hidden: 'code' })
    expect(bank.messages[0]?.text).not.toContain('482913')
    expect(bank.messages[1]).toMatchObject({ id: 16, hidden: null })
    for (const text of ['482913', 'verification', 'G-123456'])
      expect((await s.search({ text })).messages).toEqual([])
    const all = await s.search({})
    expect(all.messages.map((m) => m.id)).not.toContain(15)
    expect(all.messages.map((m) => m.id)).not.toContain(18)
    // The person can turn the rule off.
    const shown = store({ hideCodes: false })
    expect((await shown.search({ text: '482913' })).messages.map((m) => m.id)).toEqual([15])
    // Valet's own code lookup sees them either way.
    expect(await s.recentFrom(BANK, ['SMS', 'RCS'], Date.parse('2026-11-25T00:00:00Z'))).toEqual([
      'Your statement is ready to view.',
      'Your Example Bank verification code is 482913. Do not share it.',
    ])
    // Only from that handle over those services, since that time, cut to length.
    expect(await s.recentFrom(BANK, ['iMessage'], Date.parse('2026-11-25T00:00:00Z'))).toEqual([])
    expect(await s.recentFrom(BANK, [], Date.parse('2026-11-25T00:00:00Z'))).toEqual([])
    expect(await s.recentFrom(BANK, ['SMS'], Date.parse('2026-11-25T03:00:00.001Z'))).toEqual([
      'Your statement is ready to view.',
    ])
    expect(
      await s.recentFrom(BANK, ['SMS'], Date.parse('2026-11-25T00:00:00Z'), { limit: 1, chars: 4 }),
    ).toEqual(['Your'])
  })

  it('searches by words, sender, conversation, dates, own messages and attachments', async () => {
    const s = store()
    expect((await s.search({ text: 'running LATE' })).messages.map((m) => m.id)).toEqual([3])
    const hit = (await s.search({ text: 'sunday' })).messages[0]
    expect(hit).toMatchObject({ id: 10, chatId: GROUP, chatName: 'Climbing crew' })
    expect((await s.search({ from: 'bob' })).messages.map((m) => m.id)).toEqual([11, 9])
    expect((await s.search({ from: 'ada example', chatId: ADA })).messages.map((m) => m.id)).toEqual([
      4, 3, 1,
    ])
    expect((await s.search({ from: 'nobody here' })).messages).toEqual([])
    expect((await s.search({ fromMe: true })).messages.map((m) => m.id)).toEqual([12, 2])
    expect((await s.search({ hasAttachment: true })).messages.map((m) => m.id)).toEqual([9, 4])
    expect(
      (await s.search({ since: '2026-11-21T00:00:00Z', until: '2026-11-22T00:00:00Z' })).messages.map(
        (m) => m.id,
      ),
    ).toEqual([3])
    const first = await s.search({ limit: 2 })
    expect(first.nextOffset).not.toBeNull()
    const second = await s.search({ limit: 2, offset: first.nextOffset ?? 0 })
    expect(second.messages.map((m) => m.id)).not.toEqual(first.messages.map((m) => m.id))
  })

  it('gives an attachment’s bytes, or says why not', async () => {
    const s = store()
    const photo = await s.attachment(4, 1)
    expect(photo.info).toMatchObject({ name: 'IMG_0001.png', type: 'image/png' })
    expect(photo.data).toEqual(PHOTO)
    expect(await s.attachment(4, 2)).toMatchObject({ data: null, reason: 'not-downloaded' })
    await expect(s.attachment(4, 3)).rejects.toEqual(new MessagesStoreError('not-found'))
    expect((await s.attachment(9, 1)).data?.toString()).toContain('Ada Example')
    await expect(s.attachment(999, 1)).rejects.toEqual(new MessagesStoreError('not-found'))
  })

  it('says unsupported when chat.db lacks a column it reads, and unavailable without one', async () => {
    const broken = {
      info: async () => ({ chat: true, contactSources: [] }),
      query: async (_db: string, sql: string) =>
        sql.startsWith('PRAGMA table_info(message)') ? [{ name: 'ROWID' }] : [],
      file: async () => Buffer.alloc(0),
    }
    await expect(
      new MessagesStore(broken, { hidden: () => new Set(), hideCodes: () => true }).chats(),
    ).rejects.toEqual(new MessagesStoreError('unsupported'))
    const missing = new DirectMessagesFiles({
      messagesDir: join(dir, 'none'),
      addressBookDir: join(dir, 'none'),
    })
    await expect(
      new MessagesStore(missing, { hidden: () => new Set(), hideCodes: () => true }).chats(),
    ).rejects.toEqual(new MessagesStoreError('unavailable'))
  })

  it('works without Contacts: people show by number', async () => {
    const noBook = new DirectMessagesFiles({
      messagesDir: paths.messagesDir,
      addressBookDir: join(dir, 'none'),
    })
    const s = new MessagesStore(noBook, { hidden: () => new Set(), hideCodes: () => true })
    expect((await s.chats({ text: ADA })).chats.find((c) => c.id === ADA)?.name).toBe(ADA)
  })
})

describe('DirectMessagesFiles, as the helper refuses', () => {
  it('reads only the message tables and only inside Attachments', async () => {
    for (const sql of ['DELETE FROM message', 'SELECT * FROM sqlite_master', 'SELECT 1; SELECT 2'])
      await expect(files.query('chat', sql, [])).rejects.toEqual(new MessagesFilesError('invalid'))
    await expect(files.query('contacts', 'SELECT 1', [])).rejects.toEqual(new MessagesFilesError('invalid'))
    await expect(files.query('contacts', 'SELECT 1', [], 'nope')).rejects.toEqual(
      new MessagesFilesError('not-found'),
    )
    await expect(files.file('../outside.txt')).rejects.toEqual(new MessagesFilesError('invalid'))
    symlinkSync(join(paths.messagesDir, 'chat.db'), join(paths.messagesDir, 'Attachments', 'link.db'))
    await expect(files.file('link.db')).rejects.toEqual(new MessagesFilesError('invalid'))
    expect(await files.info()).toEqual({ chat: true, contactSources: ['main', 'ABCD-1234'] })
  })
})

describe('helpers', () => {
  it('spots one-time codes without hiding ordinary messages', () => {
    for (const text of [
      'Your verification code is 123456',
      'G-482913 is your Google verification code.',
      'Use 4821 to sign in',
      'Your Woolworths one-time PIN: 902 113',
      'Your login code: AB12CD34',
    ])
      expect(looksLikeCode(text)).toBe(true)
    for (const text of [
      'See you at 9am',
      'The code for the gate is in the email',
      'Call me on 0400 111 222 when you land',
      'Running late',
      null,
    ])
      expect(looksLikeCode(text)).toBe(false)
  })

  it('matches handles to Contacts by email or the last nine digits', () => {
    expect(handleKey('+61400111222')).toBe(handleKey('0400 111 222'))
    expect(handleKey('Bob@Example.com')).toBe('bob@example.com')
    expect(handleKey('72345')).toBe('72345')
  })

  it('converts Messages’ clock and attachment paths', () => {
    expect(appleDate(978_307_210_000)).toBe(10_000)
    expect(attachmentPath('~/Library/Messages/Attachments/ab/01/X/a.png')).toBe('ab/01/X/a.png')
    expect(attachmentPath('/Users/x/Library/Messages/Attachments/ab/a.png')).toBe('ab/a.png')
    expect(attachmentPath('/tmp/a.png')).toBeNull()
    expect(attachmentPath(null)).toBeNull()
  })
})
