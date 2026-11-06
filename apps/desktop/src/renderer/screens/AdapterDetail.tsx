// One adapter (docs/mockups/adapter-detail.html): version and hash, tools by side effect, recent
// runs, permissions as declared, the session and its partitions, and each secret's grant.

import type { AdapterDetail, RunSummary, SecretRequestInfo, SiteHealth } from '../../shared/api'
import {
  ActionFailed,
  AdapterText,
  Avatar,
  ClientName,
  Hash,
  Icon,
  LoadState,
  OutcomePill,
  SecretBadge,
  SideEffect,
} from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatDay, formatDuration, formatIn, formatTime, hostOf, plural } from '../lib/format'
import { probeText } from '../lib/permissions'
import { href } from '../lib/router'
import { FIELD_WORDING, needsUserWording, PROVIDER_WORDING, SESSION_WORDING } from '../lib/wording'

export function AdapterDetailPage({ adapterId }: { readonly adapterId: string }) {
  const detail = useLoad(
    (api) => api.adapters.get(adapterId),
    [adapterId],
    ['adapters-changed', 'grants-changed'],
  )
  const runs = useLoad((api) => api.runs.list({ adapterId, limit: 5 }), [adapterId], ['runs-changed'])
  const sites = useLoad((api) => api.health.sites(), [], ['health-changed'])
  const name = detail.status === 'ready' && detail.data !== null ? detail.data.name : adapterId

  return (
    <>
      <div className="titlebar">
        <nav className="row" aria-label="Breadcrumb">
          <a className="muted" href={href.adapters()}>
            Adapters
          </a>
          <Icon name="chevron" size="sm" className="tertiary" />
          <span className="title">{name}</span>
        </nav>
        <div className="tools">
          <a className="btn" href={href.activity()}>
            All activity
          </a>
        </div>
      </div>
      <div className="content scroll" style={{ paddingTop: 'var(--space-4)' }}>
        <LoadState loaded={detail} what="this adapter">
          {(adapter) =>
            adapter === null ? (
              <div className="empty">No adapter with that id is installed.</div>
            ) : (
              <Detail
                adapter={adapter}
                runs={runs.status === 'ready' ? runs.data : []}
                breaker={
                  sites.status === 'ready'
                    ? (sites.data.find((s) => s.adapterIds.includes(adapter.id)) ?? null)
                    : null
                }
              />
            )
          }
        </LoadState>
      </div>
    </>
  )
}

function Detail({
  adapter,
  runs,
  breaker,
}: {
  readonly adapter: AdapterDetail
  readonly runs: readonly RunSummary[]
  readonly breaker: SiteHealth | null
}) {
  const now = useNow(30_000)
  const reads = adapter.requests.filter((r) => r.purpose === 'read').length
  const writes = adapter.requests.filter((r) => r.purpose === 'write').length
  const irreversible = adapter.requests.filter((r) => r.purpose === 'irreversible').length
  const granted = adapter.secretRequests.filter((s) => s.grant !== null).length

  return (
    <>
      <div className="hero">
        <Avatar adapterId={adapter.id} name={adapter.name} size="lg" />
        <div className="grow">
          <div className="row">
            <h1 className="h1">{adapter.name}</h1>
            {adapter.approval === 'approved' ? (
              <span className="pill ok">
                <Icon name="check" size="sm" />
                Approved
              </span>
            ) : (
              <span className="pill">Not approved</span>
            )}
            {adapter.pendingUpdate !== null ? (
              <a className="pill info" href={href.review(adapter.id)}>
                {adapter.pendingUpdate.version} waiting for review
              </a>
            ) : null}
          </div>
          {adapter.description === '' ? null : (
            <div className="small" data-testid="adapter-description">
              <AdapterText text={adapter.description} />
            </div>
          )}
        </div>
        <dl className="kv" style={{ gridTemplateColumns: 'auto auto' }}>
          <dt>Version</dt>
          <dd>
            {adapter.version}
            {adapter.approvedAt !== null ? ` · approved ${formatDay(adapter.approvedAt)}` : ''}
          </dd>
          <dt>Content hash</dt>
          <dd className="row">
            <span className="hash" title={adapter.hash}>
              sha256:{adapter.hash.slice(0, 12)}…{adapter.hash.slice(-8)}
            </span>
          </dd>
        </dl>
      </div>

      <div className="detail">
        <div className="stack gap-4">
          <div className="card">
            <div className="card-head">
              <span className="h3">Tools</span>
              <span className="muted">
                {plural(adapter.tools.length, 'tool')} exposed over MCP · any tool may make any declared
                request
              </span>
            </div>
            <table className="table tight">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Side effect</th>
                  <th>Manifest’s description</th>
                  <th className="num">Calls · 7d</th>
                </tr>
              </thead>
              <tbody>
                {adapter.tools.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <span className="mono">{t.name}</span>
                    </td>
                    <td>
                      <SideEffect purpose={t.sideEffect} />
                    </td>
                    <td className="xs">
                      <AdapterText text={t.description} />
                    </td>
                    <td className="num">{t.calls7d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="h3">Recent runs</span>
              <span className="actions">
                <a className="btn ghost" href={href.activity()}>
                  All activity
                </a>
              </span>
            </div>
            {runs.length === 0 ? (
              <div className="empty">No runs yet.</div>
            ) : (
              <table className="table tight">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Tool</th>
                    <th>Client</th>
                    <th>Outcome</th>
                    <th className="num">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.callId}>
                      <td className="mono xs">{formatTime(r.startedAt, now)}</td>
                      <td className="mono">
                        <a href={href.activity(r.callId)}>{r.tool}</a>
                      </td>
                      <td>
                        <ClientName reported={r.client} />
                      </td>
                      <td>
                        <OutcomePill outcome={r.outcome} />
                        {r.blockedRequests > 0 ? (
                          <span className="xs muted"> {r.blockedRequests} blocked</span>
                        ) : null}
                      </td>
                      <td className="num">{formatDuration(r.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <span className="h3">Permissions</span>
              <span className="muted">declared in the manifest, enforced by the runtime</span>
            </div>
            <div className="card-body grid-3">
              <div>
                <div className="eyebrow">Login may visit · auth partition</div>
                <div className="chips" style={{ marginTop: 6 }}>
                  {adapter.navigation.map((o) => (
                    <span className="hash" key={o}>
                      {o}
                    </span>
                  ))}
                  {adapter.frameOrigins.map((o) => (
                    <span className="hash" key={`frame-${o}`} title="Subframes only">
                      {o} · frames
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div className="eyebrow">Tools may contact · egress</div>
                <div className="chips" style={{ marginTop: 6 }}>
                  {adapter.egress.map((h) => (
                    <span className="hash" key={h}>
                      {h}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div className="eyebrow">Request surface</div>
                <div className="small" style={{ marginTop: 6 }}>
                  {plural(adapter.requests.length, 'path')}: {reads} read · {writes} write · {irreversible}{' '}
                  irreversible
                </div>
                <div className="small muted">
                  At most {adapter.limits.requestsPerRun} requests per run, {adapter.limits.minGapMs / 1000} s
                  apart.
                </div>
              </div>
            </div>
            <div className="card-body" style={{ borderTop: '0.5px solid var(--border)' }}>
              <div className="surface-list">
                {adapter.requests.map((r) => (
                  <RequestRow
                    key={`${r.method} ${r.path}`}
                    method={r.method}
                    path={r.path}
                    purpose={r.purpose}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="stack gap-4">
          <SessionCard adapter={adapter} breaker={breaker} now={now} />
          <div className="card">
            <div className="card-head">
              <span className="h3">Secrets</span>
              <span className="muted">
                {granted} of {adapter.secretRequests.length} granted
              </span>
            </div>
            <div className="card-body stack gap-3">
              {adapter.secretRequests.length === 0 ? (
                <div className="xs muted">This adapter asks for none.</div>
              ) : null}
              {adapter.secretRequests.map((s) => (
                <SecretBlock key={s.name} adapter={adapter} request={s} />
              ))}
              <div className="eyebrow" style={{ marginTop: 4 }}>
                One-time codes by SMS · Messages
              </div>
              {adapter.messages.length === 0 ? (
                <div className="xs muted">None declared.</div>
              ) : (
                adapter.messages.map((m) => (
                  <div className="row" key={m.sender}>
                    <span className="mono xs grow">{m.sender}</span>
                    {m.grant !== null ? (
                      <span className="pill ok">Granted</span>
                    ) : (
                      <a className="btn" href={href.grant(adapter.id, 'messages')}>
                        Grant…
                      </a>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function RequestRow({
  method,
  path,
  purpose,
}: {
  readonly method: string
  readonly path: string
  readonly purpose: AdapterDetail['requests'][number]['purpose']
}) {
  return (
    <>
      <span className="method">{method}</span>
      <span className="mono xs">{path}</span>
      <SideEffect purpose={purpose} />
    </>
  )
}

function SessionCard({
  adapter,
  breaker,
  now,
}: {
  readonly adapter: AdapterDetail
  readonly breaker: SiteHealth | null
  readonly now: number
}) {
  const api = useApi()
  const action = useAction()
  const { session } = adapter
  return (
    <div className="card">
      <div className="card-head">
        <span className="h3">Session</span>
        {session.state === 'needs-user' ? (
          <span className="pill warn">Waiting for you</span>
        ) : session.state === 'logged-in' ? (
          <span className="pill ok">{SESSION_WORDING[session.state]}</span>
        ) : (
          <span className="pill">{SESSION_WORDING[session.state]}</span>
        )}
        {session.state === 'needs-user' ? (
          <span className="actions">
            <button
              type="button"
              className="btn"
              disabled={action.busy}
              onClick={() => action.run(() => api.openLoginWindow(adapter.id))}
            >
              Show login
            </button>
          </span>
        ) : null}
      </div>
      <div className="card-body">
        {session.state === 'needs-user' && session.needsUser !== null ? (
          <div className="xs muted" style={{ marginBottom: 8 }}>
            {needsUserWording(session.needsUser).detail}
          </div>
        ) : null}
        <ActionFailed failed={action.failed} what="open the login window" />
        <dl className="kv">
          <dt>Auth</dt>
          <dd className="mono xs">{adapter.partitions.auth}</dd>
          <dt>Tools</dt>
          <dd className="mono xs">{adapter.partitions.tool}</dd>
          <dt>Probe</dt>
          <dd className="mono xs">{probeText(adapter.probe)}</dd>
          <dt>Handed over</dt>
          <dd>
            {adapter.handedOver === null
              ? 'Nothing yet'
              : `${plural(adapter.handedOver.cookies, 'cookie')} · ${plural(adapter.handedOver.storageKeys, 'storage key')}`}
          </dd>
          <dt>Breaker</dt>
          <dd className="row">
            {breaker !== null && breaker.breaker === 'open' && breaker.retryAt !== null ? (
              <>
                <span className="dot bad" />
                Open · retry {formatIn(breaker.retryAt, now)}
              </>
            ) : (
              <>
                <span className="dot ok" />
                Closed · {adapter.limits.minGapMs / 1000} s between calls
              </>
            )}
          </dd>
        </dl>
      </div>
    </div>
  )
}

function SecretBlock({
  adapter,
  request,
}: {
  readonly adapter: AdapterDetail
  readonly request: SecretRequestInfo
}) {
  const api = useApi()
  const action = useAction()
  const { grant } = request
  const notGiven = grant === null ? [] : request.origins.filter((o) => !grant.origins.includes(o))
  return (
    <div className="stack">
      <div className="row">
        <SecretBadge name={request.name} />
        <span className="xs muted grow">{request.fields.map((f) => FIELD_WORDING[f]).join(', ')}</span>
        {grant !== null ? (
          <span className="pill ok">Granted</span>
        ) : (
          <a className="btn primary" href={href.grant(adapter.id, request.name)}>
            Grant…
          </a>
        )}
      </div>
      <div className="xs">
        <AdapterText text={request.description} />
      </div>
      {grant !== null ? (
        <>
          <dl className="kv">
            <dt>Bound to</dt>
            <dd>
              {PROVIDER_WORDING[grant.provider].title} “{grant.itemTitle}”
            </dd>
            <dt>Allowed on</dt>
            <dd className="mono xs truncate">{grant.origins.map(hostOf).join(', ')}</dd>
            {notGiven.length > 0 ? (
              <>
                <dt>Not given</dt>
                <dd className="mono xs tertiary truncate">{notGiven.map(hostOf).join(', ')}</dd>
              </>
            ) : null}
            <dt>Valid for</dt>
            <dd>
              <Hash hash={grant.adapterHash} /> only
            </dd>
          </dl>
          <div className="row">
            <a className="btn ghost" href={href.grant(adapter.id, request.name)}>
              Change…
            </a>
            <button
              type="button"
              className="btn ghost danger-text"
              disabled={action.busy}
              onClick={() => action.run(() => api.grants.revoke(adapter.id, request.name))}
            >
              Revoke
            </button>
            <ActionFailed failed={action.failed} what="revoke the grant" />
          </div>
        </>
      ) : (
        <div className="xs muted">
          Requested for {request.origins.map(hostOf).join(', ')}. Not granted: logins can’t fill it.
        </div>
      )}
    </div>
  )
}
