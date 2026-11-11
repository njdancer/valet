// The menu-bar popover (docs/mockups/menubar.html): status, the MCP switch, today's numbers, what
// needs the person, each adapter's health, and the app menu.

import type { AdapterSummary, AttentionItem, SiteHealth } from '../../shared/api'
import { ActionFailed, Avatar, Icon, Spark } from '../components/ui'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatIn, formatTime } from '../lib/format'
import { href } from '../lib/router'
import { clientClaim, needsUserWording } from '../lib/wording'

export function TrayPopover() {
  const api = useApi()
  const endpoint = useLoad((a) => a.endpoint.status(), [], ['endpoint-changed'])
  const app = useLoad((a) => a.app.status(), [], ['app-changed'])
  const stats = useLoad((a) => a.runs.statsToday(), [], ['runs-changed'])
  const attention = useLoad((a) => a.attention.list(), [], ['attention-changed'])
  const adapters = useLoad((a) => a.adapters.list(), [], ['adapters-changed'])
  const sites = useLoad((a) => a.health.sites(), [], ['health-changed'])
  const action = useAction()

  const listening = endpoint.status === 'ready' && endpoint.data.listening
  const paused = app.status === 'ready' && app.data.paused
  const items = attention.status === 'ready' ? needsYouOrder(attention.data) : []

  return (
    <div className="tray-body">
      <div className="popover" role="dialog" aria-label="Valet">
        <div className="head">
          <span className="logo">
            <Icon name="logo" size="lg" />
          </span>
          <div className="grow">
            <div className="h3">
              Valet{' '}
              {app.status === 'ready' && app.data.demo ? (
                <span
                  className="pill warn"
                  title="A local fake Woolworths and a test account, never a real one"
                >
                  DEMO
                </span>
              ) : null}
            </div>
            <div className="xs muted row">
              <span className={`dot ${paused ? 'warn' : listening ? 'ok' : ''}`} />
              {paused
                ? 'Paused · calls are refused'
                : listening && endpoint.status === 'ready'
                  ? `Running · ${endpoint.data.connectedClients} ${endpoint.data.connectedClients === 1 ? 'client' : 'clients'} connected`
                  : 'MCP endpoint off'}
            </div>
          </div>
        </div>

        {endpoint.status === 'ready' && endpoint.data.url !== null ? (
          <div className="endpoint">
            <Icon name="link" size="sm" className="muted" />
            <span className="mono grow truncate">{endpoint.data.url}</span>
            <span className="xs muted">Streamable HTTP</span>
            <button
              type="button"
              className="btn ghost icon"
              aria-label="Copy endpoint address"
              onClick={() => action.run(() => api.endpoint.copyUrl())}
            >
              <Icon name="copy" size="sm" />
            </button>
          </div>
        ) : null}

        {stats.status === 'ready' ? (
          <div className="stat-strip">
            <div className="stat">
              <div className="value">{stats.data.toolCalls}</div>
              <div className="label">Tool calls today</div>
              <Spark values={stats.data.hourly.toolCalls} />
            </div>
            <div className="stat">
              <div className="value">{stats.data.logins}</div>
              <div className="label">Logins · {stats.data.loginsFailed} failed</div>
              <Spark values={stats.data.hourly.logins} />
            </div>
            <div className="stat">
              <div className="value">{stats.data.blockedRequests}</div>
              <div className="label">Blocked requests</div>
              <Spark values={stats.data.hourly.blockedRequests} tone="bad" />
            </div>
          </div>
        ) : null}

        {items.length > 0 ? (
          <section aria-label="Needs you" className="needs-list">
            <div className="section-label row between">
              <span>Needs you</span>
              <span className="pill warn">{items.length}</span>
            </div>
            {items.map((item) => (
              <AttentionRow key={item.id} item={item} />
            ))}
          </section>
        ) : null}

        {adapters.status === 'ready' && adapters.data.length > 0 ? (
          <section aria-label="Adapters" className="adapter-list">
            <div className="section-label">Adapters</div>
            {adapters.data.map((adapter) => (
              <AdapterRow
                key={adapter.id}
                adapter={adapter}
                site={
                  sites.status === 'ready'
                    ? (sites.data.find((s) => s.adapterIds.includes(adapter.id)) ?? null)
                    : null
                }
              />
            ))}
          </section>
        ) : null}

        <section aria-label="Menu">
          {/* D-checkout: Valet never places the order; the person checks out on the site. */}
          {adapters.status === 'ready'
            ? adapters.data
                .filter((adapter) => adapter.cartUrl !== null)
                .map((adapter) => (
                  <button
                    key={adapter.id}
                    type="button"
                    className="menu-row"
                    onClick={() => action.run(() => api.adapters.openCart(adapter.id))}
                  >
                    <Icon name="external" size="sm" className="muted" /> Check out on {adapter.site}…
                  </button>
                ))
            : null}
          <button
            type="button"
            className="menu-row"
            onClick={() => action.run(() => api.app.openControlPanel())}
          >
            Open Control Panel… <span className="kbd">⌘,</span>
          </button>
          <button
            type="button"
            className="menu-row"
            onClick={() => action.run(() => api.app.openControlPanel(href.activity()))}
          >
            Activity… <span className="kbd">⌘1</span>
          </button>
          <button
            type="button"
            className="menu-row"
            disabled={app.status !== 'ready'}
            onClick={() => action.run(() => api.app.setPaused(!paused))}
          >
            <Icon name="pause" size="sm" className="muted" />{' '}
            {paused ? 'Resume adapters' : 'Pause all adapters'}
          </button>
          {/* F19: switching MCP off cuts every client, so it lives here rather than one tap from the header. */}
          <button
            type="button"
            className="menu-row"
            disabled={endpoint.status !== 'ready'}
            onClick={() => action.run(() => api.endpoint.setListening(!listening))}
          >
            <Icon name="link" size="sm" className="muted" />{' '}
            {listening ? 'Turn off MCP for all clients' : 'Turn MCP back on'}
          </button>
          <button type="button" className="menu-row" onClick={() => action.run(() => api.app.quit())}>
            Quit Valet <span className="kbd">⌘Q</span>
          </button>
          <ActionFailed failed={action.failed} what="do that" />
        </section>
      </div>
    </div>
  )
}

const NEEDS_YOU_RANK: Record<AttentionItem['kind'], number> = {
  // A confirmation declines itself when its clock runs out, so it comes first.
  confirmation: 0,
  'needs-user': 1,
  review: 2,
}

/** What needs the person, most urgent first: confirmations, then logins, then reviews. */
export function needsYouOrder(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => NEEDS_YOU_RANK[a.kind] - NEEDS_YOU_RANK[b.kind])
}

function AttentionRow({ item }: { readonly item: AttentionItem }) {
  const api = useApi()
  const action = useAction()
  if (item.kind === 'needs-user') {
    return (
      <div className="attention">
        <span className="glyph warn">
          <Icon name="user" />
        </span>
        <div className="grow">
          <div className="h3">Log in to {item.adapterName}</div>
          <div className="xs muted clamp-2">
            {[
              needsUserWording(item.reason).short,
              item.tool,
              item.client === null ? null : `for ${clientClaim(item.client, 'inline')}`,
            ]
              .filter((p) => p !== null)
              .join(' · ')}
          </div>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={action.busy}
          onClick={() => action.run(() => api.openLoginWindow(item.adapterId))}
        >
          Open
        </button>
      </div>
    )
  }
  if (item.kind === 'confirmation') {
    return (
      <div className="attention">
        <span className={`glyph ${item.sideEffect === 'irreversible' ? 'bad' : 'warn'}`}>
          <Icon name="shield" />
        </span>
        <div className="grow">
          <div className="h3">
            Confirm {item.toolTitle} · {item.adapterName}
          </div>
          <div className="xs muted clamp-2">{clientClaim(item.client)} is waiting for your answer</div>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={action.busy}
          // Only the confirmation's own panel can approve, so Answer brings that panel forward.
          onClick={() => action.run(() => api.openConfirmation(item.id))}
        >
          Answer
        </button>
      </div>
    )
  }
  return (
    <div className="attention">
      <span className="glyph info">
        <Icon name="adapter" />
      </span>
      <div className="grow">
        <div className="h3">
          Review {item.adapterName} {item.version}
        </div>
        <div className="xs muted clamp-2">
          {item.addsPermissions ? 'Asks for more permissions' : 'Asks for nothing new'} · calls use the
          approved version
        </div>
      </div>
      <button
        type="button"
        className="btn"
        disabled={action.busy}
        onClick={() => action.run(() => api.app.openControlPanel(href.review(item.adapterId)))}
      >
        Review
      </button>
    </div>
  )
}

function AdapterRow({
  adapter,
  site,
}: {
  readonly adapter: AdapterSummary
  readonly site: SiteHealth | null
}) {
  const now = useNow(30_000)
  const { session } = adapter
  let state: { tone: string; text: string }
  if (site !== null && site.breaker === 'open' && site.retryAt !== null) {
    state = { tone: 'bad', text: `Blocked by site · retry ${formatIn(site.retryAt, now)}` }
  } else if (session.state === 'needs-user') {
    state = { tone: 'warn pulse', text: 'Login window open' }
  } else if (site !== null && site.calls > 0) {
    // D-pacing: calls take their turn one at a time, spaced out for the site.
    state = {
      tone: 'info pulse',
      text: site.calls === 1 ? 'Working on a call' : `Working · ${site.calls - 1} waiting their turn`,
    }
  } else if (adapter.approval !== 'approved') {
    state = { tone: '', text: 'Not approved' }
  } else if (session.state === 'logged-in') {
    state = { tone: 'ok', text: `Healthy · ${formatTime(session.checkedAt, now)}` }
  } else {
    state = { tone: '', text: session.state === 'expired' ? 'Logs in on next call' : 'Not checked yet' }
  }
  return (
    <div className="adapter-row">
      <Avatar adapterId={adapter.id} name={adapter.name} size="sm" />
      <div className="truncate">
        {adapter.name} <span className="xs tertiary">{adapter.version}</span>
        {adapter.pendingUpdate !== null ? (
          <div className="xs muted row" style={{ gap: 4 }}>
            <span className="dot info" />
            {adapter.pendingUpdate.version} waiting for review
          </div>
        ) : null}
      </div>
      <span className="state">
        <span className={`dot ${state.tone}`} /> {state.text}
      </span>
    </div>
  )
}
