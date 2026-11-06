// Reads SMS one-time codes from the macOS Messages database. It needs Full Disk Access; without it
// the open fails and the reader reports `unavailable`. The database is opened read-only per lookup.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  CredentialError,
  type MessagesOtpQuery,
  type OtpReader,
  SecretValue,
  SiteAdapterError,
} from '@siteadapter/core'
import { attributedBodyText } from './typedstream'

export function defaultMessagesDbPath(): string {
  return join(homedir(), 'Library', 'Messages', 'chat.db')
}

export interface MessagesOtpReaderOptions {
  readonly path?: string
  readonly now?: () => Date
  /** How many recent inbound messages to consider. */
  readonly limit?: number
}

// Messages counts time from 2001-01-01 UTC (Core Data's reference date).
const APPLE_EPOCH_MS = 978_307_200_000
// Older databases store seconds, newer ones nanoseconds. Seconds won't reach 1e11 until the year 5170.
const NANOSECOND_THRESHOLD = 100_000_000_000n
const DEFAULT_LIMIT = 50
// Codes sit near the start of a message; the cap also bounds the work a pattern can do on long text.
const MAX_SCANNED_CHARS = 2_000

const QUERY = `
  SELECT m.text AS text, m.attributedBody AS body, m.date AS date
  FROM message m JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.is_from_me = 0
    AND (m.date >= ? OR (m.date < ? AND m.date >= ?))
    AND (? IS NULL OR instr(lower(h.id), lower(?)) > 0)
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

  constructor(options: MessagesOtpReaderOptions = {}) {
    this.#path = options.path ?? defaultMessagesDbPath()
    this.#now = options.now ?? (() => new Date())
    this.#limit = options.limit ?? DEFAULT_LIMIT
  }

  async latest(query: MessagesOtpQuery, notBefore: Date): Promise<SecretValue> {
    let pattern: RegExp
    try {
      pattern = new RegExp(query.pattern)
    } catch {
      throw new SiteAdapterError('otp', 'invalid')
    }
    const sinceMs = Math.max(notBefore.getTime(), this.#now().getTime() - query.maxAgeSeconds * 1000)
    for (const row of await this.#recent(sinceMs, query.sender ?? null)) {
      // SQL bounds whole seconds for old rows; this keeps the cut-off exact.
      if (unixMs(row.date) < sinceMs) continue
      const text = row.text ?? (row.body === null ? null : attributedBodyText(row.body))
      if (text === null) continue
      const match = pattern.exec(text.slice(0, MAX_SCANNED_CHARS))
      const code = match === null ? undefined : (match[1] ?? match[0])
      if (code !== undefined && code.length > 0) return SecretValue.fromString(code)
    }
    throw new CredentialError('not-found')
  }

  async #recent(sinceMs: number, sender: string | null): Promise<Row[]> {
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
        sender,
        sender,
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
