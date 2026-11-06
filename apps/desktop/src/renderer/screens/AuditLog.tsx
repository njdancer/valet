// The audit log (docs/mockups/audit-log.html): hash-chained records with filters, chain
// verification, and a record inspector. Records are core's AuditRecord as written.

import type { AuditEvent, AuditRecord } from '@siteadapter/core'
import { type ReactNode, useEffect, useState } from 'react'
import type { AuditCategory, AuditPage, ChainStatus } from '../../shared/api'
import { highlight } from '../components/Preview'
import { ActionFailed, Hash, Icon, OutcomePill } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatDuration, formatSeconds, formatTime, hostOf, tinyHash } from '../lib/format'
import { href } from '../lib/router'
import {
  blockedWording,
  clientLabel,
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
  'tool-called': 'tool',
  'tool-finished': 'tool',
  'login-started': 'login',
  'login-finished': 'login',
  'secret-used': 'secret',
  'request-blocked': 'blocked',
  'breaker-opened': 'blocked',
  'breaker-closed': 'login',
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
  const [older, setOlder] = useState<readonly AuditRecord[]>([])
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const verify = useAction()
  const [verified, setVerified] = useState<ChainStatus | null>(null)

  const adapters = useLoad((a) => a.adapters.list(), [], ['adapters-changed'])
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const chain = useLoad((a) => a.audit.chainStatus(), [], ['audit-appended'])
  const days = PERIODS[period]
  const query = {
    ...(category === 'all' ? {} : { category }),
    ...(adapterId === '' ? {} : { adapterId }),
    ...(client === '' ? {} : { client }),
    ...(days === null ? {} : { since: new Date(now - days * 86_400_000).toISOString() }),
    ...(search.trim() === '' ? {} : { search: search.trim() }),
    limit: 50,
  }
  // `since` moves with the clock; the key holds the period instead, so the page doesn't reload every minute.
  const queryKey = JSON.stringify({ ...query, since: days })
  const page = useLoad((a) => a.audit.page(query), [queryKey], ['audit-appended'])

  // A new filter starts from the newest records again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change only
  useEffect(() => setOlder([]), [queryKey])

  const records = page.status === 'ready' ? [...page.data.records, ...older] : []
  const selected = records.find((r) => r.seq === selectedSeq) ?? records[0] ?? null
  const status = verified ?? (chain.status === 'ready' ? chain.data : null)
  const loadMore = async (from: AuditPage) => {
    const next = older.length > 0 ? older[older.length - 1]?.seq : from.nextBeforeSeq
    if (next === undefined || next === null) return
    const more = await api.audit.page({ ...query, beforeSeq: next })
    setOlder((current) => [...current, ...more.records])
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
          <button type="button" className="btn" onClick={() => api.audit.exportJsonl()}>
            <Icon name="download" size="sm" />
            Export JSONL
          </button>
        </div>
      </div>

      <div style={{ margin: 'var(--space-3) var(--space-5) 0' }}>
        {status !== null ? <ChainCallout status={status} now={now} /> : null}
        <ActionFailed failed={verify.failed} what="verify the chain" />
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
                <option key={c.id} value={c.reportedName}>
                  {clientLabel(c.reportedName)}
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
                      <td className="mono xs tertiary">{tinyHash(record.hash)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
          {page.status === 'ready' && (older.length > 0 || page.data.nextBeforeSeq !== null) ? (
            <div className="empty">
              <button type="button" className="btn" onClick={() => loadMore(page.data)}>
                Load older records
              </button>
            </div>
          ) : null}
        </div>

        {selected !== null ? <Inspector record={selected} records={records} status={status} /> : null}
      </div>
    </>
  )
}

function ChainCallout({ status, now }: { readonly status: ChainStatus; readonly now: number }) {
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
        <strong>Chain intact.</strong> All {status.records.toLocaleString('en-AU')} records verified up to the
        head at {formatTime(status.verifiedAt, now)}. Each hash covers the record before it, so an edit to an
        earlier record shows up. Deleting the newest records, or rewriting the whole log, needs an external
        anchor to detect (planned).
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
    case 'grant-revoked':
      return (
        <>
          {event.adapterId} · {event.secret} <span className="xs muted">revoked</span>
        </>
      )
    case 'tool-called':
      return (
        <>
          <span className="mono xs">{event.tool}</span> · {clientLabel(event.client)}
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
          <span className="xs muted">{clientLabel(event.client)}</span>
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
        ) : status?.state === 'intact' ? (
          <span className="pill ok">
            <Icon name="check" size="sm" />
            In verified chain
          </span>
        ) : null}
      </div>
      <pre className="code raw" style={{ fontSize: 10.5, lineHeight: 1.5, padding: '10px 12px' }}>
        {highlight(JSON.stringify(record, null, 2))}
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
            {previous !== undefined ? tinyHash(previous.hash) : '…'}
          </div>
          <span className="link" />
          <div className="block on">
            <strong>{record.seq}</strong>prev {record.prev.slice(0, 4)}…
            <br />
            {tinyHash(record.hash)}
          </div>
          <span className="link" />
          <div className="block">
            <strong>{next?.seq ?? record.seq + 1}</strong>
            {next !== undefined ? (
              <>
                prev {next.prev.slice(0, 4)}…
                <br />
                {tinyHash(next.hash)}
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
          onClick={() => api.app.copyText(JSON.stringify(record, null, 2))}
        >
          <Icon name="copy" size="sm" />
          Copy record
        </button>
      </div>
    </aside>
  )
}
