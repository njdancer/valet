// Activity › Calls (#/activity/calls, mod+3): every tool call, newest first, with the short ref that
// tool results and Claude quote. Every filter is in the address (href.calls), so a link from a site,
// a login or the menu bar can name the exact list, and Back undoes a filter. A call opens its trace
// (CallTrace) at #/activity/calls/<callId>.

import {
  Banner,
  Button,
  EmptyState,
  FilterBar,
  FilterChip,
  Inline,
  ObjectLink,
  Page,
  PageBody,
  PageHeader,
  RowLink,
  Spacer,
  Table,
  TBody,
  TD,
  Text,
  TextLink,
  TH,
  THead,
  TR,
} from '@valet/ui'
import { History, SearchX } from 'lucide-react'
import type { RunSummary } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { callRef, formatTime } from '../../lib/format'
import { type NeedsYouView, needsYouView, runNeedsYouAction } from '../../lib/needs-you'
import { CALL_OUTCOMES, type CallFilters, href, navigate } from '../../lib/router'
import { clientLabel, toolPhrase } from '../../lib/wording'
import { CallTrace } from './CallTrace'
import {
  describeFilters,
  foldRetries,
  type ListedRun,
  matchesFilters,
  OUTCOME_LABELS,
  parseLogin,
} from './calls-list'
import { ActivityTabs, FilterMenu, OutcomeBadge } from './shared'

export function CallsPage({
  callId,
  filters,
}: {
  readonly callId: string | null
  readonly filters: CallFilters
}) {
  if (callId !== null) return <CallTrace key={callId} callId={callId} filters={filters} />
  return <CallsList filters={filters} />
}

/** The number of calls the list loads; older ones are in the Audit log. */
export const LIST_LIMIT = 200

function CallsList({ filters }: { readonly filters: CallFilters }) {
  const runs = useLoad((api) => api.runs.list({ limit: LIST_LIMIT }), [], ['runs-changed'])
  const adapters = useLoad((api) => api.adapters.list(), [], ['adapters-changed'])
  const settings = useLoad((api) => api.settings.get(), [], ['settings-changed'])
  const attention = useLoad((api) => api.attention.list(), [], ['attention-changed'])
  const login = filters.login === null ? null : parseLogin(filters.login)
  // Which calls used a login is in the audit log's login-use records, not in the call summaries.
  const loginUse = useLoad(
    (api) =>
      login === null
        ? Promise.resolve(null)
        : api.audit.page({ category: 'secret-use', adapterId: login.site, limit: 500 }),
    [filters.login],
    ['audit-appended'],
  )
  const now = useNow(60_000)

  const loginCalls =
    login === null || loginUse.status !== 'ready' || loginUse.data === null
      ? null
      : new Set(
          loginUse.data.records.flatMap((r) =>
            r.event.type === 'secret-used' && r.event.secret === login.secret && r.event.callId !== null
              ? [r.event.callId]
              : [],
          ),
        )
  const list = runs.status === 'ready' ? runs.data : []
  const shown = foldRetries(list).filter(({ run }) => matchesFilters(run, filters, loginCalls))
  const siteName = (id: string) =>
    (adapters.status === 'ready' ? adapters.data.find((a) => a.id === id)?.name : undefined) ??
    list.find((r) => r.adapterId === id)?.adapterName ??
    id
  const waiting = new Map<string, NeedsYouView>()
  if (attention.status === 'ready')
    for (const item of attention.data) {
      const view = needsYouView(item, () => false)
      if (view.callId !== null && !view.missed) waiting.set(view.callId, view)
    }

  const filtered = Object.values(filters).some((v) => v !== null)
  const sites = [...new Map(list.map((r) => [r.adapterId, r.adapterName])).entries()]
  const tools = [
    ...new Set(list.filter((r) => filters.site === null || r.adapterId === filters.site).map((r) => r.tool)),
  ]
  const clients = [...new Set(list.map((r) => r.client))]
  const retention = settings.status === 'ready' ? settings.data.traceRetentionDays : null

  return (
    <Page>
      <PageHeader
        title="Calls"
        description="Every tool call an app made through Valet, newest first."
        actions={
          <>
            {runs.status === 'ready' ? (
              <Text tone="muted" size="sm" aria-live="polite">
                {filtered
                  ? `${shown.length} of ${list.length} ${list.length === 1 ? 'call' : 'calls'}`
                  : `${list.length} ${list.length === 1 ? 'call' : 'calls'}`}
              </Text>
            ) : null}
            {retention !== null ? (
              <Text tone="subtle" size="sm">
                Traces kept {retention} {retention === 1 ? 'day' : 'days'} ·{' '}
                <TextLink href={href.settings('data')}>Change</TextLink>
              </Text>
            ) : null}
          </>
        }
      >
        <ActivityTabs active="calls" />
      </PageHeader>
      <FilterBar aria-label="Filter calls">
        <FilterMenu
          label="Site"
          value={filters.site}
          options={sites.map(([value, label]) => ({ value, label }))}
          // A tool belongs to its site, so changing the site drops the tool.
          to={(site) => href.calls({ ...filters, site, tool: null })}
        />
        <FilterMenu
          label="Tool"
          value={filters.tool}
          options={tools.map((t) => ({ value: t, label: t }))}
          to={(tool) => href.calls({ ...filters, tool })}
        />
        <FilterMenu
          label="App"
          value={filters.client}
          options={clients.map((c) => ({ value: c, label: clientLabel(c) }))}
          to={(client) => href.calls({ ...filters, client })}
        />
        <FilterMenu
          label="Outcome"
          value={filters.outcome}
          options={CALL_OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABELS[o] }))}
          to={(outcome) => href.calls({ ...filters, outcome: outcome as CallFilters['outcome'] })}
        />
        {filters.login !== null ? (
          <FilterChip
            label="Login used"
            value={login === null ? filters.login : `${siteName(login.site)} ${login.secret}`}
            onRemove={() => navigate(href.calls({ ...filters, login: null }))}
            onClick={login === null ? undefined : () => navigate(href.login(login.site, login.secret))}
          />
        ) : null}
        <Spacer />
        {filtered ? (
          <Button size="sm" variant="ghost" asChild>
            <a href={href.calls()}>Clear filters</a>
          </Button>
        ) : null}
      </FilterBar>
      <PageBody>
        {login !== null ? (
          <Banner
            tone="neutral"
            title={`Calls that used your ${siteName(login.site)} login “${login.secret}”`}
            action={
              <Button size="sm" asChild>
                <a href={href.login(login.site, login.secret)}>Back to the login</a>
              </Button>
            }
          >
            Taken from the audit log’s login-use records, which are kept for good; traces are kept for a
            shorter time.
          </Banner>
        ) : null}
        {runs.status === 'error' ? (
          <Banner tone="danger" title="Valet couldn’t load the calls.">
            It tries again when a call changes.
          </Banner>
        ) : runs.status === 'loading' ? null : list.length === 0 ? (
          <EmptyState
            icon={<History />}
            title="No calls yet"
            action={
              <Button variant="primary" asChild>
                <a href={href.connections()}>Connect an app</a>
              </Button>
            }
          >
            When an app such as Claude uses one of your sites, each call shows up here with a short reference
            like 7F2A that it can quote.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title={`No ${describeFilters(filters, siteName)}`}
            action={
              <Button variant="primary" asChild>
                <a href={href.calls()}>Clear filters</a>
              </Button>
            }
          >
            <span aria-live="polite">
              None of the newest {list.length} {list.length === 1 ? 'call matches' : 'calls match'} these
              filters.
            </span>
          </EmptyState>
        ) : (
          <CallsTable rows={shown} filters={filters} waiting={waiting} now={now} />
        )}
        {list.length === LIST_LIMIT ? (
          <Text tone="muted" size="sm">
            Showing the newest {LIST_LIMIT}. Older calls are in the{' '}
            <TextLink href={href.audit({ category: 'tool-calls' })}>Audit log</TextLink>.
          </Text>
        ) : null}
      </PageBody>
    </Page>
  )
}

function CallsTable({
  rows,
  filters,
  waiting,
  now,
}: {
  readonly rows: readonly ListedRun[]
  readonly filters: CallFilters
  readonly waiting: ReadonlyMap<string, NeedsYouView>
  readonly now: number
}) {
  return (
    <Table aria-label="Tool calls">
      <THead>
        <tr>
          <TH>Ref</TH>
          <TH>Time</TH>
          <TH>Site · tool · what it did</TH>
          <TH>App</TH>
          <TH>Outcome</TH>
          <TH>
            <span className="sr-only">Action</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {rows.map(({ run, retries, firstRetry }) => (
          <CallRow
            key={run.callId}
            run={run}
            retries={retries}
            firstRetry={firstRetry}
            filters={filters}
            waiting={waiting.get(run.callId) ?? null}
            now={now}
          />
        ))}
      </TBody>
    </Table>
  )
}

// Positioned after the row link's click area in the DOM, so they paint (and click) above it, while
// staying under the sticky table header.
const ABOVE = 'relative'

function CallRow({
  run,
  retries,
  firstRetry,
  filters,
  waiting,
  now,
}: {
  readonly run: RunSummary
  readonly retries: number
  readonly firstRetry: string | null
  readonly filters: CallFilters
  readonly waiting: NeedsYouView | null
  readonly now: number
}) {
  const api = useApi()
  const action = useAction()
  return (
    <TR interactive>
      <TD className="w-0">
        <RowLink href={href.call(run.callId, filters)} className="selectable font-mono">
          <span className="sr-only">Call</span> {callRef(run.callId)}
        </RowLink>
      </TD>
      <TD className="w-0 whitespace-nowrap text-fg-muted tabular">{formatTime(run.startedAt, now)}</TD>
      <TD className="w-full max-w-0 py-1.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Inline gap={1.5} wrap={false} className="min-w-0">
            <ObjectLink href={href.site(run.adapterId)} className={`${ABOVE} shrink-0`}>
              {run.adapterName}
            </ObjectLink>
            <span aria-hidden="true" className="text-fg-subtle">
              ·
            </span>
            <ObjectLink
              href={href.calls({ ...filters, site: run.adapterId, tool: run.tool })}
              mono
              className={`${ABOVE} min-w-0`}
            >
              {run.tool}
            </ObjectLink>
          </Inline>
          <span className="flex min-w-0 gap-1 text-sm text-fg-muted">
            <span className="truncate">
              {toolPhrase(run.tool)}
              {run.detail === null ? null : <>: {run.detail}</>}
            </span>
            {retries === 0 || firstRetry === null ? null : (
              <span className="shrink-0 whitespace-nowrap">
                {'· after '}
                <ObjectLink href={href.call(firstRetry, filters)} className={ABOVE}>
                  {retries === 1 ? 'a retry' : `${retries} retries`}
                </ObjectLink>
              </span>
            )}
          </span>
        </div>
      </TD>
      <TD className="w-0 whitespace-nowrap">
        {/* The name is what the app said it is: a claim, so it filters calls by it rather than naming a client. */}
        <ObjectLink href={href.calls({ ...filters, client: run.client })} className={ABOVE}>
          <span title="The name this app reported. Any app with the endpoint token can report any name.">
            {clientLabel(run.client)}
          </span>
        </ObjectLink>
      </TD>
      <TD className="w-0 whitespace-nowrap">
        <OutcomeBadge run={run} />
      </TD>
      <TD className="w-0 whitespace-nowrap" align="right">
        {waiting !== null ? (
          <Button
            size="sm"
            className={ABOVE}
            loading={action.busy}
            onClick={() => void action.run(() => runNeedsYouAction(api, waiting.action, navigate))}
          >
            {waiting.actionLabel}
          </Button>
        ) : null}
      </TD>
    </TR>
  )
}
