// One adapter (docs/mockups/adapter-detail.html): version and hash, tools by side effect, recent
// runs, permissions as declared, the session and its partitions, and each secret's grant.

import { useState } from 'react'
import type {
  AdapterDetail,
  AdapterSettingInfo,
  RunSummary,
  SecretRequestInfo,
  SettingChoicesReply,
  SiteHealth,
} from '../../shared/api'
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
                {plural(adapter.tools.filter((t) => !t.internal).length, 'tool')} exposed over MCP · any tool
                may make any declared request
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
                      {t.internal ? (
                        <div
                          className="xs muted"
                          title="Valet runs this tool itself. No client can list or call it."
                        >
                          Settings only · not exposed
                        </div>
                      ) : null}
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
          {adapter.settings.length === 0 ? null : <SettingsCard adapter={adapter} now={now} />}
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

function SettingsCard({ adapter, now }: { readonly adapter: AdapterDetail; readonly now: number }) {
  const needed = adapter.settings.filter((s) => s.required && s.chosen === null).length
  return (
    <div className="card" data-testid="adapter-settings">
      <div className="card-head">
        <span className="h3">Settings</span>
        {needed > 0 ? (
          <span className="pill warn">Waiting for you</span>
        ) : (
          <span className="muted">chosen by you, used by every tool</span>
        )}
      </div>
      <div className="card-body stack gap-3">
        {adapter.settings.map((s) => (
          <SettingBlock key={s.name} adapter={adapter} setting={s} now={now} />
        ))}
      </div>
    </div>
  )
}

/**
 * One setting: what is chosen, and a search for choices. The search is a real, paced request to the
 * site through the adapter, so it runs only when the person asks, never as they type.
 */
export function SettingBlock({
  adapter,
  setting,
  now,
}: {
  readonly adapter: AdapterDetail
  readonly setting: AdapterSettingInfo
  readonly now: number
}) {
  const api = useApi()
  const search = useAction()
  const choose = useAction()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [reply, setReply] = useState<{ readonly query: string; readonly reply: SettingChoicesReply } | null>(
    null,
  )
  const searching = open || setting.chosen === null
  const approved = adapter.approval === 'approved'
  const title = setting.title.toLowerCase()

  const runSearch = () =>
    search.run(async () => {
      const asked = query.trim()
      setReply(null)
      setReply({ query: asked, reply: await api.adapters.settingChoices(adapter.id, setting.name, asked) })
    })
  const pick = (choiceId: string) =>
    choose.run(async () => {
      await api.adapters.setSetting(adapter.id, setting.name, choiceId)
      setOpen(false)
      setReply(null)
      setQuery('')
    })

  return (
    <div className="stack" data-testid={`setting-${setting.name}`}>
      <div className="row">
        <span className="h3 grow">{setting.title}</span>
        {setting.chosen !== null ? (
          <span className="pill ok">Chosen</span>
        ) : setting.required ? (
          <span className="pill warn">Needed</span>
        ) : (
          <span className="pill">Not chosen</span>
        )}
      </div>
      <div className="xs">
        <AdapterText text={setting.description} />
      </div>
      {setting.chosen !== null ? (
        <>
          <dl className="kv">
            <dt>Chosen</dt>
            <dd data-testid="setting-chosen">
              <AdapterText text={setting.chosen.label} />
              {setting.chosen.detail === null || setting.chosen.detail === '' ? null : (
                <div className="xs muted">
                  <AdapterText text={setting.chosen.detail} />
                </div>
              )}
            </dd>
            <dt>Since</dt>
            <dd>{formatTime(setting.chosen.chosenAt, now)}</dd>
          </dl>
          {searching ? null : (
            <div className="row">
              <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
                Change…
              </button>
            </div>
          )}
        </>
      ) : setting.required ? (
        <div className="xs muted">
          Nothing chosen yet, so {adapter.name}’s tools won’t run: an agent that calls one is told you need to
          choose a {title}.
        </div>
      ) : null}
      {!searching ? null : !approved ? (
        <div className="xs muted">Approve the adapter first: the search runs its code against the site.</div>
      ) : (
        <>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault()
              if (!search.busy && query.trim() !== '') void runSearch()
            }}
          >
            <input
              className="input grow"
              aria-label={`${setting.queryLabel} to find a ${title}`}
              placeholder={setting.queryLabel}
              maxLength={100}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="btn primary" disabled={search.busy || query.trim() === ''}>
              {search.busy ? 'Searching…' : 'Search'}
            </button>
            {open ? (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setOpen(false)
                  setReply(null)
                }}
              >
                Cancel
              </button>
            ) : null}
          </form>
          <div className="xs muted">
            Searching asks {adapter.site} through the adapter, {adapter.limits.minGapMs / 1000} s apart like
            every call, so it can take a moment.
          </div>
          <ActionFailed failed={search.failed} what={`search for a ${title}`} />
          {reply === null ? null : (
            <SettingChoices reply={reply} busy={choose.busy} now={now} onPick={pick} />
          )}
          <ActionFailed failed={choose.failed} what={`save the ${title}`} />
        </>
      )}
    </div>
  )
}

function SettingChoices({
  reply: { query, reply },
  busy,
  now,
  onPick,
}: {
  readonly reply: { readonly query: string; readonly reply: SettingChoicesReply }
  readonly busy: boolean
  readonly now: number
  readonly onPick: (choiceId: string) => void
}) {
  if (reply.status === 'blocked') {
    return (
      <div className="xs muted" role="status">
        The site is refusing or slowing Valet. Try again {formatIn(reply.retryAt, now)}.
      </div>
    )
  }
  if (reply.status === 'not-approved') {
    return (
      <div className="xs muted" role="status">
        The adapter isn’t approved, so it can’t search.
      </div>
    )
  }
  if (reply.status === 'site-changed') {
    return (
      <div className="xs muted" role="status">
        The site answered in a way the adapter doesn’t understand. The adapter may need an update.
      </div>
    )
  }
  if (reply.status === 'failed') {
    return (
      <div className="xs muted" role="status">
        The search didn’t work. Try again in a moment.
      </div>
    )
  }
  if (reply.choices.length === 0) {
    return (
      <div className="xs muted" role="status">
        Nothing found for “{query}”.
      </div>
    )
  }
  return (
    <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Choices">
      {reply.choices.map((choice) => (
        <li className="row" key={choice.id}>
          <span className="grow">
            <AdapterText text={choice.label} />
            {choice.detail === null || choice.detail === '' ? null : (
              <div className="xs muted">
                <AdapterText text={choice.detail} />
              </div>
            )}
          </span>
          <button type="button" className="btn" disabled={busy} onClick={() => onPick(choice.id)}>
            Choose
          </button>
        </li>
      ))}
    </ul>
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
          {adapter.handedOver === null ? null : (
            <>
              <dt>Handed over</dt>
              <dd>
                {`${plural(adapter.handedOver.cookies, 'cookie')} · ${plural(adapter.handedOver.storageKeys, 'storage key')}`}
              </dd>
            </>
          )}
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
