// Reading the audit log for the control panel: pages, run summaries, run traces, today's numbers.
// Everything here is built from the log's own events (each with fixed vocabularies and no page
// text), plus the in-memory previews of recent calls' input and output (RunMemory).

import { type FileHandle, open } from 'node:fs/promises'
import type { AuditEvent, AuditRecord, Purpose } from '@valet/core'
import { verifyAuditChain } from '@valet/runtime'
import type {
  AuditCategory,
  AuditPage,
  AuditQuery,
  ChainStatus,
  FillCheck,
  RunStats,
  RunSummary,
  RunTrace,
  TraceStep,
} from '../../shared/api'
import type { RunMemory } from './run-memory'

/**
 * The log's records, kept in memory and extended as it grows. The log is append-only, so each read
 * parses only the bytes after the last complete line it already has: an append costs its own size,
 * not the whole history's. The file is read from the start again on the first read, after verify(),
 * and when it is replaced or shrinks (a different inode, or a size below what was read). Lines that
 * don't parse are skipped here (verify reports them). A line still being written, with no newline
 * yet, waits for the next read.
 */
export class AuditReader {
  private list: AuditRecord[] = []
  /** Bytes consumed: up to and including the last newline read. */
  private offset = 0
  private identity: string | null = null
  /** Reads run one after another, so two never parse the same bytes. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  records(): Promise<readonly AuditRecord[]> {
    const read = this.queue.then(() => this.read())
    this.queue = read.catch(() => undefined)
    return read
  }

  private reset(identity: string | null): void {
    this.list = []
    this.offset = 0
    this.identity = identity
  }

  private async read(): Promise<readonly AuditRecord[]> {
    let handle: FileHandle
    try {
      handle = await open(this.path, 'r')
    } catch {
      this.reset(null)
      return this.list
    }
    try {
      const info = await handle.stat()
      const identity = `${info.dev}:${info.ino}`
      if (identity !== this.identity || info.size < this.offset) this.reset(identity)
      if (info.size === this.offset) return this.list
      const length = info.size - this.offset
      const bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, this.offset)
      // Only whole lines: UTF-8 never has a 0x0a byte inside a character.
      const end = bytes.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (end === -1) return this.list
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        const record = parseRecord(line)
        if (record !== null) this.list.push(record)
      }
      this.offset += end + 1
      return this.list
    } catch {
      return this.list
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  async verify(at: Date): Promise<ChainStatus> {
    const verifiedAt = at.toISOString()
    // The next read starts from the top, so an edit verify finds is reflected in the views too.
    const cleared = this.queue.then(() => this.reset(null))
    this.queue = cleared
    await cleared
    // The whole chain, through every archive rotation left (D27), not only the live file.
    const result = await verifyAuditChain(this.path)
    if (result.ok) {
      return {
        state: 'intact',
        records: result.records,
        headSeq: result.lastSeq,
        headHash: result.head,
        verifiedAt,
      }
    }
    return { state: 'broken', records: Math.max(0, result.seq - 1), firstBadSeq: result.seq, verifiedAt }
  }
}

function parseRecord(line: string): AuditRecord | null {
  if (line.length === 0) return null
  try {
    const value = JSON.parse(line) as AuditRecord
    if (
      typeof value.seq === 'number' &&
      typeof value.at === 'string' &&
      typeof value.event?.type === 'string'
    )
      return value
  } catch {
    // A torn or edited line; verify() names it.
  }
  return null
}

export const CATEGORY_TYPES: Readonly<Record<AuditCategory, readonly AuditEvent['type'][]>> = {
  'tool-calls': ['tool-called', 'call-waited', 'tool-finished'],
  logins: ['login-started', 'login-finished'],
  'secret-use': ['secret-used'],
  blocked: ['request-blocked', 'breaker-opened', 'breaker-closed'],
  confirmations: ['confirmation'],
  'approvals-grants': [
    'adapter-approved',
    'adapter-rejected',
    'adapter-installed',
    'adapter-activated',
    'adapter-refused',
    'grant-made',
    'grant-revoked',
    'grant-copied',
    'update-downloaded',
    'update-installed',
    'remote-state',
    'remote-tool',
    'setting-changed',
    'remote-consent',
    'remote-revoked',
    'remote-token-reuse',
    'lock-down',
    'site-paused',
  ],
}

function adapterOf(event: AuditEvent): string | null {
  return 'adapterId' in event ? event.adapterId : null
}

function searchText(event: AuditEvent): string {
  const parts: string[] = []
  if ('callId' in event && event.callId !== null) parts.push(event.callId)
  if ('tool' in event) parts.push(event.tool)
  if ('host' in event) parts.push(event.host)
  if ('target' in event) parts.push(event.target)
  return parts.join(' ').toLowerCase()
}

export const DEFAULT_PAGE = 50

export function auditPage(records: readonly AuditRecord[], query: AuditQuery): AuditPage {
  const since = query.since === undefined ? null : Date.parse(query.since)
  const needle = query.search?.trim().toLowerCase() ?? ''
  const matching = records.filter((record) => {
    const event = record.event
    if (query.category !== undefined && !CATEGORY_TYPES[query.category].includes(event.type)) return false
    if (query.adapterId !== undefined && adapterOf(event) !== query.adapterId) return false
    if (query.client !== undefined && !('client' in event && event.client === query.client)) return false
    if (query.clientId !== undefined && !('clientId' in event && event.clientId === query.clientId))
      return false
    if (since !== null && Date.parse(record.at) < since) return false
    if (needle.length > 0 && !searchText(event).includes(needle)) return false
    return true
  })
  const newestFirst = [...matching].sort((a, b) => b.seq - a.seq)
  const before = query.beforeSeq
  const page = before === undefined ? newestFirst : newestFirst.filter((r) => r.seq < before)
  const limit = query.limit ?? DEFAULT_PAGE
  const records_ = page.slice(0, limit)
  const last = records_.at(-1)
  return {
    records: records_,
    total: matching.length,
    nextBeforeSeq: page.length > limit && last !== undefined ? last.seq : null,
  }
}

export interface AdapterLookup {
  name(adapterId: string): string
  sideEffect(adapterId: string, tool: string): Purpose
  /** The selector a fill of this secret field types into, from the manifest. */
  fillSelector(adapterId: string, secret: string, field: string): string
}

interface CallRecords {
  called: AuditRecord & { readonly event: Extract<AuditEvent, { type: 'tool-called' }> }
  finished: (AuditRecord & { readonly event: Extract<AuditEvent, { type: 'tool-finished' }> }) | null
  related: AuditRecord[]
}

function byCall(records: readonly AuditRecord[]): Map<string, CallRecords> {
  const calls = new Map<string, CallRecords>()
  for (const record of records) {
    const event = record.event
    if (event.type === 'tool-called') {
      calls.set(event.callId, { called: record as CallRecords['called'], finished: null, related: [] })
      continue
    }
    const callId = 'callId' in event ? event.callId : null
    if (callId === null) continue
    const call = calls.get(callId)
    if (call === undefined) continue
    if (event.type === 'tool-finished') call.finished = record as NonNullable<CallRecords['finished']>
    else call.related.push(record)
  }
  return calls
}

function summaryOf(call: CallRecords, adapters: AdapterLookup, memory?: RunMemory): RunSummary {
  const { called, finished } = call
  const event = called.event
  const done = finished?.event
  return {
    callId: event.callId,
    adapterId: event.adapterId,
    adapterName: adapters.name(event.adapterId),
    tool: event.tool,
    sideEffect: adapters.sideEffect(event.adapterId, event.tool),
    client: event.client,
    startedAt: called.at,
    durationMs: done?.durationMs ?? null,
    outcome: done?.outcome ?? 'running',
    needsUser: done?.needsUser ?? null,
    stage: done?.stage ?? null,
    errorClass: done?.errorClass ?? null,
    blockedRequests: call.related.filter((r) => r.event.type === 'request-blocked').length,
    detail: memory?.get(event.callId)?.detail ?? null,
  }
}

export function runSummaries(
  records: readonly AuditRecord[],
  adapters: AdapterLookup,
  query: { readonly adapterId?: string; readonly limit?: number } = {},
  memory?: RunMemory,
): RunSummary[] {
  const list = [...byCall(records).values()]
    .filter((c) => query.adapterId === undefined || c.called.event.adapterId === query.adapterId)
    .sort((a, b) => b.called.seq - a.called.seq)
    .slice(0, query.limit ?? 100)
  return list.map((c) => summaryOf(c, adapters, memory))
}

const FILL_CHECKS: readonly FillCheck[] = [
  'frame-origin',
  'input-type',
  'input-reachable',
  'paced-keystrokes',
]

export function runTrace(
  records: readonly AuditRecord[],
  callId: string,
  adapters: AdapterLookup,
  memory: RunMemory,
  hashOf: (adapterId: string) => { readonly version: string; readonly hash: string },
): RunTrace | null {
  const call = byCall(records).get(callId)
  if (call === undefined) return null
  const summary = summaryOf(call, adapters, memory)
  const start = Date.parse(call.called.at)
  const offset = (record: AuditRecord) => Math.max(0, Date.parse(record.at) - start)
  const steps: TraceStep[] = [
    {
      atMs: 0,
      durationMs: null,
      stage: 'tool-input',
      type: 'called',
      client: summary.client,
      sideEffect: summary.sideEffect,
    },
  ]
  const secretsUsed: { secret: string; field: 'username' | 'password' | 'otp' }[] = []
  for (const record of call.related) {
    const event = record.event
    const atMs = offset(record)
    if (event.type === 'login-started')
      steps.push({ atMs, durationMs: null, stage: 'login', type: 'login-started' })
    if (event.type === 'secret-used') {
      const field = event.field === 'password' || event.field === 'otp' ? event.field : 'username'
      secretsUsed.push({ secret: event.secret, field })
      steps.push({
        atMs,
        durationMs: null,
        stage: 'secret-fill',
        type: 'secret-fill',
        selector: adapters.fillSelector(event.adapterId, event.secret, event.field),
        secret: event.secret,
        field,
        origin: event.origin,
        checks: field === 'password' ? [...FILL_CHECKS, 'form-action'] : FILL_CHECKS,
      })
    }
    if (event.type === 'request-blocked') {
      steps.push({
        atMs,
        durationMs: null,
        stage: 'request-surface',
        type: 'request',
        method: event.method,
        target: event.target,
        initiator: event.initiator,
        decision: 'blocked',
        purpose: null,
        status: null,
        blockedReason: blockReason(event.reason),
      })
    }
    if (event.type === 'confirmation') {
      steps.push({ atMs, durationMs: null, stage: 'confirm', type: 'confirmation', answer: event.answer })
    }
    if (event.type === 'call-waited') {
      // Recorded when the wait ended, so the step starts when it began.
      steps.push({
        atMs: Math.max(0, atMs - event.waitedMs),
        durationMs: event.waitedMs,
        stage: event.reason === 'queue' ? 'tool-input' : 'request-surface',
        type: 'waited',
        reason: event.reason,
        waitedMs: event.waitedMs,
        ahead: event.ahead ?? null,
      })
    }
  }
  const finished = call.finished
  if (finished !== null) {
    const atMs = offset(finished)
    const event = finished.event
    if (event.outcome === 'needsUser' && event.needsUser !== undefined) {
      steps.push({ atMs, durationMs: null, stage: 'login', type: 'needs-user', reason: event.needsUser })
    } else if (event.outcome !== 'ok' && event.errorClass !== undefined) {
      steps.push({
        atMs,
        durationMs: null,
        stage: event.stage ?? 'tool-run',
        type: 'failed',
        errorClass: event.errorClass,
      })
    }
  }
  const remembered = memory.get(callId)
  const outputBytes = summary.outcome === 'ok' ? (remembered?.outputBytes ?? null) : null
  if (summary.outcome === 'ok' && finished !== null) {
    steps.push({
      atMs: offset(finished),
      durationMs: null,
      stage: 'tool-output',
      type: 'output',
      redactions: remembered?.redactions ?? 0,
      bytes: outputBytes ?? 0,
    })
  }
  const version = hashOf(summary.adapterId)
  const blocked = steps.filter((s) => s.type === 'request').length
  return {
    summary,
    adapterVersion: version.version,
    adapterHash: call.called.event.adapterHash,
    secretsUsed,
    // The runtime audits the requests it refused, never the ones it let through or the probes.
    requests: { sent: null, probes: null, blocked },
    steps,
    input: remembered?.input ?? [{ kind: 'text', text: '(not kept: the app restarted since this call)' }],
    output: summary.outcome === 'ok' ? (remembered?.output ?? null) : null,
    outputBytes,
  }
}

const BLOCK_REASON_OF: Readonly<
  Record<string, NonNullable<Extract<TraceStep, { type: 'request' }>['blockedReason']>>
> = {
  'host-not-allowed': 'host-not-allowed',
  'undeclared-request': 'undeclared',
  'denied-path': 'denied-path',
  'ambiguous-path': 'ambiguous-path',
  'request-ceiling': 'request-ceiling',
  invalid: 'bad-url',
}

function blockReason(reason: string): Extract<TraceStep, { type: 'request' }>['blockedReason'] {
  return Object.hasOwn(BLOCK_REASON_OF, reason) ? (BLOCK_REASON_OF[reason] ?? null) : null
}

/** Answers that only told the client to call again: not calls the person would count. */
const RETRY_CLASSES: ReadonlySet<string> = new Set(['login-in-progress', 'busy'])

/** The calls that were answered "call again" (a login was running, or the site was busy). */
function retryAnswers(records: readonly AuditRecord[]): Set<string> {
  const ids = new Set<string>()
  for (const record of records) {
    const event = record.event
    if (
      event.type === 'tool-finished' &&
      event.outcome === 'failed' &&
      event.errorClass !== undefined &&
      RETRY_CLASSES.has(event.errorClass)
    )
      ids.add(event.callId)
  }
  return ids
}

/** Today's numbers, in the person's local day, with one bucket per hour so far. */
export function statsToday(records: readonly AuditRecord[], now: Date): RunStats {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const hours = now.getHours() + 1
  const hourly = {
    toolCalls: new Array<number>(hours).fill(0),
    logins: new Array<number>(hours).fill(0),
    blockedRequests: new Array<number>(hours).fill(0),
  }
  let toolCalls = 0
  let logins = 0
  let loginsFailed = 0
  let blockedRequests = 0
  const retries = retryAnswers(records)
  for (const record of records) {
    const at = new Date(record.at)
    if (Number.isNaN(at.getTime()) || at < midnight || at > now) continue
    const hour = at.getHours()
    const type = record.event.type
    if (type === 'tool-called') {
      if (retries.has(record.event.callId)) continue
      toolCalls++
      hourly.toolCalls[hour] = (hourly.toolCalls[hour] ?? 0) + 1
    } else if (type === 'login-finished') {
      logins++
      if (record.event.outcome !== 'ok') loginsFailed++
      hourly.logins[hour] = (hourly.logins[hour] ?? 0) + 1
    } else if (type === 'request-blocked') {
      blockedRequests++
      hourly.blockedRequests[hour] = (hourly.blockedRequests[hour] ?? 0) + 1
    }
  }
  return { toolCalls, logins, loginsFailed, blockedRequests, hourly }
}

/** Calls in the last seven days, per adapter and per adapter tool, leaving out "call again" answers. */
export function callCounts(records: readonly AuditRecord[], now: Date): Map<string, number> {
  const since = now.getTime() - 7 * 24 * 60 * 60_000
  const counts = new Map<string, number>()
  const retries = retryAnswers(records)
  for (const record of records) {
    if (record.event.type !== 'tool-called' || Date.parse(record.at) < since) continue
    if (retries.has(record.event.callId)) continue
    const { adapterId, tool } = record.event
    counts.set(adapterId, (counts.get(adapterId) ?? 0) + 1)
    counts.set(`${adapterId}/${tool}`, (counts.get(`${adapterId}/${tool}`) ?? 0) + 1)
  }
  return counts
}
