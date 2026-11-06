// Reads SMS one-time codes from the macOS Messages database. It needs Full Disk Access; without it
// the open fails and the reader reports `unavailable`. The database is opened read-only per lookup.
// The sender and pattern come from adapter code, so the reader only hands back something shaped like
// a code, from exactly the named sender, and never runs the pattern on the main thread.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  CredentialError,
  isScreenedPattern,
  type MessagesOtpQuery,
  type OtpReader,
  SecretValue,
  SiteAdapterError,
} from '@siteadapter/core'
import { type OtpSender, parseOtpSender } from './otp-sender'
import { type PatternMatcher, WorkerPatternMatcher } from './pattern-worker'
import { attributedBodyText } from './typedstream'

export function defaultMessagesDbPath(): string {
  return join(homedir(), 'Library', 'Messages', 'chat.db')
}

export interface MessagesOtpReaderOptions {
  readonly path?: string
  readonly now?: () => Date
  /** How many recent inbound messages to consider. */
  readonly limit?: number
  readonly matcher?: PatternMatcher
}

// Messages counts time from 2001-01-01 UTC (Core Data's reference date).
const APPLE_EPOCH_MS = 978_307_200_000
// Older databases store seconds, newer ones nanoseconds. Seconds won't reach 1e11 until the year 5170.
const NANOSECOND_THRESHOLD = 100_000_000_000n
const DEFAULT_LIMIT = 50
// Codes sit near the start of a message; the cap also bounds the work a pattern can do on long text.
const MAX_SCANNED_CHARS = 2_000
// What a one-time code looks like. A capture of anything else, such as a whole message caught by a
// catch-all pattern, is not handed to the filler.
const CODE_SHAPE = /^[A-Za-z0-9]{4,10}$/

const QUERY = `
  SELECT m.text AS text, m.attributedBody AS body, m.date AS date
  FROM message m JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.is_from_me = 0
    AND (m.date >= ? OR (m.date < ? AND m.date >= ?))
    AND lower(h.id) = ?
    AND instr(?, ',' || h.service || ',') > 0
  ORDER BY m.date DESC
  LIMIT ?`

interface Row {
  readonly text: string | null
  readonly body: Uint8Array | null
  readonly date: bigint
}

export class MessagesOtpReader implements OtpReader {
  readonly #path: string
  readonly #now: () => Date
  readonly #limit: number
  readonly #matcher: PatternMatcher

  constructor(options: MessagesOtpReaderOptions = {}) {
    this.#path = options.path ?? defaultMessagesDbPath()
    this.#now = options.now ?? (() => new Date())
    this.#limit = options.limit ?? DEFAULT_LIMIT
    this.#matcher = options.matcher ?? new WorkerPatternMatcher()
  }

  async latest(query: MessagesOtpQuery, notBefore: Date): Promise<SecretValue> {
    // Without a sender, any message from anyone (another bank's code, a private message) could be
    // typed into the page. The type and the manifest schema both require one; this check stands in
    // case a query is built some other way (from JSON, say) and the types were never checked.
    const sender = typeof query.sender === 'string' ? parseOtpSender(query.sender) : null
    if (sender === null || !isScreenedPattern(query.pattern)) throw new SiteAdapterError('otp', 'invalid')
    const sinceMs = Math.max(notBefore.getTime(), this.#now().getTime() - query.maxAgeSeconds * 1000)
    const texts: string[] = []
    for (const row of await this.#recent(sinceMs, sender)) {
      // SQL bounds whole seconds for old rows; this keeps the cut-off exact.
      if (unixMs(row.date) < sinceMs) continue
      const text = row.text ?? (row.body === null ? null : attributedBodyText(row.body))
      if (text !== null) texts.push(text.slice(0, MAX_SCANNED_CHARS))
    }
    if (texts.length === 0) throw new CredentialError('not-found')
    // Newest first, so the first code-shaped capture is the newest code.
    const code = (await this.#matcher.captures(query.pattern, texts)).find(
      (capture): capture is string => capture !== null && CODE_SHAPE.test(capture),
    )
    if (code === undefined) throw new CredentialError('not-found')
    return SecretValue.fromString(code)
  }

  async #recent(sinceMs: number, sender: OtpSender): Promise<Row[]> {
    let db: DatabaseSync
    try {
      // Loaded on first use, so a runtime without node:sqlite can still import this package.
      const sqlite = await import('node:sqlite')
      db = new sqlite.DatabaseSync(this.#path, { readOnly: true, timeout: 1_000 })
    } catch {
      // SQLITE_CANTOPEN or SQLITE_AUTH: almost always missing Full Disk Access.
      throw new CredentialError('unavailable')
    }
    try {
      const sinceApple = BigInt(Math.floor(sinceMs - APPLE_EPOCH_MS))
      const statement = db.prepare(QUERY)
      statement.setReadBigInts(true)
      return statement.all(
        sinceApple * 1_000_000n,
        NANOSECOND_THRESHOLD,
        sinceApple / 1000n,
        sender.handle,
        `,${sender.services.join(',')},`,
        this.#limit,
      ) as unknown as Row[]
    } catch {
      // A schema we don't recognise, or a database locked past the timeout.
      throw new CredentialError('unavailable')
    } finally {
      db.close()
    }
  }
}

function unixMs(date: bigint): number {
  if (date >= NANOSECOND_THRESHOLD) return Number(date / 1_000_000n) + APPLE_EPOCH_MS
  return Number(date) * 1000 + APPLE_EPOCH_MS
}
