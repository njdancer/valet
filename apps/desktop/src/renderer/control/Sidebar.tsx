import { Avatar, Icon, type IconName } from '../components/ui'
import { useLoad, useNow } from '../lib/api-context'
import { formatCount, formatTime, hostOf } from '../lib/format'
import { href, type Route } from '../lib/router'
import { OUTCOME_TONE } from '../lib/wording'

type Section = 'adapters' | 'activity' | 'audit' | 'clients' | 'credentials' | 'settings'

function sectionOf(route: Route): Section | null {
  switch (route.page) {
    case 'adapters':
    case 'adapter':
    case 'grant':
    case 'review':
      return 'adapters'
    case 'activity':
      return 'activity'
    case 'audit':
      return 'audit'
    case 'clients':
      return 'clients'
    case 'credentials':
      return 'credentials'
    case 'settings':
      return 'settings'
    default:
      return null
  }
}

function NavItem({
  to,
  icon,
  label,
  active,
  count,
  alert = false,
}: {
  readonly to: string
  readonly icon: IconName
  readonly label: string
  readonly active: boolean
  readonly count?: number
  readonly alert?: boolean
}) {
  return (
    <a className={`nav-item${active ? ' active' : ''}`} href={to} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} />
      {label}
      {count !== undefined && count > 0 ? (
        <span className={`count${alert ? ' alert' : ''}`}>{formatCount(count)}</span>
      ) : null}
    </a>
  )
}

export function Sidebar({ route }: { readonly route: Route }) {
  const section = sectionOf(route)
  const adapters = useLoad((api) => api.adapters.list(), [], ['adapters-changed'])
  const attention = useLoad((api) => api.attention.list(), [], ['attention-changed'])
  const stats = useLoad((api) => api.runs.statsToday(), [], ['runs-changed'])
  const clients = useLoad((api) => api.clients.list(), [], ['clients-changed'])
  const endpoint = useLoad((api) => api.endpoint.status(), [], ['endpoint-changed'])
  const chain = useLoad((api) => api.audit.chainStatus(), [], ['audit-appended'])
  const runs = useLoad((api) => api.runs.list({ limit: 12 }), [], ['runs-changed'])
  const app = useLoad((api) => api.app.status(), [], ['app-changed'])
  const now = useNow(60_000)
  const demo = app.status === 'ready' && app.data.demo

  const attentionCount = attention.status === 'ready' ? attention.data.length : 0
  const selectedAdapter = route.page === 'adapter' || route.page === 'grant' ? route.adapterId : null

  return (
    <aside className="sidebar" aria-label="Sections">
      <div className="group-label">
        siteadapter{' '}
        {demo ? (
          <span className="pill warn" title="A local fake Woolworths and a test account, never a real one">
            DEMO
          </span>
        ) : null}
      </div>
      <NavItem
        to={href.adapters()}
        icon="adapter"
        label="Adapters"
        active={section === 'adapters' && selectedAdapter === null}
        count={attentionCount}
        alert
      />
      <NavItem
        to={href.activity()}
        icon="activity"
        label="Activity"
        active={section === 'activity'}
        count={stats.status === 'ready' ? stats.data.toolCalls : undefined}
      />
      <NavItem to={href.audit()} icon="audit" label="Audit log" active={section === 'audit'} />
      <NavItem
        to={href.clients()}
        icon="clients"
        label="Clients"
        active={section === 'clients'}
        count={
          clients.status === 'ready' ? clients.data.filter((c) => c.revokedAt === null).length : undefined
        }
      />
      <NavItem to={href.credentials()} icon="key" label="Credentials" active={section === 'credentials'} />
      <NavItem to={href.settings()} icon="gear" label="Settings" active={section === 'settings'} />

      {section === 'activity' && runs.status === 'ready' ? (
        <div className="run-list">
          <div className="group-label">Recent</div>
          {runs.data.map((run, index) => {
            const selected =
              route.page === 'activity' && (route.callId ?? (index === 0 ? run.callId : null)) === run.callId
            return (
              <a
                key={run.callId}
                className={`nav-item${selected ? ' active' : ''}`}
                href={href.activity(run.callId)}
                aria-current={selected ? 'page' : undefined}
              >
                <span className={`dot ${OUTCOME_TONE[run.outcome] || 'tertiary'}`} />
                <span className="grow truncate">{run.tool}</span>
                <span className="count">{formatTime(run.startedAt, now)}</span>
              </a>
            )
          })}
        </div>
      ) : adapters.status === 'ready' && adapters.data.length > 0 ? (
        <>
          <div className="group-label">Sites</div>
          {adapters.data.map((adapter) => (
            <a
              key={adapter.id}
              className={`nav-item${selectedAdapter === adapter.id ? ' active' : ''}`}
              href={href.adapter(adapter.id)}
              aria-current={selectedAdapter === adapter.id ? 'page' : undefined}
            >
              <Avatar adapterId={adapter.id} name={adapter.name} size="sm" />
              {adapter.name}
            </a>
          ))}
        </>
      ) : null}

      <div className="foot">
        {endpoint.status === 'ready' ? (
          <span className="row">
            <span className={`dot ${endpoint.data.listening ? 'ok' : ''}`} />
            {endpoint.data.listening && endpoint.data.url !== null
              ? `MCP on · ${hostOf(endpoint.data.url)}`
              : 'MCP off'}
          </span>
        ) : null}
        {chain.status === 'ready' ? (
          chain.data.state === 'broken' ? (
            <span className="row danger-text">
              <Icon name="warn" size="sm" />
              Audit chain broken
            </span>
          ) : chain.data.state === 'intact' ? (
            <span className="row">
              <Icon name="shield" size="sm" className="ok-text" />
              Audit chain intact
            </span>
          ) : (
            <span className="row">
              <Icon name="shield" size="sm" className="tertiary" />
              Audit chain not verified yet
            </span>
          )
        ) : null}
      </div>
    </aside>
  )
}
