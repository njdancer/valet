// The audit log (docs/mockups/audit-log.html): hash-chained records with filters, chain
// verification, and a record inspector. Records are core's AuditRecord as written; the inspector
// shows only the fields core's audit format defines for each event type.

import type { AuditEvent, AuditRecord } from '@valet/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { AuditCategory, AuditPage, ChainStatus } from '../../shared/api'
import { highlight } from '../components/Preview'
import { ActionFailed, ClientName, Hash, Icon, OutcomePill } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatDuration, formatSeconds, formatTime, hostOf, tinyHash } from '../lib/format'
import { href } from '../lib/router'
import {
  blockedWording,
  errorWording,
  needsUserWording,
  PROVIDER_WORDING,
  stageWording,
} from '../lib/wording'

const CATEGORIES: readonly { readonly value: AuditCategory | 'all'; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'tool-calls', label: 'Tool calls' },
  { value: 'logins', label: 'Logins' },
  { value: 'secret-use', label: 'Secret use' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'confirmations', label: 'Confirmations' },
  { value: 'approvals-grants', label: 'Approvals & grants' },
]

const PERIODS = { any: null, today: 1, week: 7 } as const
type Period = keyof typeof PERIODS

const EVENT_CLASS: Readonly<Record<AuditEvent['type'], string>> = {
  'adapter-approved': 'admin',
  'adapter-rejected': 'admin',
  'grant-made': 'admin',
  'grant-revoked': 'admin',
  'grant-copied': 'admin',
  'tool-called': 'tool',
  'tool-finished': 'tool',
  'login-started': 'login',
  'login-finished': 'login',
  'secret-used': 'secret',
  'request-blocked': 'blocked',
  'breaker-opened': 'blocked',
  'breaker-closed': 'login',
  'update-downloaded': 'admin',
  'update-installed': 'admin',
  confirmation: 'confirm',
}

export function AuditLogPage() {
  const api = useApi()
  const now = useNow(60_000)
  const [category, setCategory] = useState<AuditCategory | 'all'>('all')
  const [adapterId, setAdapterId] = useState('')
  const [client, setClient] = useState('')
  const [period, setPeriod] = useState<Period>('week')
  const [search, setSearch] = useState('')
  const [older, setOlder] = useState<Older>({ head: null, records: [], next: null })
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const verify = useAction()
  const more = useAction()
  const exporting = useAction()
  const [verified, setVerified] = useState<ChainStatus | null>(null)
  const [appendedSeq, setAppendedSeq] = useState<number | null>(null)

  // A record appended after Verify ran isn't covered by it: drop the result so the callout shows the
  // main process's last verification, and remember how far the log now goes.
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type !== 'audit-appended') return
        setVerified(null)
        setAppendedSeq((seq) => Math.max(seq ?? 0, event.seq))
      }),
    [api],
  )

  const adapters = useLoad((a) => a.adapters.list(), [], ['adapters-changed'])
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const chain = useLoad((a) => a.audit.chainStatus(), [], ['audit-appended', 'audit-verified'])
  const days = PERIODS[period]
  const query = {
    ...(category === 'all' ? {} : { category }),
    ...(adapterId === '' ? {} : { adapterId }),
    ...(client === '' ? {} : { clientId: client }),
    ...(days === null ? {} : { since: new Date(now - days * 86_400_000).toISOString() }),
    ...(search.trim() === '' ? {} : { search: search.trim() }),
    limit: 50,
  }
  // `since` moves with the clock; the key holds the period instead, so the page doesn't reload every minute.
  const queryKey = JSON.stringify({ ...query, since: days })
  const page = useLoad((a) => a.audit.page(query), [queryKey], ['audit-appended'])

  // Older pages belong to the head page they were loaded under. A new head page (a filter change,
  // or a record appended, which shifts every page by one) starts from its own cursor again.
  const head = page.status === 'ready' ? page.data : null
  const paged: Older =
    head !== null && older.head === head ? older : { head, records: [], next: head?.nextBeforeSeq ?? null }
  const records = head === null ? [] : [...head.records, ...paged.records]
  const selected = records.find((r) => r.seq === selectedSeq) ?? records[0] ?? null
  const status = verified ?? (chain.status === 'ready' ? chain.data : null)
  const newestSeq = Math.max(appendedSeq ?? 0, ...(head?.records.map((r) => r.seq) ?? []))

  const loading = useRef(false)
  const loadMore = (from: AuditPage, cursor: number) => {
    if (loading.current) return
    loading.current = true
    void more
      .run(async () => {
        const next = await api.audit.page({ ...query, beforeSeq: cursor })
        setOlder((current) => {
          const base: Older =
            current.head === from ? current : { head: from, records: [], next: from.nextBeforeSeq }
          // Another load already moved past this cursor: keep what it found.
          if (base.next !== cursor) return base
          const seen = new Set([...from.records, ...base.records].map((r) => r.seq))
          return {
            head: from,
            records: [...base.records, ...next.records.filter((r) => !seen.has(r.seq))],
            next: next.nextBeforeSeq,
          }
        })
      })
      .finally(() => {
        loading.current = false
      })
  }

  return (
    <>
      <div className="titlebar">
        <div>
          <div className="title">Audit log</div>
          <div className="subtitle">
            {page.status === 'ready'
              ? `${page.data.total.toLocaleString('en-AU')} records · append-only`
              : 'append-only'}
          </div>
        </div>
        <div className="tools">
          <label className="search">
            <Icon name="search" size="sm" />
            <span className="sr-only">Search the audit log</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Call ID, tool, host…"
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={verify.busy}
            onClick={() =>
              verify.run(async () => {
                setVerified(await api.audit.verify())
              })
            }
          >
            <Icon name="refresh" size="sm" />
            {verify.busy ? 'Verifying…' : 'Verify chain'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={exporting.busy}
            onClick={() => exporting.run(() => api.audit.exportJsonl())}
          >
            <Icon name="download" size="sm" />
            Export JSONL
          </button>
        </div>
      </div>

      <div style={{ margin: 'var(--space-3) var(--space-5) 0' }}>
        {status !== null ? <ChainCallout status={status} now={now} newestSeq={newestSeq} /> : null}
        <ActionFailed failed={verify.failed} what="verify the chain" />
        <ActionFailed failed={exporting.failed} what="export the log" />
      </div>

      <div className="filterbar" style={{ borderBottom: 0, paddingTop: 'var(--space-3)' }}>
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            type="button"
            className="chip"
            aria-pressed={category === c.value}
            onClick={() => setCategory(c.value)}
          >
            {c.label}
          </button>
        ))}
        <span className="grow" />
        <select
          className="select"
          aria-label="Adapter"
          value={adapterId}
          onChange={(e) => setAdapterId(e.target.value)}
        >
          <option value="">Any adapter</option>
          {adapters.status === 'ready'
            ? adapters.data.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))
            : null}
        </select>
        <select
          className="select"
          aria-label="Client"
          value={client}
          onChange={(e) => setClient(e.target.value)}
        >
          <option value="">Any client</option>
          {clients.status === 'ready'
            ? clients.data.map((c) => (
                <option key={c.id} value={`local:${c.id}`}>
                  {c.name}
                </option>
              ))
            : null}
        </select>
        <select
          className="select"
          aria-label="Period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
        >
          <option value="today">Today</option>
          <option value="week">Last 7 days</option>
          <option value="any">Any time</option>
        </select>
      </div>

      <div className="body audit-page" style={{ borderTop: '0.5px solid var(--border)' }}>
        <div className="log">
          {page.status === 'loading' ? <div className="empty">Loading the audit log…</div> : null}
          {page.status === 'error' ? (
            <div className="empty" role="alert">
              Couldn’t read the audit log.
            </div>
          ) : null}
          {page.status === 'ready' ? (
            records.length === 0 ? (
              <div className="empty">No records match.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">Seq</th>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Details</th>
                    <th>Call</th>
                    <th>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr
                      key={record.seq}
                      className={
                        record.seq === selected?.seq
                          ? 'selected'
                          : record.event.type === 'request-blocked' || record.event.type === 'breaker-opened'
                            ? 'alert'
                            : ''
                      }
                    >
                      <td className="num mono xs">
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ height: 'auto', padding: 0, color: 'inherit', font: 'inherit' }}
                          aria-label={`Show record ${record.seq}`}
                          onClick={() => setSelectedSeq(record.seq)}
                        >
                          {record.seq}
                        </button>
                      </td>
                      <td className="xs">{formatSeconds(record.at, now)}</td>
                      <td>
                        <span className={`ev ${EVENT_CLASS[record.event.type] ?? 'login'}`}>
                          {record.event.type}
                        </span>
                      </td>
                      <td>{details(record.event, now)}</td>
                      <td className="mono xs">
                        {'callId' in record.event && record.event.callId !== null ? record.event.callId : '—'}
                      </td>
                      <td className="mono xs tertiary">{hashText(record.hash)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
          {head !== null && paged.next !== null ? (
            <div className="empty">
              <button
                type="button"
                className="btn"
                disabled={more.busy}
                onClick={() => paged.next !== null && loadMore(head, paged.next)}
              >
                {more.busy ? 'Loading…' : 'Load older records'}
              </button>
              <ActionFailed failed={more.failed} what="load older records" />
            </div>
          ) : null}
        </div>

        {selected !== null ? <Inspector record={selected} records={records} status={status} /> : null}
      </div>
    </>
  )
}

/** Older records loaded under one head page, and the cursor for the next page (null: no more). */
interface Older {
  readonly head: AuditPage | null
  readonly records: readonly AuditRecord[]
  readonly next: number | null
}

function ChainCallout({
  status,
  now,
  newestSeq,
}: {
  readonly status: ChainStatus
  readonly now: number
  readonly newestSeq: number
}) {
  if (status.state === 'broken') {
    return (
      <div className="callout bad" role="alert" style={{ alignItems: 'center' }}>
        <Icon name="warn" />
        <div className="grow">
          <strong>Chain broken at record {status.firstBadSeq}.</strong> That record’s hash doesn’t match its
          contents or the record before it, so it, and every record after it, may have been edited. Checked{' '}
          {status.records.toLocaleString('en-AU')} records at {formatTime(status.verifiedAt, now)}. Export the
          log and keep the copy.
        </div>
      </div>
    )
  }
  if (status.state === 'unverified') {
    return (
      <div className="callout" style={{ alignItems: 'center' }}>
        <Icon name="shield" />
        <div className="grow">
          <strong>Not verified yet.</strong> Verify the chain to check every record against the one before it.
        </div>
      </div>
    )
  }
  return (
    <div className="callout ok" style={{ alignItems: 'center' }}>
      <Icon name="shield" />
      <div className="grow">
        <strong>Chain intact up to record {status.headSeq}.</strong> All{' '}
        {status.records.toLocaleString('en-AU')} records to there verified at{' '}
        {formatTime(status.verifiedAt, now)}.{' '}
        {newestSeq > status.headSeq ? (
          <>
            <strong>Records after {status.headSeq} were appended since and aren’t checked yet.</strong>{' '}
          </>
        ) : null}
        Each hash covers the record before it, so an edit to an earlier record shows up. Deleting the newest
        records, or rewriting the whole log, needs an external anchor to detect (planned).
      </div>
      <span className="mono xs muted">head {tinyHash(status.headHash)}</span>
    </div>
  )
}

/** One line per event, from structured fields only. */
export function details(event: AuditEvent, now: number): ReactNode {
  switch (event.type) {
    case 'adapter-approved':
      return (
        <>
          {event.adapterId} {event.version} <Hash hash={event.adapterHash} />
          {event.previousHash === null ? <span className="xs muted"> first install</span> : null}
        </>
      )
    case 'adapter-rejected':
      return (
        <>
          {event.adapterId} {event.version} <Hash hash={event.adapterHash} />{' '}
          <span className="pill">rejected</span>
        </>
      )
    case 'grant-made':
      return (
        <>
          {event.secret} →{' '}
          {Object.hasOwn(PROVIDER_WORDING, event.provider)
            ? PROVIDER_WORDING[event.provider as keyof typeof PROVIDER_WORDING].title
            : event.provider}{' '}
          · for <Hash hash={event.adapterHash} /> on{' '}
          <span className="mono xs">{event.origins.map(hostOf).join(', ')}</span>
        </>
      )
    case 'grant-copied':
      return (
        <>
          {event.adapterId} · {event.secret} <span className="xs muted">copied from 1Password</span>
        </>
      )
    case 'grant-revoked':
      return (
        <>
          {event.adapterId} · {event.secret} <span className="xs muted">revoked</span>
        </>
      )
    case 'tool-called':
      return (
        <>
          <span className="mono xs">{event.tool}</span> · <ClientName reported={event.client} />
        </>
      )
    case 'tool-finished':
      return (
        <>
          <OutcomePill outcome={event.outcome} />{' '}
          <span className="xs muted">
            {event.needsUser !== undefined ? `${needsUserWording(event.needsUser).short} · ` : ''}
            {event.stage !== undefined && event.errorClass !== undefined
              ? `${stageWording(event.stage)} / ${errorWording(event.errorClass)} · `
              : ''}
            {formatDuration(event.durationMs)}
          </span>
        </>
      )
    case 'login-started':
      return (
        <span className="muted">
          {event.callId === null ? 'Started from the app' : 'Started by a tool call'}
        </span>
      )
    case 'login-finished':
      return (
        <>
          <OutcomePill outcome={event.outcome} />{' '}
          {event.needsUser !== undefined ? (
            <span className="xs muted">{needsUserWording(event.needsUser).short}</span>
          ) : null}
          {event.stage !== undefined && event.errorClass !== undefined ? (
            <span className="xs muted">
              {stageWording(event.stage)} / {errorWording(event.errorClass)}
            </span>
          ) : null}
        </>
      )
    case 'secret-used':
      return (
        <>
          {event.secret}.{event.field} · <span className="mono xs">{hostOf(event.origin)}</span>
        </>
      )
    case 'request-blocked':
      return (
        <>
          {event.method} <span className="mono xs">{event.target}</span>{' '}
          <span className="xs muted">
            {event.initiator === 'page' ? 'page · ' : ''}
            {isBlockedReason(event.reason) ? blockedWording(event.reason) : 'blocked'}
          </span>
        </>
      )
    case 'breaker-opened':
      return (
        <>
          <span className="mono xs">{event.host}</span>{' '}
          <span className="xs muted">
            {event.cause === 'rate-limited' ? 'rate limited' : 'blocked by site'} · until{' '}
            {formatTime(event.retryAt, now)}
          </span>
        </>
      )
    case 'breaker-closed':
      return (
        <>
          <span className="mono xs">{event.host}</span> <span className="xs muted">calls allowed again</span>
        </>
      )
    case 'confirmation':
      return (
        <>
          <span className="mono xs">{event.tool}</span> ·{' '}
          <span className={`pill ${event.answer === 'approved' ? 'ok' : ''}`}>{event.answer}</span>{' '}
          <span className="xs muted">
            <ClientName reported={event.client} />
          </span>
        </>
      )
  }
}

const BLOCKED_REASONS = new Set([
  'host-not-allowed',
  'undeclared',
  'denied-path',
  'ambiguous-path',
  'purpose-exceeded',
  'request-ceiling',
  'bad-url',
])

function isBlockedReason(reason: string): reason is Parameters<typeof blockedWording>[0] {
  return BLOCKED_REASONS.has(reason)
}

/**
 * The fields core's AuditEvent defines, per type. The inspector and Copy record show these and
 * nothing else, so a field the main process should never have written can't reach the screen.
 */
const EVENT_FIELDS = {
  'adapter-approved': ['type', 'adapterId', 'adapterHash', 'version', 'previousHash'],
  'adapter-rejected': ['type', 'adapterId', 'adapterHash', 'version'],
  'grant-made': ['type', 'adapterId', 'adapterHash', 'secret', 'provider', 'origins'],
  'grant-revoked': ['type', 'adapterId', 'secret'],
  'grant-copied': ['type', 'adapterId', 'secret', 'fields'],
  'tool-called': ['type', 'adapterId', 'adapterHash', 'tool', 'client', 'clientId', 'callId'],
  'tool-finished': [
    'type',
    'adapterId',
    'callId',
    'outcome',
    'needsUser',
    'stage',
    'errorClass',
    'durationMs',
  ],
  'login-started': ['type', 'adapterId', 'callId'],
  'login-finished': ['type', 'adapterId', 'outcome', 'needsUser', 'stage', 'errorClass'],
  'secret-used': ['type', 'adapterId', 'adapterHash', 'secret', 'field', 'origin', 'callId'],
  'request-blocked': ['type', 'adapterId', 'method', 'target', 'reason', 'initiator', 'partition', 'callId'],
  'breaker-opened': ['type', 'host', 'cause', 'retryAt', 'callId'],
  'breaker-closed': ['type', 'host'],
  'update-downloaded': ['type', 'from', 'to'],
  'update-installed': ['type', 'from', 'to'],
  confirmation: ['type', 'adapterId', 'tool', 'client', 'callId', 'answer'],
} as const satisfies {
  readonly [K in AuditEvent['type']]: readonly (keyof Extract<AuditEvent, { readonly type: K }>)[]
}

type Shown = string | number | boolean | null | readonly string[]

/** A field's value if it is the kind core writes (a scalar or a list of strings), else a placeholder. */
function shownValue(value: unknown): Shown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value as Shown
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  return '[not shown]'
}

/** A short hash for display; anything that isn't a hash string shows as "?" rather than crashing. */
function hashText(value: unknown, chars?: number): string {
  if (typeof value !== 'string') return '?'
  return chars === undefined ? tinyHash(value) : `${value.slice(0, chars)}…`
}

/** The record with only the fields core's audit format defines. */
export function shownRecord(record: AuditRecord): Record<string, unknown> {
  const type = record.event.type
  const fields: readonly string[] = Object.hasOwn(EVENT_FIELDS, type) ? EVENT_FIELDS[type] : ['type']
  const event = record.event as unknown as Record<string, unknown>
  const shown: Record<string, Shown> = {}
  for (const field of fields) {
    if (Object.hasOwn(event, field) && event[field] !== undefined) shown[field] = shownValue(event[field])
  }
  return {
    seq: shownValue(record.seq),
    at: shownValue(record.at),
    event: shown,
    prev: shownValue(record.prev),
    hash: shownValue(record.hash),
  }
}

function Inspector({
  record,
  records,
  status,
}: {
  readonly record: AuditRecord
  readonly records: readonly AuditRecord[]
  readonly status: ChainStatus | null
}) {
  const api = useApi()
  const copy = useAction()
  const text = JSON.stringify(shownRecord(record), null, 2)
  const previous = records.find((r) => r.seq === record.seq - 1)
  const next = records.find((r) => r.seq === record.seq + 1)
  const suspect = status?.state === 'broken' && record.seq >= status.firstBadSeq
  const adapterId = 'adapterId' in record.event ? record.event.adapterId : null
  return (
    <aside
      className="inspector stack gap-3"
      style={{ alignContent: 'start', overflowY: 'auto' }}
      aria-label="Record"
    >
      <div className="row between">
        <span className="h3">Record {record.seq}</span>
        {suspect ? (
          <span className="pill bad">After the break</span>
        ) : status?.state === 'intact' && record.seq <= status.headSeq ? (
          <span className="pill ok">
            <Icon name="check" size="sm" />
            In verified chain
          </span>
        ) : status?.state === 'intact' ? (
          <span className="pill">Appended since the last check</span>
        ) : null}
      </div>
      <pre className="code raw" style={{ fontSize: 10.5, lineHeight: 1.5, padding: '10px 12px' }}>
        {highlight(text)}
      </pre>
      <div className="callout secret" style={{ padding: '8px 10px' }}>
        <Icon name="eye-off" />
        <div className="xs">
          Grants record the provider, never the 1Password item reference. Secret values are never written
          here.
        </div>
      </div>
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Chain
        </div>
        <div className="chain">
          <div className="block">
            <strong>{previous?.seq ?? record.seq - 1}</strong>
            {previous !== undefined ? hashText(previous.hash) : '…'}
          </div>
          <span className="link" />
          <div className="block on">
            <strong>{record.seq}</strong>prev {hashText(record.prev, 4)}
            <br />
            {hashText(record.hash)}
          </div>
          <span className="link" />
          <div className="block">
            <strong>{next?.seq ?? record.seq + 1}</strong>
            {next !== undefined ? (
              <>
                prev {hashText(next.prev, 4)}
                <br />
                {hashText(next.hash)}
              </>
            ) : (
              '…'
            )}
          </div>
        </div>
      </div>
      <div className="row">
        {adapterId !== null ? (
          <a className="btn" href={href.adapter(adapterId)}>
            Open adapter
          </a>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={copy.busy}
          onClick={() => copy.run(() => api.app.copyText(text))}
        >
          <Icon name="copy" size="sm" />
          Copy record
        </button>
      </div>
      <ActionFailed failed={copy.failed} what="copy the record" />
    </aside>
  )
}
