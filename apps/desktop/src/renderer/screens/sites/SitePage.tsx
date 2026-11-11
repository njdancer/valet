// One site (#/sites/<id>[/tools|/permissions|/versions], wireframes `site-*`): the site header with
// its adapter id, version and hash, its status and actions, then four tabs that are addresses.
// Everything with a next step shows that step here as a named button beside its status: an update
// waiting has its Review button on this page, not only in the menu bar (the owner's complaint).

import {
  Badge,
  Breadcrumb,
  Button,
  Code,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  HashChip,
  IconButton,
  NavTabs,
  Page,
  PageBody,
  PageHeader,
  SiteAvatar,
  Skeleton,
  Stack,
  Value,
} from '@valet/ui'
import { Activity, Copy, Ellipsis, Pause, Play, ScrollText, ShieldCheck, ShoppingCart } from 'lucide-react'
import type { AdapterDetail, ClientInfo, PendingReview, RunSummary, SiteHealth } from '../../../shared/api'
import { useAction, useApi, useAppStop, useLoad } from '../../lib/api-context'
import { formatClock, formatDay } from '../../lib/format'
import { href, navigate, type SiteTab } from '../../lib/router'
import { healthFor, isFirstReview, type SiteStatus, siteStatus } from '../../lib/site-status'
import { SiteOverview } from './SiteOverview'
import { SitePermissions } from './SitePermissions'
import { SiteTools } from './SiteTools'
import { SiteVersions } from './SiteVersions'
import { ActionError, isPaused, usePauseSite } from './site-ui'

/** Everything a site's tabs show, loaded once by the page. */
export interface SiteData {
  readonly adapter: AdapterDetail
  readonly health: SiteHealth | null
  readonly status: SiteStatus
  readonly review: PendingReview | null
  /** Recent calls to this site, newest first; null until loaded. */
  readonly runs: readonly RunSummary[] | null
  readonly clients: readonly ClientInfo[]
}

const TAB_LABEL: Readonly<Record<SiteTab, string>> = {
  overview: 'Overview',
  tools: 'Tools',
  permissions: 'Permissions',
  versions: 'Versions',
}

export function SitePage({ adapterId, tab }: { readonly adapterId: string; readonly tab: SiteTab }) {
  const detail = useLoad(
    (api) => api.adapters.get(adapterId),
    [adapterId],
    ['adapters-changed', 'grants-changed', 'approvals-changed', 'settings-changed'],
  )
  const sites = useLoad((api) => api.health.sites(), [], ['health-changed'])
  const appStop = useAppStop()
  const reviews = useLoad((api) => api.approvals.pending(), [], ['approvals-changed'])
  const runs = useLoad((api) => api.runs.list({ adapterId, limit: 200 }), [adapterId], ['runs-changed'])
  const clients = useLoad((api) => api.clients.list(), [], ['clients-changed'])

  if (detail.status === 'loading') {
    return (
      <Page>
        <PageHeader
          breadcrumb={<Breadcrumb items={[{ label: 'Sites', href: href.sites() }, { label: '…' }]} />}
          title={<span className="sr-only">Loading</span>}
        />
        <PageBody>
          <Stack gap={3} aria-hidden="true">
            <Skeleton className="h-10" />
            <Skeleton className="h-32" />
          </Stack>
        </PageBody>
      </Page>
    )
  }
  if (detail.status === 'error' || detail.data === null) {
    return (
      <Page>
        <PageHeader
          breadcrumb={<Breadcrumb items={[{ label: 'Sites', href: href.sites() }, { label: adapterId }]} />}
          title={detail.status === 'error' ? 'Couldn’t load this site' : 'No such site'}
        />
        <PageBody width="form">
          <EmptyState
            title={
              detail.status === 'error'
                ? 'Valet couldn’t load it'
                : `No site called “${adapterId}” is installed`
            }
            action={
              <Button asChild>
                <a href={href.sites()}>Go to Sites</a>
              </Button>
            }
          >
            {detail.status === 'error'
              ? 'It tries again when something changes.'
              : 'It may have been removed, or the link is from another Mac.'}
          </EmptyState>
        </PageBody>
      </Page>
    )
  }

  // The settings still to choose, worked out from the settings themselves, so the header, the health
  // line and the store card never disagree.
  const adapter: AdapterDetail = {
    ...detail.data,
    settingsNeeded: detail.data.settings.filter((s) => s.required && s.chosen === null).map((s) => s.title),
  }
  const health = sites.status === 'ready' ? healthFor(adapter, sites.data) : null
  const data: SiteData = {
    adapter,
    health,
    status: siteStatus(adapter, health, appStop),
    review:
      reviews.status === 'ready' ? (reviews.data.find((r) => r.adapterId === adapter.id) ?? null) : null,
    runs: runs.status === 'ready' ? runs.data : null,
    clients: clients.status === 'ready' ? clients.data : [],
  }
  const exposed = adapter.tools.filter((t) => !t.internal).length

  return (
    <Page>
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Sites', href: href.sites() },
              ...(tab === 'overview'
                ? [{ label: adapter.name }]
                : [{ label: adapter.name, href: href.site(adapter.id) }, { label: TAB_LABEL[tab] }]),
            ]}
          />
        }
        leading={<SiteAvatar id={adapter.id} name={adapter.name} size="lg" />}
        title={adapter.name}
        status={<SiteBadge data={data} />}
        description={<HeaderLine adapter={adapter} />}
        actions={<SiteActions data={data} />}
      >
        <NavTabs
          label={`${adapter.name} sections`}
          items={(['overview', 'tools', 'permissions', 'versions'] as const).map((t) => ({
            href: href.site(adapter.id, t),
            label: TAB_LABEL[t],
            active: t === tab,
            ...(t === 'tools' ? { count: exposed } : {}),
            ...(t === 'versions' && adapter.pendingUpdate !== null && adapter.approval === 'approved'
              ? { count: 1, attention: true }
              : {}),
          }))}
        />
      </PageHeader>
      <PageBody className="@container">
        {tab === 'overview' ? (
          <SiteOverview data={data} />
        ) : tab === 'tools' ? (
          <SiteTools data={data} />
        ) : tab === 'permissions' ? (
          <SitePermissions data={data} />
        ) : (
          <SiteVersions data={data} />
        )}
      </PageBody>
    </Page>
  )
}

/** "woolworths 0.3.0 · 9f3c1a7e…e0f1 · approved Fri 6 Nov · 0.4.0 waiting". */
function HeaderLine({ adapter }: { readonly adapter: AdapterDetail }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        adapter
        <Code>
          {adapter.id} {adapter.version}
        </Code>
        <HashChip value={adapter.hash} href={href.site(adapter.id, 'versions')} label="Content hash" />
      </span>
      <Value>{adapter.site}</Value>
      {adapter.approvedAt !== null && adapter.approval === 'approved' ? (
        <span className="whitespace-nowrap">approved {formatDay(adapter.approvedAt)}</span>
      ) : null}
      {adapter.pendingUpdate !== null && adapter.approval === 'approved' ? (
        <span className="whitespace-nowrap">{adapter.pendingUpdate.version} waiting for review</span>
      ) : null}
    </span>
  )
}

/** The one state beside the name, in the words the health line, Needs you and the tool use. */
function SiteBadge({ data }: { readonly data: SiteData }) {
  const { adapter, health, status } = data
  if (adapter.approval === 'rejected') return <Badge tone="danger">Turned down</Badge>
  if (adapter.approval === 'unapproved')
    return <Badge tone="info">{isFirstReview(adapter) ? 'Not approved yet' : 'Update waiting'}</Badge>
  if (isPaused(adapter)) return <Badge>Paused</Badge>
  if (status.fix === 'show-login') return <Badge tone="warning">Waiting for your login</Badge>
  if (status.fix === 'choose-setting')
    return <Badge tone="warning">Needs a {adapter.settingsNeeded[0]?.toLowerCase() ?? 'setting'}</Badge>
  if (status.fix === 'login') return <Badge tone="warning">Needs a login</Badge>
  if (health !== null && health.breaker === 'open')
    return (
      <Badge tone="warning">
        {health.retryAt === null ? 'Limited' : `Limited until ${formatClock(health.retryAt)}`}
      </Badge>
    )
  return null
}

function SiteActions({ data }: { readonly data: SiteData }) {
  const { adapter } = data
  const api = useApi()
  const cart = useAction()
  const copy = useAction()
  const pause = usePauseSite(adapter)
  const paused = isPaused(adapter)
  const approved = adapter.approval === 'approved'
  const canPause = pause.run !== null && approved
  return (
    <>
      {adapter.pendingUpdate !== null && approved ? (
        <Button asChild>
          <a href={href.review(adapter.id)}>Review {adapter.name} update</a>
        </Button>
      ) : null}
      {canPause && !paused ? (
        <Button variant="ghost" leading={<Pause />} loading={pause.busy} onClick={() => pause.run?.(true)}>
          Pause site
        </Button>
      ) : null}
      {adapter.cartUrl !== null && approved ? (
        <Button
          leading={<ShoppingCart />}
          loading={cart.busy}
          onClick={() => void cart.run(() => api.adapters.openCart(adapter.id))}
        >
          Open my trolley
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={`More actions for ${adapter.name}`} icon={<Ellipsis />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<Activity />} onSelect={() => navigate(href.calls({ site: adapter.id }))}>
            Show {adapter.name} calls
          </DropdownMenuItem>
          <DropdownMenuItem icon={<ScrollText />} onSelect={() => navigate(href.audit({ site: adapter.id }))}>
            Show in Audit log
          </DropdownMenuItem>
          {data.review !== null || adapter.approval !== 'approved' ? (
            <DropdownMenuItem icon={<ShieldCheck />} onSelect={() => navigate(href.review(adapter.id))}>
              {adapter.approval === 'approved' ? `Review ${adapter.name} update` : `Review ${adapter.name}`}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            icon={<Copy />}
            onSelect={() => void copy.run(() => api.app.copyText(adapter.id))}
          >
            Copy adapter id
          </DropdownMenuItem>
          {canPause ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={paused ? <Play /> : <Pause />} onSelect={() => pause.run?.(!paused)}>
                {paused ? `Resume ${adapter.name}` : `Pause ${adapter.name}`}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ActionError failed={cart.failed} what="open your trolley" />
      <ActionError failed={pause.failed} what={paused ? `resume ${adapter.name}` : `pause ${adapter.name}`} />
      <ActionError failed={copy.failed} what="copy the adapter id" />
    </>
  )
}
