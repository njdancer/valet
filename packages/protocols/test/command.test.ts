// Writing commands: arguments can never end a command early, and every command is held to the
// session's purpose before a byte of it is written.

import { checkFetchItem, IMAP_PURPOSE_RANK, operationPurpose, VERB_PURPOSE } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  type Command,
  CommandRefused,
  checkCommand,
  decodeMailbox,
  encodeCommand,
  encodeMailbox,
  type SessionState,
  uidSet,
} from '../src/imap/command'

const text = (segments: ReturnType<typeof encodeCommand>) =>
  segments.map((s) => ('text' in s ? s.text.toString('latin1') : `<${s.literal.toString('latin1')}>`)).join('')

const state = (purpose: SessionState['purpose'], selected: SessionState['selected'] = null): SessionState => ({
  purpose,
  selected,
})

describe('encodeCommand', () => {
  it('quotes plain strings and escapes quotes and backslashes', () => {
    expect(text(encodeCommand('V1', { verb: 'LOGIN', args: [{ string: 'a"b' }, { string: 'c\\d' }] }, false))).toBe(
      'V1 LOGIN "a\\"b" "c\\\\d"\r\n',
    )
  })

  it('sends anything with a line break, NUL or 8-bit byte as a literal, never inline', () => {
    const segments = encodeCommand('V2', { verb: 'LOGIN', args: [{ string: 'x\r\nV3 DELETE INBOX' }, { string: 'p' }] }, false)
    expect(text(segments)).toBe('V2 LOGIN {18}\r\n<x\r\nV3 DELETE INBOX> "p"\r\n')
    expect(segments.some((s) => 'literal' in s)).toBe(true)
  })

  it('writes a non-synchronising literal when the server has LITERAL+', () => {
    const segments = encodeCommand('V3', { verb: 'APPEND', args: [{ mailbox: 'INBOX' }, { list: [] }, { string: Buffer.from('é') }] }, true)
    expect(segments.every((s) => 'text' in s)).toBe(true)
    expect(text(segments)).toBe('V3 APPEND "INBOX" () {2+}\r\nÃ©\r\n')
  })

  it('sends a long string as a literal', () => {
    expect(text(encodeCommand('V4', { verb: 'LOGIN', args: [{ string: 'a'.repeat(1001) }, { string: '' }] }, false))).toMatch(
      /^V4 LOGIN \{1001\}\r\n<a+> ""\r\n$/,
    )
  })

  it.each([
    ['an atom with a space', { verb: 'LIST', args: [{ atom: 'a b' }] }],
    ['an atom with a CRLF', { verb: 'LIST', args: [{ atom: 'a\r\nb' }] }],
    ['an atom with a paren', { verb: 'LIST', args: [{ atom: 'a)' }] }],
    ['a negative number', { verb: 'LIST', args: [{ number: -1 }] }],
    ['a fractional number', { verb: 'LIST', args: [{ number: 1.5 }] }],
    ['an empty UID set', { verb: 'UID FETCH', args: [{ uids: [] }, { list: [] }] }],
    ['a zero UID', { verb: 'UID FETCH', args: [{ uids: [0] }, { list: [] }] }],
    ['a fetch item with a space outside brackets', { verb: 'UID FETCH', args: [{ uids: [1] }, { list: [{ atom: 'UID FLAGS' }] }] }],
  ] as [string, Command][])('refuses %s', (_name, command) => {
    expect(() => encodeCommand('V1', command, false)).toThrow(CommandRefused)
  })

  it('refuses a bad tag', () => {
    expect(() => encodeCommand('V 1', { verb: 'NOOP', args: [] }, false)).toThrow(CommandRefused)
  })
})

describe('uidSet', () => {
  it('writes sorted, deduplicated ranges', () => {
    expect(uidSet([5, 1, 2, 3, 3, 9, 10])).toBe('1:3,5,9:10')
    expect(uidSet([7])).toBe('7')
    expect(() => uidSet(Array.from({ length: 10_001 }, (_, i) => i + 1))).toThrow(CommandRefused)
    expect(() => uidSet([2 ** 32])).toThrow(CommandRefused)
  })
})

describe('mailbox names', () => {
  it('round-trips modified UTF-7', () => {
    for (const name of ['INBOX', 'Sent Messages', 'Brouillons & idées', '日本語', 'a&b', 'Emoji 📬']) {
      expect(decodeMailbox(encodeMailbox(name))).toBe(name)
    }
    expect(encodeMailbox('a&b')).toBe('a&-b')
    expect(encodeMailbox('Entwürfe')).toBe('Entw&APw-rfe')
    expect(decodeMailbox('&Jjo-!')).toBe('☺!')
  })

  it('leaves a malformed name as the server wrote it', () => {
    expect(decodeMailbox('&AAA-')).toBe('&AAA-')
  })
})

describe('checkCommand', () => {
  const examined = { folder: 'INBOX', readOnly: true }
  const selected = { folder: 'INBOX', readOnly: false }
  const fetch = (...items: string[]): Command => ({
    verb: 'UID FETCH',
    args: [{ uids: [1] }, { list: items.map((atom) => ({ atom })) }],
  })

  it('lets a read session only look', () => {
    for (const verb of ['CAPABILITY', 'NOOP', 'LOGIN', 'LOGOUT', 'LIST', 'STATUS', 'EXAMINE', 'UNSELECT', 'UID SEARCH']) {
      expect(() => checkCommand({ verb, args: [] }, state('read', examined))).not.toThrow()
    }
    for (const verb of ['SELECT', 'UID STORE', 'UID COPY', 'UID MOVE', 'APPEND', 'CREATE', 'UID EXPUNGE', 'DELETE']) {
      expect(() => checkCommand({ verb, args: [] }, state('read', examined))).toThrow(CommandRefused)
    }
  })

  it('never sends CLOSE, plain EXPUNGE or anything not in the table, whatever the purpose', () => {
    for (const verb of ['CLOSE', 'EXPUNGE', 'RENAME', 'SUBSCRIBE', 'STARTTLS', 'AUTHENTICATE', 'COMPRESS', 'IDLE', 'SETACL', 'FETCH', 'STORE', 'COPY', 'SEARCH', 'XYZ']) {
      expect(() => checkCommand({ verb, args: [] }, state('irreversible', selected))).toThrow(CommandRefused)
    }
  })

  it('fetches message data only with BODY.PEEK', () => {
    expect(() => checkCommand(fetch('UID', 'FLAGS', 'ENVELOPE', 'INTERNALDATE', 'RFC822.SIZE', 'BODYSTRUCTURE'), state('read', examined))).not.toThrow()
    for (const item of ['BODY.PEEK[]', 'BODY.PEEK[1.2]<0.100>', 'BODY.PEEK[HEADER]', 'BODY.PEEK[2.MIME]', 'BODY.PEEK[TEXT]']) {
      expect(() => checkCommand(fetch(item), state('read', examined))).not.toThrow()
    }
    for (const item of ['BODY[]', 'BODY[1]', 'RFC822', 'RFC822.TEXT', 'RFC822.HEADER', 'BINARY[1]', 'BODY.PEEK[0]', 'BODY.PEEK[1.0]', 'BODY.PEEK[HEADER.FIELDS (FROM)]', 'BODY.PEEK[]<0.0>']) {
      expect(() => checkCommand(fetch(item), state('irreversible', selected))).toThrow(CommandRefused)
    }
    expect(() => checkCommand({ verb: 'UID FETCH', args: [{ uids: [1] }] }, state('read'))).toThrow(CommandRefused)
    expect(() => checkCommand({ verb: 'UID FETCH', args: [{ uids: [1] }, { list: [{ string: 'UID' }] }] }, state('read'))).toThrow(CommandRefused)
  })

  it('keeps \\Deleted for an irreversible session, in STORE and APPEND alike', () => {
    const store = (flag: string): Command => ({
      verb: 'UID STORE',
      args: [{ uids: [1] }, { atom: '+FLAGS.SILENT' }, { list: [{ atom: flag }] }],
    })
    expect(() => checkCommand(store('\\Flagged'), state('write', selected))).not.toThrow()
    expect(() => checkCommand(store('\\Deleted'), state('write', selected))).toThrow(/needs-irreversible/)
    expect(() => checkCommand(store('\\DELETED'), state('write', selected))).toThrow(/needs-irreversible/)
    expect(() => checkCommand(store('\\Deleted'), state('irreversible', selected))).not.toThrow()
    const append: Command = { verb: 'APPEND', args: [{ mailbox: 'INBOX' }, { list: [{ atom: '\\Deleted' }] }, { string: 'x' }] }
    expect(() => checkCommand(append, state('write'))).toThrow(/needs-irreversible/)
  })

  it('changes mail only in a folder opened to write', () => {
    const store: Command = { verb: 'UID STORE', args: [{ uids: [1] }, { atom: '+FLAGS.SILENT' }, { list: [] }] }
    expect(() => checkCommand(store, state('write', examined))).toThrow(CommandRefused)
    for (const verb of ['UID COPY', 'UID MOVE', 'UID EXPUNGE']) {
      expect(() => checkCommand({ verb, args: [] }, state('irreversible', examined))).toThrow(CommandRefused)
      expect(() => checkCommand({ verb, args: [] }, state('irreversible', null))).toThrow(CommandRefused)
      expect(() => checkCommand({ verb, args: [] }, state('irreversible', selected))).not.toThrow()
    }
  })
})

describe('the policy table', () => {
  it('ranks purposes, and every verb has one', () => {
    expect(IMAP_PURPOSE_RANK.read).toBeLessThan(IMAP_PURPOSE_RANK.write)
    expect(IMAP_PURPOSE_RANK.write).toBeLessThan(IMAP_PURPOSE_RANK.irreversible)
    expect(VERB_PURPOSE['EXAMINE']).toBe('read')
    expect(VERB_PURPOSE['SELECT']).toBe('write')
    expect(VERB_PURPOSE['CLOSE']).toBeUndefined()
    expect(checkFetchItem('BODY.PEEK[1]')).toBe(true)
  })

  it('makes any mention of \\Deleted irreversible', () => {
    expect(operationPurpose('setFlags', ['INBOX', [1], { add: ['\\Seen'] }])).toBe('write')
    expect(operationPurpose('setFlags', ['INBOX', [1], { add: ['\\deleted'] }])).toBe('irreversible')
    expect(operationPurpose('setFlags', ['INBOX', [1], { remove: ['\\Deleted'] }])).toBe('irreversible')
    expect(operationPurpose('append', ['INBOX', 'x', { flags: ['\\Deleted'] }])).toBe('irreversible')
    expect(operationPurpose('append', ['INBOX', 'x'])).toBe('write')
    expect(operationPurpose('search', ['INBOX', { deleted: true }])).toBe('read')
    expect(operationPurpose('expunge', ['INBOX', [1]])).toBe('irreversible')
  })
})
