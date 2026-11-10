// The audit log: append-only JSONL where each record carries the hash of the one before it, so an
// edit, deletion or reordering anywhere breaks the chain. Truncating the tail is only detectable
// against a head hash kept elsewhere; see verifyAuditLog's `expectedHead`.
//
// Rotation (D27): the log is never deleted. Once the live file (audit.jsonl) reaches maxBytes, it is
// renamed to the next archive (audit.0001.jsonl, audit.0002.jsonl, …) and a new live file begins.
// Its first record's `prev` is the archive's last hash and its `seq` carries on, so the chain runs
// unbroken across files; verifyAuditChain follows it. Removing an archive, or the live file's start,
// breaks the chain at the next file.

import { type FileHandle, open, readdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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

/** The live file's size at which it is rotated before the next append. */
export const DEFAULT_ROTATE_BYTES = 16 * 1024 * 1024

export interface AuditLogOptions {
  /** Rotate once the live file is at least this big. */
  readonly maxBytes?: number
}

export class AuditLog implements AuditSink {
  private head: { readonly seq: number; readonly hash: string } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly maxBytes: number

  constructor(
    private readonly path: string,
    private readonly clock: Clock,
    private readonly openFile: OpenForAppend = openForAppend,
    options: AuditLogOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_ROTATE_BYTES
  }

  /** Appends one record. Writes are serialised, so records land in the order `append` was called. */
  append(event: AuditEvent): Promise<AuditRecord> {
    const written = this.queue.then(() => this.write(event))
    this.queue = written.catch(() => undefined)
    return written
  }

  /**
   * Moves the live file to the next archive now, if it holds any record. Resolves to the archive's
   * path, or null when there was nothing to rotate. Serialised with appends.
   */
  rotate(): Promise<string | null> {
    const rotated = this.queue.then(() => this.rotateNow(0))
    this.queue = rotated.catch(() => undefined)
    return rotated
  }

  private async rotateNow(minBytes: number): Promise<string | null> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    }
    if (size === 0 || size < minBytes) return null
    // Only an intact file is archived: the head check refuses a broken one, which fails closed.
    const head = this.head ?? (await this.readHead())
    const archives = await archivePaths(this.path)
    const next = archivePath(
      this.path,
      archives.length === 0 ? 1 : archiveNumber(archives.at(-1) as string) + 1,
    )
    await rename(this.path, next)
    this.head = head
    return next
  }

  private async write(event: AuditEvent): Promise<AuditRecord> {
    await this.rotateNow(this.maxBytes)
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

  // Appending to a log whose chain is already broken would launder the break, so refuse. The live
  // file is checked in full, from where the newest archive ends; the archives themselves were
  // checked when they were rotated, and verifyAuditChain checks them all.
  private async readHead(): Promise<{ seq: number; hash: string }> {
    const start = await archiveTail(this.path)
    if (start === null) throw new ValetError('tool-run', 'internal')
    const verification = await verifyAuditLog(this.path, { start })
    if (!verification.ok) throw new ValetError('tool-run', 'internal')
    return { seq: verification.lastSeq, hash: verification.head }
  }
}

/** Where a file's chain begins: the seq and hash of the record before its first. */
export interface ChainStart {
  readonly seq: number
  readonly prev: string
}

const GENESIS: ChainStart = { seq: 0, prev: GENESIS_HASH }

export type AuditProblem = 'malformed' | 'sequence' | 'chain' | 'hash' | 'head-mismatch'

export type AuditVerification =
  | {
      readonly ok: true
      /** Records in this file. */
      readonly records: number
      readonly head: string
      /** The last record's seq (the start's seq when the file is empty). */
      readonly lastSeq: number
    }
  | {
      readonly ok: false
      /** 1-based line number of the first bad record, or records + 1 for a head mismatch. */
      readonly line: number
      readonly problem: AuditProblem
    }

/**
 * Checks every record's sequence number, back-link and hash. Pass `expectedHead` (a hash recorded
 * outside the log) to also detect records removed from the end, or the whole file being replaced.
 * `start` is where the file's chain begins: the genesis for the first file, else the end of the
 * archive before it.
 */
export async function verifyAuditLog(
  path: string,
  options: { readonly expectedHead?: string; readonly start?: ChainStart } = {},
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
  const start = options.start ?? GENESIS
  let prev = start.prev
  for (const [index, line] of lines.entries()) {
    const record = parseRecord(line)
    if (record === null) return { ok: false, line: index + 1, problem: 'malformed' }
    if (record.seq !== start.seq + index + 1) return { ok: false, line: index + 1, problem: 'sequence' }
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
  return { ok: true, records: lines.length, head: prev, lastSeq: start.seq + lines.length }
}

export type AuditChainVerification =
  | {
      readonly ok: true
      /** Records across every file. */
      readonly records: number
      /** Archives plus the live file. */
      readonly files: number
      readonly head: string
      readonly lastSeq: number
    }
  | {
      readonly ok: false
      /** The file the chain breaks in. */
      readonly file: string
      readonly line: number
      /** The seq the bad record should have had. */
      readonly seq: number
      readonly problem: AuditProblem | 'empty-archive'
    }

/**
 * Verifies the whole log: each archive beside `livePath`, oldest first, then the live file, each
 * starting where the one before it ended. A missing live file after archives is a log that has just
 * rotated; `expectedHead` still catches records lost from the end.
 */
export async function verifyAuditChain(
  livePath: string,
  options: { readonly expectedHead?: string } = {},
): Promise<AuditChainVerification> {
  const archives = await archivePaths(livePath)
  let start = GENESIS
  let records = 0
  let liveRecords = 0
  for (const file of [...archives, livePath]) {
    const result = await verifyAuditLog(file, { start })
    if (!result.ok)
      return { ok: false, file, line: result.line, seq: start.seq + result.line, problem: result.problem }
    if (result.records === 0 && file !== livePath) {
      return { ok: false, file, line: 1, seq: start.seq + 1, problem: 'empty-archive' }
    }
    records += result.records
    liveRecords = result.records
    start = { seq: result.lastSeq, prev: result.head }
  }
  if (options.expectedHead !== undefined && options.expectedHead !== start.prev) {
    return { ok: false, file: livePath, line: liveRecords + 1, seq: start.seq + 1, problem: 'head-mismatch' }
  }
  return { ok: true, records, files: archives.length + 1, head: start.prev, lastSeq: start.seq }
}

const ARCHIVE_DIGITS = 4

/** The archive files beside `livePath` (audit.jsonl → audit.0001.jsonl, …), oldest first. */
export async function archivePaths(livePath: string): Promise<string[]> {
  const dir = dirname(livePath)
  const stem = basename(livePath, '.jsonl')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return []
    throw error
  }
  const numbered = names
    .filter((name) => name.startsWith(`${stem}.`) && name.endsWith('.jsonl'))
    .map((name) => ({ name, number: name.slice(stem.length + 1, -'.jsonl'.length) }))
    .filter((entry) => new RegExp(`^\\d{${ARCHIVE_DIGITS},}$`).test(entry.number))
  return numbered.sort((a, b) => Number(a.number) - Number(b.number)).map((entry) => join(dir, entry.name))
}

function archivePath(livePath: string, n: number): string {
  return join(
    dirname(livePath),
    `${basename(livePath, '.jsonl')}.${String(n).padStart(ARCHIVE_DIGITS, '0')}.jsonl`,
  )
}

function archiveNumber(path: string): number {
  return Number(/\.(\d+)\.jsonl$/.exec(path)?.[1] ?? 0)
}

/**
 * Where the live file's chain begins: the genesis without archives, else the newest archive's last
 * record (its own hash checked). Null when that archive doesn't end in a well-formed record.
 */
async function archiveTail(livePath: string): Promise<ChainStart | null> {
  const archives = await archivePaths(livePath)
  const newest = archives.at(-1)
  if (newest === undefined) return GENESIS
  const text = await readFile(newest, 'utf8')
  if (!text.endsWith('\n')) return null
  const last = parseRecord(text.slice(text.lastIndexOf('\n', text.length - 2) + 1, -1))
  if (last === null || last.hash !== recordHash(last.seq, last.at, last.event, last.prev)) return null
  return { seq: last.seq, prev: last.hash }
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
