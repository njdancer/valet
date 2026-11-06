import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspect } from 'node:util'
import { CredentialError, type MessagesOtpQuery, SiteAdapterError } from '@siteadapter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultMessagesDbPath, MessagesOtpReader } from '../src/messages-otp'
import { archived } from './typedstream-fixture'

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
const NOW = new Date('2026-11-07T00:10:00.000Z')
const now = () => NOW
const WOOLWORTHS = { sender: 'Woolworths', pattern: 'code is (\\d{6})', maxAgeSeconds: 300 }
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

// The subset of the Messages schema the reader touches, with the columns it doesn't read left out.
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'siteadapter-messages-'))
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
      date INTEGER,
      is_from_me INTEGER DEFAULT 0
    );
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
    const reader = new MessagesOtpReader({ path, now })
    const code = await reader.latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('482913')
  })

  it('uses the whole match when the pattern has no group', async () => {
    insert({ text: 'Your Woolworths code is 482913.', date: appleNanos(at('00:09:00')) })
    const reader = new MessagesOtpReader({ path, now })
    const code = await reader.latest({ ...WOOLWORTHS, pattern: '\\d{6}' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('482913')
  })

  it('decodes attributedBody when text is null, for each length encoding', async () => {
    const reader = new MessagesOtpReader({ path, now })
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
    const code = await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('returns the newest matching message', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'code is 222222', date: appleNanos(at('00:09:30')) })
    insert({ text: 'code is 333333', date: appleNanos(at('00:09:00')) })
    const code = await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('222222')
  })

  it('skips newer messages that do not match the pattern', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'Your order is on its way', date: appleNanos(at('00:09:30')) })
    const code = await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('ignores a code from before the login asked for one', async () => {
    // A stale code from the previous login must not be replayed.
    insert({ text: 'code is 111111', date: appleNanos(at('00:07:59')) })
    const error = await failureOf(new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('ignores a code older than maxAgeSeconds even when after notBefore', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:04:59')) })
    const reader = new MessagesOtpReader({ path, now })
    const error = await failureOf(reader.latest(WOOLWORTHS, new Date('2026-11-07T00:00:00.000Z')))
    expect(error.failure).toBe('not-found')
  })

  it('accepts a code right at the cut-off', async () => {
    insert({ text: 'code is 111111', date: appleNanos(NOT_BEFORE) })
    const code = await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('ignores messages from other senders, even newer ones with a matching code', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'code is 666666', handle: 2, date: appleNanos(at('00:09:30')) })
    const code = await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('matches an alphanumeric sender case-insensitively, but only as the whole handle', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:09:00')) })
    const reader = new MessagesOtpReader({ path, now })
    expect((await reader.latest({ ...WOOLWORTHS, sender: 'wOOLworths' }, NOT_BEFORE)).reveal((p) => p)).toBe(
      '111111',
    )
    const error = await failureOf(reader.latest({ ...WOOLWORTHS, sender: 'Woolworth' }, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('matches a phone number written with spaces against the stored E.164 handle', async () => {
    insert({ text: 'code is 111111', handle: 2, date: appleNanos(at('00:09:00')) })
    const reader = new MessagesOtpReader({ path, now })
    const code = await reader.latest({ ...WOOLWORTHS, sender: '+61 400 000 000' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('does not match a sender that is only part of the handle', async () => {
    // "400000" is a valid short code, and a substring of +61400000000; it must not match it.
    insert({ text: 'code is 111111', handle: 2, date: appleNanos(at('00:09:00')) })
    const reader = new MessagesOtpReader({ path, now })
    const error = await failureOf(reader.latest({ ...WOOLWORTHS, sender: '400000' }, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('ignores a newer code from a lookalike iMessage handle', async () => {
    db.exec("INSERT INTO handle (ROWID, id, service) VALUES (3, 'fake.woolworths@icloud.com', 'iMessage')")
    insert({ text: 'Your Woolworths code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'Your Woolworths code is 999999', handle: 3, date: appleNanos(at('00:09:30')) })
    const code = await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('ignores an alphanumeric sender name that arrived over iMessage', async () => {
    // Sender IDs only exist on the carrier network; the same name over iMessage is someone else.
    db.exec("INSERT INTO handle (ROWID, id, service) VALUES (3, 'woolworths', 'iMessage')")
    insert({ text: 'code is 999999', handle: 3, date: appleNanos(at('00:09:30')) })
    const error = await failureOf(new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('reads codes from an email sender over iMessage, but not from the same address over SMS', async () => {
    db.exec(`
      INSERT INTO handle (ROWID, id, service) VALUES (3, 'codes@example.com', 'iMessage');
      INSERT INTO handle (ROWID, id, service) VALUES (4, 'codes@example.com', 'SMS');
    `)
    insert({ text: 'code is 111111', handle: 3, date: appleNanos(at('00:09:00')) })
    insert({ text: 'code is 999999', handle: 4, date: appleNanos(at('00:09:30')) })
    const reader = new MessagesOtpReader({ path, now })
    const code = await reader.latest({ ...WOOLWORTHS, sender: 'Codes@Example.com' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('refuses a query with no sender, even with a catch-all pattern, whatever the types say', async () => {
    insert({ text: 'Your bank code is 482913', handle: 2, date: appleNanos(at('00:09:30')) })
    const { sender: _, ...anySender } = WOOLWORTHS
    const reader = new MessagesOtpReader({ path, now })
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
    const reader = new MessagesOtpReader({ path, now })
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
    const reader = new MessagesOtpReader({ path, now })
    const error = await failureOf(reader.latest({ ...WOOLWORTHS, pattern: '([\\s\\S]*)' }, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('skips a too-short or too-long capture and falls back to an older, code-shaped one', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:30')) })
    insert({ text: 'code is 12', date: appleNanos(at('00:09:00')) })
    insert({ text: 'code is 12345678901', date: appleNanos(at('00:09:30')) })
    const reader = new MessagesOtpReader({ path, now })
    const code = await reader.latest({ ...WOOLWORTHS, pattern: 'code is (\\w+)' }, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('refuses an exponential pattern before running it', async () => {
    insert({ text: `${'a'.repeat(40)}!`, date: appleNanos(at('00:09:00')) })
    const started = Date.now()
    const reader = new MessagesOtpReader({ path, now })
    await expect(reader.latest({ ...WOOLWORTHS, pattern: '^(a+)+$' }, NOT_BEFORE)).rejects.toMatchObject({
      stage: 'otp',
      errorClass: 'invalid',
    })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('cuts off a polynomial pattern that gets past the screen, without blocking the event loop', async () => {
    // This takes hours on 1,990 digits; run on the main thread it would freeze the app.
    insert({ text: `code ${'1'.repeat(1_990)}`, date: appleNanos(at('00:09:00')) })
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 10)
    const started = Date.now()
    try {
      const reader = new MessagesOtpReader({ path, now })
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
    const error = await failureOf(new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('reads older databases that store seconds', async () => {
    insert({ text: 'code is 111111', date: appleSeconds(at('00:09:00')) })
    const code = await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('applies the cut-off exactly to second-based dates', async () => {
    insert({ text: 'code is 111111', date: appleSeconds(at('00:07:59')) })
    const error = await failureOf(
      new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, new Date('2026-11-07T00:07:59.500Z')),
    )
    expect(error.failure).toBe('not-found')
  })

  it('only considers the most recent messages, up to the limit', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:08:10')) })
    insert({ text: 'noise', date: appleNanos(at('00:08:20')) })
    insert({ text: 'noise', date: appleNanos(at('00:08:30')) })
    const limited = new MessagesOtpReader({ path, now, limit: 2 })
    expect((await failureOf(limited.latest(WOOLWORTHS, NOT_BEFORE))).failure).toBe('not-found')
    const roomier = new MessagesOtpReader({ path, now, limit: 3 })
    expect((await roomier.latest(WOOLWORTHS, NOT_BEFORE)).reveal((p) => p)).toBe('111111')
  })

  it('skips rows with neither text nor a readable attributedBody', async () => {
    insert({ text: null, body: null, date: appleNanos(at('00:09:30')) })
    insert({ text: null, body: Buffer.from('not an archive'), date: appleNanos(at('00:09:20')) })
    insert({ text: 'code is 111111', date: appleNanos(at('00:09:00')) })
    const code = await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })

  it('skips a match whose capture group is empty', async () => {
    insert({ text: 'code is ', date: appleNanos(at('00:09:00')) })
    const reader = new MessagesOtpReader({ path, now })
    const error = await failureOf(reader.latest({ ...WOOLWORTHS, pattern: 'code is (\\d*)' }, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('only scans the start of a very long message', async () => {
    insert({ text: `${'x'.repeat(2_000)} code is 111111`, date: appleNanos(at('00:09:00')) })
    const error = await failureOf(new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('reports no match as not-found', async () => {
    const error = await failureOf(new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(error.failure).toBe('not-found')
  })

  it('reports an invalid pattern as an invalid otp step', async () => {
    try {
      await new MessagesOtpReader({ path, now }).latest({ ...WOOLWORTHS, pattern: '(' }, NOT_BEFORE)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SiteAdapterError)
      expect([(error as SiteAdapterError).stage, (error as SiteAdapterError).errorClass]).toEqual([
        'otp',
        'invalid',
      ])
    }
  })

  it('reports a database it cannot open as unavailable', async () => {
    const reader = new MessagesOtpReader({ path: join(dir, 'missing', 'chat.db'), now })
    expect((await failureOf(reader.latest(WOOLWORTHS, NOT_BEFORE))).failure).toBe('unavailable')
  })

  it('reports a database it is not permitted to read as unavailable', async () => {
    // Without Full Disk Access, opening chat.db fails the same way.
    await fs.chmod(path, 0o000)
    try {
      const reader = new MessagesOtpReader({ path, now })
      expect((await failureOf(reader.latest(WOOLWORTHS, NOT_BEFORE))).failure).toBe('unavailable')
    } finally {
      await fs.chmod(path, 0o600)
    }
  })

  it('reports a file that is not a database, or the wrong schema, as unavailable', async () => {
    const junk = join(dir, 'junk.db')
    await fs.writeFile(junk, 'this is not sqlite '.repeat(100))
    expect(
      (await failureOf(new MessagesOtpReader({ path: junk, now }).latest(WOOLWORTHS, NOT_BEFORE))).failure,
    ).toBe('unavailable')
    db.exec('DROP TABLE handle')
    expect(
      (await failureOf(new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE))).failure,
    ).toBe('unavailable')
  })

  it('never writes to the database', async () => {
    insert({ text: 'code is 111111', date: appleNanos(at('00:09:00')) })
    db.close()
    const before = await fs.readFile(path)
    await new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE)
    expect((await fs.readFile(path)).equals(before)).toBe(true)
    expect((await fs.readdir(dir)).sort()).toEqual(['chat.db'])
    db = new DatabaseSync(path)
  })

  it('keeps the code out of errors', async () => {
    insert({ text: 'code is 482913', handle: 2, date: appleNanos(at('00:09:00')) })
    const error = await failureOf(new MessagesOtpReader({ path, now }).latest(WOOLWORTHS, NOT_BEFORE))
    expect(
      [error.message, String(error.stack), inspect(error), JSON.stringify(error)].join('\n'),
    ).not.toContain('482913')
  })

  it('uses the real clock by default', async () => {
    insert({ text: 'code is 111111', date: appleNanos(new Date()) })
    const code = await new MessagesOtpReader({ path }).latest(WOOLWORTHS, new Date(Date.now() - 60_000))
    expect(code.reveal((plaintext) => plaintext)).toBe('111111')
  })
})

describe('defaultMessagesDbPath', () => {
  it("points at the person's Messages database", () => {
    expect(defaultMessagesDbPath().endsWith(join('Library', 'Messages', 'chat.db'))).toBe(true)
  })
})
