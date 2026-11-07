// The audit log: append-only JSONL where each record carries the hash of the one before it, so an
// edit, deletion or reordering anywhere breaks the chain. Truncating the tail is only detectable
// against a head hash kept elsewhere; see verifyAuditLog's `expectedHead`.

import { type FileHandle, open, readFile } from 'node:fs/promises'
import {
  type AuditEvent,
  type AuditRecord,
  type AuditSink,
  canonicalJson,
  sha256Hex,
  ValetError,
} from '@valet/core'
import type { Clock } from './clock'
import { isErrno } from './files'

/** The `prev` of the first record. */
export const GENESIS_HASH = '0'.repeat(64)

const RECORD_KEYS = ['at', 'event', 'hash', 'prev', 'seq'].join(',')

export function recordHash(seq: number, at: string, event: AuditEvent, prev: string): string {
  return sha256Hex(canonicalJson({ seq, at, event, prev }))
}

/** Opens the log for appending. Injected so tests can make writes fail part way. */
export type OpenForAppend = (path: string) => Promise<FileHandle>

const openForAppend: OpenForAppend = (path) => open(path, 'a', 0o600)

export class AuditLog implements AuditSink {
  private head: { readonly seq: number; readonly hash: string } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly clock: Clock,
    private readonly openFile: OpenForAppend = openForAppend,
  ) {}

  /** Appends one record. Writes are serialised, so records land in the order `append` was called. */
  append(event: AuditEvent): Promise<AuditRecord> {
    const written = this.queue.then(() => this.write(event))
    this.queue = written.catch(() => undefined)
    return written
  }

  private async write(event: AuditEvent): Promise<AuditRecord> {
    const head = this.head ?? (await this.readHead())
    const seq = head.seq + 1
    const at = new Date(this.clock.now()).toISOString()
    const prev = head.hash
    const record: AuditRecord = { seq, at, event, prev, hash: recordHash(seq, at, event, prev) }
    // Forget the cached head before touching the file: if this write fails part way, the next
    // append must re-read and verify the file rather than chain onto what we assumed was there.
    this.head = null
    const handle = await this.openFile(this.path)
    try {
      const { size } = await handle.stat()
      try {
        await handle.appendFile(`${canonicalJson(record)}\n`, 'utf8')
        await handle.sync()
      } catch (error) {
        // A torn or unsynced line would break the chain for good; cut back to the last good record.
        // If even that fails, the next append's verification refuses, which fails closed.
        await handle
          .truncate(size)
          .then(() => handle.sync())
          .catch(() => undefined)
        throw error
      }
    } finally {
      await handle.close()
    }
    this.head = { seq, hash: record.hash }
    return record
  }

  // Appending to a log whose chain is already broken would launder the break, so refuse.
  private async readHead(): Promise<{ seq: number; hash: string }> {
    const verification = await verifyAuditLog(this.path)
    if (!verification.ok) throw new ValetError('tool-run', 'internal')
    return { seq: verification.records, hash: verification.head }
  }
}

export type AuditVerification =
  | { readonly ok: true; readonly records: number; readonly head: string }
  | {
      readonly ok: false
      /** 1-based line number of the first bad record, or records + 1 for a head mismatch. */
      readonly line: number
      readonly problem: 'malformed' | 'sequence' | 'chain' | 'hash' | 'head-mismatch'
    }

/**
 * Checks every record's sequence number, back-link and hash. Pass `expectedHead` (a hash recorded
 * outside the log) to also detect records removed from the end, or the whole file being replaced.
 */
export async function verifyAuditLog(
  path: string,
  options: { readonly expectedHead?: string } = {},
): Promise<AuditVerification> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
    text = ''
  }
  const lines = text.split('\n')
  // A complete log ends in a newline; anything after the last one is a torn write.
  const trailing = lines.pop()
  let prev = GENESIS_HASH
  for (const [index, line] of lines.entries()) {
    const record = parseRecord(line)
    if (record === null) return { ok: false, line: index + 1, problem: 'malformed' }
    if (record.seq !== index + 1) return { ok: false, line: index + 1, problem: 'sequence' }
    if (record.prev !== prev) return { ok: false, line: index + 1, problem: 'chain' }
    if (record.hash !== recordHash(record.seq, record.at, record.event, record.prev)) {
      return { ok: false, line: index + 1, problem: 'hash' }
    }
    prev = record.hash
  }
  if (trailing !== undefined && trailing.length > 0) {
    return { ok: false, line: lines.length + 1, problem: 'malformed' }
  }
  if (options.expectedHead !== undefined && options.expectedHead !== prev) {
    return { ok: false, line: lines.length + 1, problem: 'head-mismatch' }
  }
  return { ok: true, records: lines.length, head: prev }
}

function parseRecord(line: string): AuditRecord | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== RECORD_KEYS) return null
  const { seq, at, event, prev, hash } = record
  if (typeof seq !== 'number' || !Number.isInteger(seq)) return null
  if (typeof at !== 'string' || typeof prev !== 'string' || typeof hash !== 'string') return null
  if (event === null || typeof event !== 'object') return null
  return { seq, at, event: event as AuditEvent, prev, hash }
}
