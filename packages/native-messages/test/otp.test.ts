import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspect } from 'node:util'
import { CredentialError, type Grant, type MessagesOtpQuery, ValetError } from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectMessagesFiles } from '../src/direct-files'
import { MessagesOtpReader, OTP_MAX_LOOKBACK_MS } from '../src/otp'
import { archived } from './typedstream-fixture'

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
const NOW = new Date('2026-11-07T00:10:00.000Z')
const now = () => NOW
const WOOLWORTHS = { sender: 'Woolworths', pattern: 'code is (\\d{6})', maxAgeSeconds: 300 }
// The person approved codes from Woolworths, to be typed on its auth origin.
const WOOLWORTHS_GRANT: Grant = {
  adapterId: 'woolworths',
  adapterHash: 'a'.repeat(64),
  secret: 'messages',
  provider: 'messages',
  itemRef: 'Woolworths',
  origins: ['https://auth.woolworths.com.au'],
  grantedAt: '2026-11-07T00:00:00.000Z',
}
// The login asked for its code at 00:08.
const NOT_BEFORE = new Date('2026-11-07T00:08:00.000Z')

/** Messages' own unit: nanoseconds since 2001-01-01 UTC. */
function appleNanos(at: Date): bigint {
  return BigInt(at.getTime() - APPLE_EPOCH_MS) * 1_000_000n
}

/** The older unit: seconds since 2001-01-01 UTC. */
function appleSeconds(at: Date): bigint {
  return BigInt(Math.floor((at.getTime() - APPLE_EPOCH_MS) / 1000))
}

let dir: string
let path: string
let db: DatabaseSync

/** Messages as the app reads them, here from a made-up chat.db at `at`. */
function filesAt(at: string): DirectMessagesFiles {
  return new DirectMessagesFiles({ messagesDir: dirname(at), addressBookDir: join(dir, 'AddressBook') })
}

/** A reader over `at` (this test's chat.db unless given). */
function otpReader(options: { at?: string; now?: () => Date; limit?: number; requireGrant?: boolean } = {}) {
  const { at: where, ...rest } = options
  return new MessagesOtpReader({ files: filesAt(where ?? path), ...rest })
}

// The tables and columns MessagesStore checks for, as macOS lays them out; the reader reads only
// message and handle.
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'valet-messages-'))
  path = join(dir, 'chat.db')
  db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, service TEXT NOT NULL);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER DEFAULT 0,
      service TEXT,
      date INTEGER,
      is_from_me INTEGER DEFAULT 0,
      is_read INTEGER DEFAULT 0,
      cache_has_attachments INTEGER DEFAULT 0,
      associated_message_guid TEXT,
      associated_message_type INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0
    );
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
      chat_identifier TEXT, service_name TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, mime_type TEXT,
      transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle (ROWID, id, service) VALUES (1, 'Woolworths', 'SMS');
    INSERT INTO handle (ROWID, id, service) VALUES (2, '+61400000000', 'SMS');
  `)
})

afterEach(async () => {
  db.close()
  await fs.rm(dir, { recursive: true, force: true })
})

let guid = 0
function insert(row: {
  text?: string | null
  body?: Uint8Array | null
  handle?: number
  date: bigint
  fromMe?: boolean
}): void {
  guid += 1
  db.prepare(
    'INSERT INTO message (guid, text, attributedBody, handle_id, date, is_from_me) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`guid-${guid}`, row.text ?? null, row.body ?? null, row.handle ?? 1, row.date, row.fromMe ? 1 : 0)
}

async function failureOf(promise: Promise<unknown>): Promise<CredentialError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialError) return error
    throw error
  }
  throw new Error('expected a CredentialError')
}

const at = (iso: string) => new Date(`2026-11-07T${iso}Z`)

describe('MessagesOtpReader', () => {
  it('reads the code from a recent message by the sender', async () => {
    insert({ text: 'Your Woolworths code is 482913. Never share it.', date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now })
    const code = await reader.latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('482913')
  })

  it('uses the whole match when the pattern has no group', async () => {
    insert({ text: 'Your Woolworths code is 482913.', date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now })
    const code = await reader.latest({ ...WOOLWORTHS, pattern: '\\d{6}' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('482913')
  })

  it('decodes attributedBody when text is null, for each length encoding', async () => {
    const reader = otpReader({ now })
    const cases: [string, 'byte' | 'int16' | 'int32'][] = [
      ['Your code is 111111', 'byte'],
      [`Your code is 222222 ${'x'.repeat(300)}`, 'int16'],
      [`Your code is 333333 ${'y'.repeat(70_000)}`, 'int32'],
    ]
    let offsetSeconds = 0
    for (const [text, encoding] of cases) {
      offsetSeconds += 15
      insert({
        text: null,
        body: archived(text, encoding),
        date: appleNanos(new Date(NOT_BEFORE.getTime() + offsetSeconds * 1000)),
      })
      const code = await reader.latest(WOOLWORTHS, NOT_BEFORE)
      expect(code.reveal((plaintext) => plaintext)).toBe(text.slice(13, 19))
    }
  })

  it('prefers text over attributedBody when both are present', async () => {
    insert({ text: 'code is 111111', body: archived('code is 999999'), date: appleNanos(at('00:09:00')) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('returns the newest matching message', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'code is 222222', date: appleNanos(at('00:09:30')) })
    insert({ text: 'code is 333333', date: appleNanos(at('00:09:00')) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('222222')
  })

  it('skips newer messages that do not match the pattern', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'Your order is on its way', date: appleNanos(at('00:09:30')) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('ignores a code from before the login asked for one', async () => {
    // A stale code from the previous login must not be replayed.
    insert({ text: 'code is 111111', date: appleNanos(at('00:07:59')) })
    const error = await failureOf(otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('ignores a code older than maxAgeSeconds even when after notBefore', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:04:59')) })
    const reader = otpReader({ now })
    const error = await failureOf(reader.latest(WOOLWORTHS, new Date('2026-11-07T00:00:00.000Z')))
    expect(error.failure).toBe('not-found')
  })

  it('accepts a code right at the cut-off', async () => {
    insert({ text: 'code is 111111', date: appleNanos(NOT_BEFORE) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('ignores messages from other senders, even newer ones with a matching code', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'code is 666666', handle: 2, date: appleNanos(at('00:09:30')) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('matches an alphanumeric sender case-insensitively, but only as the whole handle', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now })
    expect((await reader.latest({ ...WOOLWORTHS, sender: 'wOOLworths' }, NOT_BEFORE)).reveal((p) => p)).toBe(
      '111111',
    )
    const error = await failureOf(reader.latest({ ...WOOLWORTHS, sender: 'Woolworth' }, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('matches a phone number written with spaces against the stored E.164 handle', async () => {
    insert({ text: 'code is 111111', handle: 2, date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now })
    const code = await reader.latest({ ...WOOLWORTHS, sender: '+61 400 000 000' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('does not match a sender that is only part of the handle', async () => {
    // "400000" is a valid short code, and a substring of +61400000000; it must not match it.
    insert({ text: 'code is 111111', handle: 2, date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now })
    const error = await failureOf(reader.latest({ ...WOOLWORTHS, sender: '400000' }, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('ignores a newer code from a lookalike iMessage handle', async () => {
    db.exec("INSERT INTO handle (ROWID, id, service) VALUES (3, 'fake.woolworths@icloud.com', 'iMessage')")
    insert({ text: 'Your Woolworths code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'Your Woolworths code is 999999', handle: 3, date: appleNanos(at('00:09:30')) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('ignores an alphanumeric sender name that arrived over iMessage', async () => {
    // Sender IDs only exist on the carrier network; the same name over iMessage is someone else.
    db.exec("INSERT INTO handle (ROWID, id, service) VALUES (3, 'woolworths', 'iMessage')")
    insert({ text: 'code is 999999', handle: 3, date: appleNanos(at('00:09:30')) })
    const error = await failureOf(otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('reads codes from an email sender over iMessage, but not from the same address over SMS', async () => {
    db.exec(`
      INSERT INTO handle (ROWID, id, service) VALUES (3, 'codes@example.com', 'iMessage');
      INSERT INTO handle (ROWID, id, service) VALUES (4, 'codes@example.com', 'SMS');
    `)
    insert({ text: 'code is 111111', handle: 3, date: appleNanos(at('00:09:00')) })
    insert({ text: 'code is 999999', handle: 4, date: appleNanos(at('00:09:30')) })
    const reader = otpReader({ now })
    const code = await reader.latest({ ...WOOLWORTHS, sender: 'Codes@Example.com' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('refuses a query with no sender, even with a catch-all pattern, whatever the types say', async () => {
    insert({ text: 'Your bank code is 482913', handle: 2, date: appleNanos(at('00:09:30')) })
    const { sender: _, ...anySender } = WOOLWORTHS
    const reader = otpReader({ now })
    for (const query of [
      { ...anySender, pattern: '([\\s\\S]*)' },
      { ...anySender, sender: null, pattern: '([\\s\\S]*)' },
      { ...anySender, sender: ['Woolworths'], pattern: '([\\s\\S]*)' },
    ]) {
      await expect(reader.latest(query as unknown as MessagesOtpQuery, NOT_BEFORE)).rejects.toMatchObject({
        stage: 'otp',
        errorClass: 'invalid',
      })
    }
  })

  it('refuses a sender that is not a full number, short code, sender ID or email', async () => {
    const reader = otpReader({ now })
    for (const sender of ['0400 000 000', 'woolworths.com.au', 'Woolworths Group Ltd', '', '12']) {
      await expect(reader.latest({ ...WOOLWORTHS, sender }, NOT_BEFORE)).rejects.toMatchObject({
        stage: 'otp',
        errorClass: 'invalid',
      })
    }
  })

  it('does not hand over a capture that is not shaped like a code', async () => {
    // A catch-all pattern on the right sender would otherwise return the whole message.
    insert({ text: 'Your Woolworths code is 482913. Never share it.', date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now })
    const error = await failureOf(reader.latest({ ...WOOLWORTHS, pattern: '([\\s\\S]*)' }, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('skips a too-short or too-long capture and falls back to an older, code-shaped one', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'code is 12', date: appleNanos(at('00:09:00')) })
    insert({ text: 'code is 12345678901', date: appleNanos(at('00:09:30')) })
    const reader = otpReader({ now })
    const code = await reader.latest({ ...WOOLWORTHS, pattern: 'code is (\\w+)' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('refuses an exponential pattern before running it', async () => {
    insert({ text: `${'a'.repeat(40)}!`, date: appleNanos(at('00:09:00')) })
    const started = Date.now()
    const reader = otpReader({ now })
    await expect(reader.latest({ ...WOOLWORTHS, pattern: '^(a+)+$' }, NOT_BEFORE)).rejects.toMatchObject({
      stage: 'otp',
      errorClass: 'invalid',
    })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('cuts off a polynomial pattern that gets past the screen, without blocking the event loop', async () => {
    // This takes hours on 1,970 digits; run on the main thread it would freeze the app.
    insert({ text: `Your code is 482913. code ${'1'.repeat(1_970)}`, date: appleNanos(at('00:09:00')) })
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 10)
    const started = Date.now()
    try {
      const reader = otpReader({ now })
      await expect(
        reader.latest({ ...WOOLWORTHS, pattern: 'code \\d*\\d*\\d*\\d*\\d*x' }, NOT_BEFORE),
      ).rejects.toMatchObject({ stage: 'otp', errorClass: 'invalid' })
    } finally {
      clearInterval(ticker)
    }
    expect(Date.now() - started).toBeLessThan(3_000)
    // The main thread kept running timers while the worker churned.
    expect(ticks).toBeGreaterThan(5)
  })

  it('ignores messages the person sent', async () => {
    insert({ text: 'code is 111111', fromMe: true, date: appleNanos(at('00:09:30')) })
    const error = await failureOf(otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('reads older databases that store seconds', async () => {
    insert({ text: 'code is 111111', date: appleSeconds(at('00:09:00')) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('applies the cut-off exactly to second-based dates', async () => {
    insert({ text: 'code is 111111', date: appleSeconds(at('00:07:59')) })
    const error = await failureOf(otpReader({ now }).latest(WOOLWORTHS, new Date('2026-11-07T00:07:59.500Z')))
    expect(error.failure).toBe('not-found')
  })

  it('only considers the most recent messages, up to the limit', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:10')) })
    insert({ text: 'noise', date: appleNanos(at('00:08:20')) })
    insert({ text: 'noise', date: appleNanos(at('00:08:30')) })
    const limited = otpReader({ now, limit: 2 })
    expect((await failureOf(limited.latest(WOOLWORTHS, NOT_BEFORE))).failure).toBe('not-found')
    const roomier = otpReader({ now, limit: 3 })
    expect((await roomier.latest(WOOLWORTHS, NOT_BEFORE)).reveal((p) => p)).toBe('111111')
  })

  it('skips rows with neither text nor a readable attributedBody', async () => {
    insert({ text: null, body: null, date: appleNanos(at('00:09:30')) })
    insert({ text: null, body: Buffer.from('not an archive'), date: appleNanos(at('00:09:20')) })
    insert({ text: 'code is 111111', date: appleNanos(at('00:09:00')) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('skips a match whose capture group is empty', async () => {
    insert({ text: 'code is ', date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now })
    const error = await failureOf(reader.latest({ ...WOOLWORTHS, pattern: 'code is (\\d*)' }, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('only scans the start of a very long message', async () => {
    insert({ text: `${'x'.repeat(2_000)} code is 111111`, date: appleNanos(at('00:09:00')) })
    const error = await failureOf(otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('reports no match as not-found', async () => {
    const error = await failureOf(otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('reports an invalid pattern as an invalid otp step', async () => {
    try {
      await otpReader({ now }).latest({ ...WOOLWORTHS, pattern: '(' }, NOT_BEFORE)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ValetError)
      expect([(error as ValetError).stage, (error as ValetError).errorClass]).toEqual(['otp', 'invalid'])
    }
  })

  it('reports a database it cannot open as unavailable', async () => {
    const reader = otpReader({ at: join(dir, 'missing', 'chat.db'), now })
    expect((await failureOf(reader.latest(WOOLWORTHS, NOT_BEFORE))).failure).toBe('unavailable')
  })

  // Root reads a file whatever its mode, so this only means something as an ordinary user.
  it.skipIf(process.getuid?.() === 0)(
    'reports a database it is not permitted to read as unavailable',
    async () => {
      // Without Full Disk Access, opening chat.db fails the same way.
      await fs.chmod(path, 0o000)
      try {
        const reader = otpReader({ now })
        expect((await failureOf(reader.latest(WOOLWORTHS, NOT_BEFORE))).failure).toBe('unavailable')
      } finally {
        await fs.chmod(path, 0o600)
      }
    },
  )

  it('reports a file that is not a database, or the wrong schema, as unavailable', async () => {
    const junk = join(dir, 'junk', 'chat.db')
    await fs.mkdir(dirname(junk))
    await fs.writeFile(junk, 'this is not sqlite '.repeat(100))
    expect((await failureOf(otpReader({ at: junk, now }).latest(WOOLWORTHS, NOT_BEFORE))).failure).toBe(
      'unavailable',
    )
    db.exec('DROP TABLE handle')
    expect((await failureOf(otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE))).failure).toBe('unavailable')
  })

  it('never writes to the database', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:09:00')) })
    db.close()
    const before = await fs.readFile(path)
    await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect((await fs.readFile(path)).equals(before)).toBe(true)
    expect((await fs.readdir(dir)).sort()).toEqual(['chat.db'])
    db = new DatabaseSync(path)
  })

  it('keeps the code out of errors', async () => {
    insert({ text: 'code is 482913', handle: 2, date: appleNanos(at('00:09:00')) })
    const error = await failureOf(otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(
      [error.message, String(error.stack), inspect(error), JSON.stringify(error)].join('\n'),
    ).not.toContain('482913')
  })

  it('only takes a code from a message the Messages tools would hide as one', async () => {
    // The pattern finds six digits here, but agents could read this message: it is not a code.
    insert({ text: 'Your order 482913 is on its way', date: appleNanos(at('00:09:30')) })
    insert({ text: 'Your Woolworths code is 111111', date: appleNanos(at('00:09:00')) })
    const code = await otpReader({ now }).latest({ ...WOOLWORTHS, pattern: '(\\d{6})' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
    db.exec('DELETE FROM message')
    insert({ text: 'Use 482913 to continue', date: appleNanos(at('00:09:30')) })
    const error = await failureOf(
      otpReader({ now }).latest({ ...WOOLWORTHS, pattern: '(\\d{6})' }, NOT_BEFORE),
    )
    expect(error.failure).toBe('not-found')
  })

  it('never looks further back than 30 minutes, whatever the manifest allows', async () => {
    const later = () => new Date(NOW.getTime() + 60 * 60_000)
    insert({
      text: 'code is 111111',
      date: appleNanos(new Date(later().getTime() - OTP_MAX_LOOKBACK_MS - 1_000)),
    })
    const query = { ...WOOLWORTHS, maxAgeSeconds: 24 * 60 * 60 }
    const error = await failureOf(otpReader({ now: later }).latest(query, new Date(0)))
    expect(error.failure).toBe('not-found')
    insert({
      text: 'code is 222222',
      date: appleNanos(new Date(later().getTime() - OTP_MAX_LOOKBACK_MS + 1_000)),
    })
    expect((await otpReader({ now: later }).latest(query, new Date(0))).reveal((p) => p)).toBe('222222')
  })

  it('keeps the code out of what it hands back, other than through reveal', async () => {
    insert({ text: null, body: archived('Your code is 482913'), date: appleNanos(at('00:09:00')) })
    const code = await otpReader({ now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('482913')
    expect([inspect(code), String(code), JSON.stringify(code)].join('\n')).not.toContain('482913')
    const refused = await failureOf(otpReader({ now }).latest({ ...WOOLWORTHS, sender: 'Coles' }, NOT_BEFORE))
    expect(inspect(refused)).not.toContain('482913')
  })

  it('uses the real clock by default', async () => {
    insert({ text: 'code is 111111', date: appleNanos(new Date()) })
    const code = await otpReader().latest(WOOLWORTHS, new Date(Date.now() - 60_000))
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })
})

describe('MessagesOtpReader with a grant', () => {
  it('reads the code when the grant is for the query sender, however it is written', async () => {
    insert({ text: 'code is 482913', date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now, requireGrant: true })
    const code = await reader.latest({ ...WOOLWORTHS, sender: 'WOOLWORTHS' }, NOT_BEFORE, WOOLWORTHS_GRANT)
    expect(code.reveal((plaintext) => plaintext)).toBe('482913')
  })

  it('refuses a manifest sender other than the granted one, before reading anything', async () => {
    // The manifest changed its sender to the person's bank; the grant still names Woolworths.
    insert({ text: 'Your bank code is 482913', handle: 2, date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ at: join(dir, 'missing', 'chat.db'), now })
    for (const sender of ['+61400000000', 'Woolworths1', 'fake.woolworths@icloud.com']) {
      await expect(reader.latest({ ...WOOLWORTHS, sender }, NOT_BEFORE, WOOLWORTHS_GRANT)).rejects.toEqual(
        new ValetError('otp', 'not-granted'),
      )
    }
  })

  it('refuses a grant that is not a messages grant, even one whose itemRef is the sender', async () => {
    const reader = otpReader({ now })
    for (const grant of [
      { ...WOOLWORTHS_GRANT, provider: 'onepassword-cli' as const },
      { ...WOOLWORTHS_GRANT, provider: 'fake' as const },
      { ...WOOLWORTHS_GRANT, secret: 'login' },
      { ...WOOLWORTHS_GRANT, itemRef: '%' },
    ]) {
      await expect(reader.latest(WOOLWORTHS, NOT_BEFORE, grant)).rejects.toEqual(
        new ValetError('otp', 'not-granted'),
      )
    }
  })

  it('refuses a grant check against a query with no sender, whatever the types say', async () => {
    const { sender: _, ...anySender } = WOOLWORTHS
    const reader = otpReader({ now })
    await expect(
      reader.latest(anySender as unknown as MessagesOtpQuery, NOT_BEFORE, WOOLWORTHS_GRANT),
    ).rejects.toEqual(new ValetError('otp', 'not-granted'))
  })

  it('with requireGrant, refuses a lookup that comes without a grant', async () => {
    insert({ text: 'code is 482913', date: appleNanos(at('00:09:00')) })
    const reader = otpReader({ now, requireGrant: true })
    await expect(reader.latest(WOOLWORTHS, NOT_BEFORE)).rejects.toEqual(new ValetError('otp', 'not-granted'))
    await expect(reader.latest(WOOLWORTHS, NOT_BEFORE, null as unknown as Grant)).rejects.toEqual(
      new ValetError('otp', 'not-granted'),
    )
  })
})
