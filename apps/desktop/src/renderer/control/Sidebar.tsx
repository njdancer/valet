// One sidebar that never changes shape (IA principle 6): the six places, then the sites, then one
// status line. Only Needs you carries a number, and it is the same count as the menu bar's badge.

import {
  Badge,
  NavItem,
  SidebarFooter,
  Sidebar as SidebarFrame,
  SidebarGroup,
  SiteAvatar,
  StatusDot,
  Tooltip,
  ValetMark,
} from '@valet/ui'
import { Activity, Inbox, KeyRound, Plug, Settings, Store } from 'lucide-react'
import { useLoad } from '../lib/api-context'
import { href, type Place, placeOf, type Route } from '../lib/router'
import { healthFor, siteStatus } from '../lib/site-status'
import { useShellState } from './shell-state'

export const PLACES: readonly {
  readonly place: Place
  readonly label: string
  readonly to: `#/${string}`
  readonly shortcut: string
}[] = [
  { place: 'needs-you', label: 'Needs you', to: href.needsYou(), shortcut: 'mod+1' },
  { place: 'sites', label: 'Sites', to: href.sites(), shortcut: 'mod+2' },
  { place: 'activity', label: 'Activity', to: href.calls(), shortcut: 'mod+3' },
  { place: 'connections', label: 'Connections', to: href.connections(), shortcut: 'mod+4' },
  { place: 'secrets', label: 'Secrets', to: href.secrets(), shortcut: 'mod+5' },
  { place: 'settings', label: 'Settings', to: href.settings(), shortcut: 'mod+6' },
]

const ICONS: Record<Place, React.ReactNode> = {
  'needs-you': <Inbox />,
  sites: <Store />,
  activity: <Activity />,
  connections: <Plug />,
  secrets: <KeyRound />,
  settings: <Settings />,
}

export function Sidebar({ route }: { readonly route: Route }) {
  const place = placeOf(route)
  const adapters = useLoad((api) => api.adapters.list(), [], ['adapters-changed', 'approvals-changed'])
  const sites = useLoad((api) => api.health.sites(), [], ['health-changed'])
  const shell = useShellState()
  const selectedSite =
    route.page === 'site' || route.page === 'review' || route.page === 'grant' || route.page === 'setting'
      ? route.adapterId
      : null

  return (
    <SidebarFrame label="Places" collapsible>
      {/* Collapsed (under 1000 px) the brand is the mark alone, centred like the icons below it. */}
      <div className="flex h-7 items-center gap-2 px-2 group-data-[collapsible]/sidebar:max-[1000px]:justify-center group-data-[collapsible]/sidebar:max-[1000px]:px-0">
        <ValetMark size={20} />
        <span className="text-md font-semibold group-data-[collapsible]/sidebar:max-[1000px]:sr-only">
          Valet
        </span>
        {shell.demo ? (
          <Tooltip content="A local fake shop and a test account, never a real one">
            <Badge
              tone="warning"
              size="sm"
              tabIndex={0}
              className="group-data-[collapsible]/sidebar:max-[1000px]:hidden"
            >
              Demo
            </Badge>
          </Tooltip>
        ) : null}
      </div>
      <SidebarGroup>
        {PLACES.map((p) => (
          <NavItem
            key={p.place}
            href={p.to}
            icon={ICONS[p.place]}
            active={place === p.place && (p.place !== 'sites' || selectedSite === null)}
            {...(p.place === 'needs-you' && shell.needsYou > 0
              ? { count: shell.needsYou, attention: true }
              : {})}
          >
            {p.label}
          </NavItem>
        ))}
      </SidebarGroup>
      {adapters.status === 'ready' && adapters.data.length > 0 ? (
        <SidebarGroup label="Sites">
          {adapters.data.map((adapter) => {
            const status = siteStatus(
              adapter,
              sites.status === 'ready' ? healthFor(adapter, sites.data) : null,
            )
            return (
              <NavItem
                key={adapter.id}
                href={href.site(adapter.id)}
                icon={<SiteAvatar id={adapter.id} name={adapter.name} size="xs" />}
                active={selectedSite === adapter.id}
                trailing={<StatusDot tone={status.tone} label={status.text} />}
              >
                {adapter.name}
              </NavItem>
            )
          })}
        </SidebarGroup>
      ) : null}
      <SidebarFooter>
        <a
          href={href.needsYou()}
          className="flex min-h-7 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-fg-muted no-underline hover:bg-hover group-data-[collapsible]/sidebar:max-[1000px]:justify-center"
        >
          <StatusDot tone={shell.tone} label={shell.line} />
          <span className="min-w-0 flex-1 truncate group-data-[collapsible]/sidebar:max-[1000px]:sr-only">
            {shell.line}
          </span>
        </a>
      </SidebarFooter>
    </SidebarFrame>
  )
}
