// Control panel home (docs/mockups/control-adapters.html): every adapter's approval, tools,
// secrets, session and site health, plus the circuit breakers and credential providers.

import { useState } from 'react'
import type { AdapterSummary, PendingReview, ProviderStatus, RunStats, SiteHealth } from '../../shared/api'
import { Avatar, Hash, Icon, LoadState, SecretBadge, Segmented, SideEffect, Spark } from '../components/ui'
import { useLoad, useNow } from '../lib/api-context'
import { formatAgo, formatCountdown, formatIn, formatTime, plural } from '../lib/format'
import { additionBadges } from '../lib/permissions'
import { href } from '../lib/router'
import { needsUserWording, PROVIDER_WORDING, SESSION_WORDING } from '../lib/wording'

type Filter = 'all' | 'needs-you'

export function healthOf(adapter: AdapterSummary, sites: readonly SiteHealth[]): SiteHealth | null {
  return sites.find((s) => s.adapterIds.includes(adapter.id) && s.breaker === 'open') ?? null
}

export function needsYou(adapter: AdapterSummary, sites: readonly SiteHealth[]): boolean {
  return (
    adapter.session.state === 'needs-user' ||
    adapter.pendingUpdate !== null ||
    adapter.approval !== 'approved' ||
    adapter.secrets.some((s) => !s.granted) ||
    adapter.settingsNeeded.length > 0 ||
    healthOf(adapter, sites) !== null
  )
}

export function AdaptersPage() {
  const adapters = useLoad((api) => api.adapters.list(), [], ['adapters-changed'])
  const reviews = useLoad((api) => api.approvals.pending(), [], ['approvals-changed'])
  const sites = useLoad((api) => api.health.sites(), [], ['health-changed'])
  const providers = useLoad((api) => api.grants.providers(), [], ['grants-changed', 'settings-changed'])
  const stats = useLoad((api) => api.runs.statsToday(), [], ['runs-changed'])
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')

  const list = adapters.status === 'ready' ? adapters.data : []
  const health = sites.status === 'ready' ? sites.data : []
  const visible = list.filter(
    (a) =>
      (filter === 'all' || needsYou(a, health)) &&
      (search.trim() === '' || `${a.name} ${a.site}`.toLowerCase().includes(search.trim().toLowerCase())),
  )

  return (
    <>
      <div className="titlebar">
        <div>
          <div className="title">Adapters</div>
          <div className="subtitle">
            {plural(list.length, 'installed', 'installed')} ·{' '}
            {list.filter((a) => a.approval === 'approved').length} approved
          </div>
        </div>
        <div className="tools">
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'needs-you', label: 'Needs you' },
            ]}
          />
          <label className="search">
            <Icon name="search" size="sm" />
            <span className="sr-only">Search adapters</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search adapters" />
          </label>
        </div>
      </div>

      <div className="content scroll stack gap-4 adapters-page" style={{ alignContent: 'start' }}>
        {reviews.status === 'ready'
          ? reviews.data.map((review) => <ReviewCallout key={review.adapterId} review={review} />)
          : null}

        <LoadState loaded={adapters} what="adapters">
          {() =>
            visible.length === 0 ? (
              <div className="card empty">
                {list.length === 0 ? 'No adapters installed yet.' : 'Nothing needs you right now.'}
              </div>
            ) : (
              <div className="card table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Adapter</th>
                      <th>Version</th>
                      <th>Approval</th>
                      <th>Tools</th>
                      <th>Secrets</th>
                      <th>Session</th>
                      <th>Health</th>
                      <th className="num">Calls · 7d</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((adapter) => (
                      <AdapterRow key={adapter.id} adapter={adapter} open={healthOf(adapter, health)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </LoadState>

        <div className="grid-3">
          <BreakersCard sites={sites.status === 'ready' ? sites.data : []} adapters={list} />
          {stats.status === 'ready' ? <TodayCard stats={stats.data} /> : <div className="card" />}
          <CredentialsCard providers={providers.status === 'ready' ? providers.data : []} />
        </div>
      </div>
    </>
  )
}

function ReviewCallout({ review }: { readonly review: PendingReview }) {
  const badges = additionBadges(review.diff)
  const from = review.from === null ? 'nothing until you approve' : `${review.from.version} until you approve`
  return (
    <div className="callout info">
      <Icon name="adapter" />
      <div className="grow">
        <strong>
          {review.name} {review.to.version} is ready for review.
        </strong>{' '}
        <span className="muted">
          {badges.length > 0
            ? `It asks for more: ${badges.map((b) => b.label.replace(/^\+/, '')).join(', ')}.`
            : 'It asks for nothing new.'}{' '}
          Calls keep using {from}.
        </span>
      </div>
      <a className="btn" href={href.review(review.adapterId)}>
        Review changes
      </a>
    </div>
  )
}

function AdapterRow({
  adapter,
  open,
}: {
  readonly adapter: AdapterSummary
  readonly open: SiteHealth | null
}) {
  const now = useNow(30_000)
  const { session } = adapter
  return (
    <tr>
      <td>
        <div className="adapter-cell">
          <Avatar adapterId={adapter.id} name={adapter.name} />
          <div>
            <a className="h3" href={href.adapter(adapter.id)} style={{ color: 'inherit' }}>
              {adapter.name}
            </a>
            <div className="xs muted">{adapter.site}</div>
          </div>
        </div>
      </td>
      <td>
        <div>{adapter.version}</div>
        <Hash hash={adapter.hash} />
      </td>
      <td>
        <div className="stack pills" style={{ gap: 3 }}>
          {adapter.approval === 'approved' ? (
            <span className="pill ok">
              <Icon name="check" size="sm" />
              Approved
            </span>
          ) : adapter.approval === 'rejected' ? (
            <span className="pill bad">Rejected</span>
          ) : (
            <span className="pill">Not approved</span>
          )}
          {adapter.pendingUpdate !== null ? (
            <span className="pill info">{adapter.pendingUpdate.version} to review</span>
          ) : null}
        </div>
      </td>
      <td>
        <div className="tool-counts">
          {adapter.toolCounts.read > 0 ? (
            <SideEffect purpose="read">{adapter.toolCounts.read} read</SideEffect>
          ) : null}
          {adapter.toolCounts.write > 0 ? (
            <SideEffect purpose="write">{adapter.toolCounts.write} write</SideEffect>
          ) : null}
          {adapter.toolCounts.irreversible > 0 ? (
            <SideEffect purpose="irreversible">{adapter.toolCounts.irreversible} irrev.</SideEffect>
          ) : null}
        </div>
      </td>
      <td>
        <div className="chips">
          {adapter.secrets.length === 0 && adapter.messagesSources.length === 0 ? (
            <span className="xs muted">None</span>
          ) : null}
          {adapter.secrets.map((s) =>
            s.granted ? (
              <SecretBadge key={s.name} name={s.name} />
            ) : (
              <span key={s.name} className="badge neutral" title="Requested, not granted">
                {s.name} · not granted
              </span>
            ),
          )}
          {adapter.messagesSources.map((m) => (
            <span key={m.sender} className={`badge ${m.granted ? 'secret' : 'neutral'}`}>
              SMS code · {m.granted ? 'granted' : 'not granted'}
            </span>
          ))}
        </div>
      </td>
      <td>
        <div className="row">
          <span
            className={`dot ${
              session.state === 'logged-in'
                ? 'ok'
                : session.state === 'needs-user'
                  ? 'warn pulse'
                  : session.state === 'logging-in'
                    ? 'info'
                    : ''
            }`}
          />
          {SESSION_WORDING[session.state]}
        </div>
        <div className="xs muted">
          {session.state === 'needs-user' && session.needsUser !== null
            ? `${needsUserWording(session.needsUser).short} · ${formatTime(session.since, now)}`
            : session.state === 'expired'
              ? 'Logs in on next call'
              : session.checkedAt !== null
                ? `Checked ${formatTime(session.checkedAt, now)}`
                : null}
        </div>
      </td>
      <td>
        {open !== null && open.retryAt !== null ? (
          <>
            <span className="pill bad">
              {open.cause === 'rate-limited' ? 'Rate limited' : 'Blocked by site'}
            </span>
            <div className="xs muted" style={{ marginTop: 2 }}>
              Retry {formatIn(open.retryAt, now)}
            </div>
          </>
        ) : session.state === 'needs-user' ? (
          <span className="pill warn">Needs you</span>
        ) : adapter.approval !== 'approved' ? (
          <span className="xs tertiary">—</span>
        ) : adapter.settingsNeeded.length > 0 ? (
          <>
            <a className="pill warn" href={href.adapter(adapter.id)}>
              Choose {adapter.settingsNeeded[0]?.toLowerCase()}
            </a>
            <div className="xs muted" style={{ marginTop: 2 }}>
              Its tools wait until you do
            </div>
          </>
        ) : (
          <span className="pill ok">Healthy</span>
        )}
      </td>
      <td className="num">{adapter.calls7d}</td>
    </tr>
  )
}

function BreakersCard({
  sites,
  adapters,
}: {
  readonly sites: readonly SiteHealth[]
  readonly adapters: readonly AdapterSummary[]
}) {
  const now = useNow()
  const nameOf = (id: string) => adapters.find((a) => a.id === id)
  return (
    <div className="card">
      <div className="card-head">
        <span className="h3">Site circuit breakers</span>
      </div>
      <div className="card-body" style={{ paddingTop: 2, paddingBottom: 2 }}>
        {sites.length === 0 ? <div className="breaker xs muted">No sites contacted yet.</div> : null}
        {sites.map((site) => {
          const first = site.adapterIds[0]
          const adapter = first === undefined ? undefined : nameOf(first)
          return (
            <div className="breaker" key={site.host}>
              <span className="row">
                {adapter !== undefined ? (
                  <Avatar adapterId={adapter.id} name={adapter.name} size="sm" />
                ) : null}
                <span className="mono xs">{site.host}</span>
              </span>
              {site.breaker === 'open' && site.retryAt !== null ? (
                <span className="pill bad">Open · {formatCountdown(site.retryAt, now)}</span>
              ) : (
                <span className="pill ok">Closed</span>
              )}
              <span className="xs muted wide">
                {site.breaker === 'open'
                  ? `${site.cause === 'rate-limited' ? 'The site rate-limited us' : 'The site refused a request'} at ${formatTime(site.lastOpenedAt, now)}. No calls reach it until the cool-down ends.`
                  : site.lastOpenedAt !== null
                    ? `Last opened ${formatAgo(site.lastOpenedAt, now)} · next cool-down ${Math.round(site.nextCooldownSeconds / 60)} min`
                    : 'Never opened'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TodayCard({ stats }: { readonly stats: RunStats }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="h3">Today</span>
        <span className="muted">since midnight</span>
      </div>
      <div className="card-body stack gap-3">
        <div className="breaker">
          <span>Tool calls</span>
          <span className="mono xs">{stats.toolCalls}</span>
          <div className="wide">
            <Spark values={stats.hourly.toolCalls} />
          </div>
        </div>
        <div className="breaker">
          <span>Logins</span>
          <span className="mono xs">
            {stats.logins} · {stats.loginsFailed} failed
          </span>
          <div className="wide">
            <Spark values={stats.hourly.logins} />
          </div>
        </div>
        <div className="breaker">
          <span>Blocked requests</span>
          <span className="mono xs">{stats.blockedRequests}</span>
          <div className="wide">
            <Spark values={stats.hourly.blockedRequests} tone="bad" />
          </div>
        </div>
      </div>
    </div>
  )
}

function CredentialsCard({ providers }: { readonly providers: readonly ProviderStatus[] }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="h3">Credentials</span>
        <span className="muted">1Password and Messages</span>
      </div>
      <div className="card-body stack" style={{ gap: 6 }}>
        {providers.map((p) => (
          <div className="row small" key={p.kind}>
            <span className={`dot ${p.available ? 'ok' : 'warn'}`} />
            <span className="grow">
              {PROVIDER_WORDING[p.kind].title}
              {p.available ? '' : p.unavailableReason === 'disabled' ? ' · off' : ' · not set up'}
            </span>
            <span className="xs muted">{plural(p.grantCount, 'grant')}</span>
          </div>
        ))}
        <div className="xs muted" style={{ marginTop: 4 }}>
          Adapters never see these values. Every grant is tied to one adapter hash.
        </div>
      </div>
    </div>
  )
}
