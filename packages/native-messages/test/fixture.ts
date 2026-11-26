// A made-up Messages folder and Contacts folder, laid out like the person's: chat.db with the
// tables and columns macOS writes (a few unrelated ones too, which the store must never read), an
// Attachments folder, and two Contacts databases. Nothing here is anyone's real data.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** An attributedBody archive holding `text`, as newer macOS writes instead of the text column. */
export function archived(text: string): Buffer {
  const body = Buffer.from(text, 'utf8')
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : Buffer.from([0x81, body.length & 0xff, (body.length >> 8) & 0xff])
  const hex = (v: string) => Buffer.from(v, 'hex')
  const ascii = (v: string) => Buffer.from(v, 'latin1')
  return Buffer.concat([
    hex('040b'),
    ascii('streamtyped'),
    hex('81e80384014084848412'),
    ascii('NSAttributedString'),
    hex('00848408'),
    ascii('NSObject'),
    hex('00859284848408'),
    ascii('NSString'),
    hex('019484012b'),
    length,
    body,
    hex('86'),
  ])
}

/** Messages' clock: nanoseconds since 2001-01-01 UTC. */
export function at(iso: string): number {
  return (Date.parse(iso) - 978_307_200_000) * 1_000_000
}

export const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export interface FixturePaths {
  readonly messagesDir: string
  readonly addressBookDir: string
}

/** The conversation ids in the fixture. */
export const ADA = '+61400111222'
export const BOB = 'bob@example.com'
export const GROUP = 'chat123456789'
export const BANK = '72345'
export const SECRET_CHAT = '+61400999888'

export function buildFixture(dir: string): FixturePaths {
  const messagesDir = join(dir, 'Messages')
  const addressBookDir = join(dir, 'AddressBook')
  mkdirSync(join(messagesDir, 'Attachments', 'ab', '01', 'GUID-PHOTO'), { recursive: true })
  mkdirSync(join(messagesDir, 'Attachments', 'cd', '02', 'GUID-CARD'), { recursive: true })
  mkdirSync(join(messagesDir, 'Attachments', 'ef', '03', 'GUID-SECRET'), { recursive: true })
  writeFileSync(join(messagesDir, 'Attachments', 'ab', '01', 'GUID-PHOTO', 'IMG_0001.png'), PHOTO)
  writeFileSync(
    join(messagesDir, 'Attachments', 'cd', '02', 'GUID-CARD', 'Ada.vcf'),
    'BEGIN:VCARD\nFN:Ada Example\nEND:VCARD\n',
  )
  writeFileSync(join(messagesDir, 'Attachments', 'ef', '03', 'GUID-SECRET', 'secret.png'), PHOTO)
  // Beside the attachments, never readable as one.
  writeFileSync(join(messagesDir, 'outside.txt'), 'not an attachment')

  const db = new DatabaseSync(join(messagesDir, 'chat.db'))
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT,
      service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
      state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT,
      room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT,
      display_name TEXT, group_id TEXT, is_filtered INTEGER DEFAULT 0);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
      replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT,
      country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0,
      service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER,
      date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0,
      is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
      is_empty INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, group_title TEXT, associated_message_guid TEXT,
      associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, thread_originator_guid TEXT,
      date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, associated_message_emoji TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
      message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0,
      PRIMARY KEY (chat_id, message_id));
    CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
      handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
      created_date INTEGER DEFAULT 0, start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT,
      mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0,
      transfer_name TEXT, total_bytes INTEGER DEFAULT 0, hide_attachment INTEGER DEFAULT 0);
    CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
      attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
    CREATE TABLE deleted_messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, guid TEXT NOT NULL);
    CREATE TABLE kvtable (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, key TEXT UNIQUE NOT NULL, value BLOB NOT NULL);
    INSERT INTO kvtable (key, value) VALUES ('secret', 'never read');
  `)
  const handle = db.prepare('INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)')
  handle.run(1, ADA, 'iMessage')
  handle.run(2, ADA, 'SMS')
  handle.run(3, BOB, 'iMessage')
  handle.run(4, '+61400333444', 'iMessage')
  handle.run(5, BANK, 'SMS')
  handle.run(6, SECRET_CHAT, 'iMessage')
  const chat = db.prepare(
    'INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?, ?)',
  )
  chat.run(1, `iMessage;-;${ADA}`, 45, ADA, 'iMessage', '')
  chat.run(2, `SMS;-;${ADA}`, 45, ADA, 'SMS', '')
  chat.run(3, `iMessage;-;${BOB}`, 45, BOB, 'iMessage', '')
  chat.run(4, `iMessage;+;${GROUP}`, 43, GROUP, 'iMessage', 'Climbing crew')
  chat.run(5, `SMS;-;${BANK}`, 45, BANK, 'SMS', null)
  chat.run(6, `iMessage;-;${SECRET_CHAT}`, 45, SECRET_CHAT, 'iMessage', '')
  const member = db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)')
  for (const [c, h] of [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 1],
    [4, 3],
    [4, 4],
    [5, 5],
    [6, 6],
  ] as const)
    member.run(c, h)

  const insert = db.prepare(
    `INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, service, date, is_from_me, is_read,
       cache_has_attachments, associated_message_guid, associated_message_type, item_type,
       thread_originator_guid, date_edited, date_retracted, associated_message_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const join_ = db.prepare(
    'INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)',
  )
  interface Row {
    id: number
    chat: number
    when: string
    text?: string | null
    body?: string
    handle?: number
    me?: boolean
    read?: boolean
    service?: string
    attachments?: boolean
    reactTo?: string
    reaction?: number
    emoji?: string
    item?: number
    reply?: string
    edited?: boolean
    unsent?: boolean
  }
  const rows: Row[] = [
    { id: 1, chat: 1, when: '2026-11-20T09:00:00Z', text: 'Climbing on Saturday?', handle: 1, read: true },
    { id: 2, chat: 1, when: '2026-11-20T09:05:00Z', text: 'Yes! 9am at the gym', me: true, handle: 1 },
    // Newer macOS: no text column, only the archive.
    {
      id: 3,
      chat: 2,
      when: '2026-11-21T08:00:00Z',
      text: null,
      body: 'Running late, sorry',
      handle: 2,
      service: 'SMS',
      read: true,
    },
    { id: 4, chat: 1, when: '2026-11-22T10:00:00Z', text: '￼', handle: 1, attachments: true },
    {
      id: 5,
      chat: 1,
      when: '2026-11-22T10:01:00Z',
      reactTo: 'p:0/M4',
      reaction: 2000,
      me: true,
      handle: 1,
      text: 'Loved an image',
    },
    {
      id: 6,
      chat: 1,
      when: '2026-11-22T10:02:00Z',
      reactTo: 'p:0/M2',
      reaction: 2001,
      handle: 1,
      text: 'Liked “Yes! 9am at the gym”',
    },
    {
      id: 7,
      chat: 1,
      when: '2026-11-22T10:03:00Z',
      reactTo: 'p:0/M2',
      reaction: 3001,
      handle: 1,
      text: 'Removed a like',
    },
    {
      id: 8,
      chat: 1,
      when: '2026-11-22T10:04:00Z',
      reactTo: 'p:0/M1',
      reaction: 2006,
      emoji: '🧗',
      handle: 1,
      text: 'Reacted 🧗',
    },
    {
      id: 9,
      chat: 3,
      when: '2026-11-23T12:00:00Z',
      text: 'Here is Ada’s card',
      handle: 3,
      attachments: true,
      read: true,
    },
    { id: 10, chat: 4, when: '2026-11-24T07:00:00Z', text: 'Who is in for Sunday?', handle: 4 },
    { id: 11, chat: 4, when: '2026-11-24T07:10:00Z', text: 'Me', handle: 3, reply: 'M10', read: true },
    { id: 12, chat: 4, when: '2026-11-24T07:11:00Z', text: 'Count me in', me: true, edited: true },
    { id: 13, chat: 4, when: '2026-11-24T07:12:00Z', text: '', handle: 1, unsent: true, read: true },
    // A group event (someone renamed it): not a message.
    { id: 14, chat: 4, when: '2026-11-24T07:13:00Z', text: null, handle: 1, item: 2, read: true },
    {
      id: 15,
      chat: 5,
      when: '2026-11-25T03:00:00Z',
      text: 'Your Example Bank verification code is 482913. Do not share it.',
      handle: 5,
      service: 'SMS',
    },
    {
      id: 16,
      chat: 5,
      when: '2026-11-25T03:30:00Z',
      text: 'Your statement is ready to view.',
      handle: 5,
      service: 'SMS',
      read: true,
    },
    {
      id: 17,
      chat: 6,
      when: '2026-11-25T05:00:00Z',
      text: 'The surprise party is at 7',
      handle: 6,
      attachments: true,
    },
    {
      id: 18,
      chat: 4,
      when: '2026-11-24T07:14:00Z',
      text: 'G-123456 is your sign-in code',
      handle: 4,
      read: true,
    },
  ]
  for (const r of rows) {
    const date = at(r.when)
    insert.run(
      r.id,
      `M${r.id}`,
      r.text === undefined ? null : r.text,
      r.body === undefined ? null : archived(r.body),
      r.me === true ? 0 : (r.handle ?? 0),
      r.service ?? 'iMessage',
      date,
      r.me === true ? 1 : 0,
      r.read === true || r.me === true ? 1 : 0,
      r.attachments === true ? 1 : 0,
      r.reactTo ?? null,
      r.reaction ?? 0,
      r.item ?? 0,
      r.reply ?? null,
      r.edited === true ? date + 1 : 0,
      r.unsent === true ? date + 1 : 0,
      r.emoji ?? null,
    )
    join_.run(r.chat, r.id, date)
  }
  const attachment = db.prepare(
    `INSERT INTO attachment (ROWID, guid, filename, uti, mime_type, transfer_name, total_bytes, hide_attachment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  attachment.run(
    1,
    'A1',
    '~/Library/Messages/Attachments/ab/01/GUID-PHOTO/IMG_0001.png',
    'public.png',
    'image/png',
    'IMG_0001.png',
    PHOTO.length,
    0,
  )
  attachment.run(
    2,
    'A2',
    '~/Library/Messages/Attachments/cd/02/GUID-CARD/Ada.vcf',
    'public.vcard',
    'text/vcard',
    'Ada.vcf',
    40,
    0,
  )
  attachment.run(
    3,
    'A3',
    '~/Library/Messages/Attachments/zz/99/GUID-GONE/Voice.caf',
    'com.apple.coreaudio-format',
    null,
    'Audio Message.caf',
    9000,
    0,
  )
  attachment.run(
    4,
    'A4',
    '~/Library/Messages/Attachments/ef/03/GUID-SECRET/secret.png',
    'public.png',
    'image/png',
    'secret.png',
    PHOTO.length,
    0,
  )
  attachment.run(
    5,
    'A5',
    '~/Library/Messages/Attachments/xx/00/P/x.pluginPayloadAttachment',
    null,
    null,
    'x.pluginPayloadAttachment',
    10,
    0,
  )
  attachment.run(
    6,
    'A6',
    '~/Library/Messages/Attachments/xx/00/H/hidden.png',
    'public.png',
    'image/png',
    'hidden.png',
    10,
    1,
  )
  const link = db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)')
  link.run(4, 1)
  link.run(4, 3)
  link.run(4, 5)
  link.run(4, 6)
  link.run(9, 2)
  link.run(17, 4)
  db.close()

  // Contacts: Ada in the main database, Bob in an account's.
  const contacts = (
    path: string,
    people: readonly [number, string, string, string | null, string | null][],
  ) => {
    mkdirSync(join(path, '..'), { recursive: true })
    const book = new DatabaseSync(path)
    book.exec(`
      CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFIRSTNAME VARCHAR, ZLASTNAME VARCHAR,
        ZNICKNAME VARCHAR, ZORGANIZATION VARCHAR, ZNOTE VARCHAR);
      CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR);
      CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS VARCHAR, ZADDRESSNORMALIZED VARCHAR);
      CREATE TABLE ZABCDNOTE (Z_PK INTEGER PRIMARY KEY, ZTEXT VARCHAR);
    `)
    for (const [id, first, last, phone, email] of people) {
      book
        .prepare('INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNOTE) VALUES (?, ?, ?, ?)')
        .run(id, first, last, 'private note')
      if (phone !== null)
        book.prepare('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)').run(id, phone)
      if (email !== null)
        book.prepare('INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)').run(id, email)
    }
    book.close()
  }
  mkdirSync(addressBookDir, { recursive: true })
  contacts(join(addressBookDir, 'AddressBook-v22.abcddb'), [[1, 'Ada', 'Example', '0400 111 222', null]])
  contacts(join(addressBookDir, 'Sources', 'ABCD-1234', 'AddressBook-v22.abcddb'), [
    [1, 'Bob', 'Sample', null, 'Bob@Example.com'],
  ])
  return { messagesDir, addressBookDir }
}
