// One call's trace (#/activity/calls/<callId>): what it was, every fact as a link (site, version,
// tool, app, login used), the outcome in one sentence with its action, the timeline of steps with
// the selected one in the inspector, and the redacted input and output. Where tool results ("see
// call 7F2A") and the repair item land.

import type { AuditRecord } from '@valet/core'
import {
  Banner,
  Breadcrumb,
  Button,
  EmptyState,
  HashChip,
  Heading,
  ObjectLink,
  Page,
  PageBody,
  PageHeader,
  Section,
  Segmented,
  SplitView,
  Stack,
  Text,
  Timeline,
  Value,
} from '@valet/ui'
import { EyeOff, SearchX } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { ClientInfo, RunTrace } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { callRef, formatBytes, formatDuration, formatTime, plural } from '../../lib/format'
import { type NeedsYouView, needsYouView, runNeedsYouAction } from '../../lib/needs-you'
import { type CallFilters, href, navigate } from '../../lib/router'
import {
  askedToRetry,
  blockedExplanation,
  clientLabel,
  errorWording,
  needsUserWording,
  OUTCOME_WORDING,
  stageWording,
  toolPhrase,
} from '../../lib/wording'
import { Fact, OutcomeBadge, PreviewBlock } from './shared'
import { isBlocked, isRequest, offset, StepDetails, stepItem } from './trace-steps'

type View = 'timeline' | 'requests' | 'blocked'

export function CallTrace({ callId, filters }: { readonly callId: string; readonly filters: CallFilters }) {
  const trace = useLoad((api) => api.runs.trace(callId), [callId], ['runs-changed'])
  // The call's audit records: how many there are, and which credential (client) made it.
  const records = useLoad(
    (api) => api.audit.page({ search: callId, limit: 200 }),
    [callId],
    ['audit-appended'],
  )
  const ref = callRef(callId)
  const crumbs = (
    <Breadcrumb
      items={[
        { label: 'Activity', href: href.calls() },
        { label: 'Calls', href: href.calls(filters) },
        { label: ref },
      ]}
    />
  )
  if (trace.status !== 'ready' || trace.data === null) {
    return (
      <Page>
        <PageHeader breadcrumb={crumbs} title={`Call ${ref}`} />
        <PageBody>
          {trace.status === 'error' ? (
            <Banner tone="danger" title="Valet couldn’t load this call.">
              It tries again when a call changes.
            </Banner>
          ) : trace.status === 'ready' ? (
            <NoSuchCall callId={callId} filters={filters} />
          ) : null}
        </PageBody>
      </Page>
    )
  }
  const own =
    records.status === 'ready'
      ? records.data.records.filter((r) => 'callId' in r.event && r.event.callId === callId)
      : null
  return <Trace trace={trace.data} crumbs={crumbs} records={own} />
}

function NoSuchCall({ callId, filters }: { readonly callId: string; readonly filters: CallFilters }) {
  const settings = useLoad((api) => api.settings.get(), [], ['settings-changed'])
  const days = settings.status === 'ready' ? settings.data.traceRetentionDays : null
  return (
    <EmptyState
      icon={<SearchX />}
      title={`No call ${callRef(callId)}`}
      action={
        <>
          <Button variant="primary" asChild>
            <a href={href.calls(filters)}>All calls</a>
          </Button>
          <Button asChild>
            <a href={href.audit({ call: callId })}>Look in the audit log</a>
          </Button>
        </>
      }
    >
      Valet has no trace for this call.{' '}
      {days === null
        ? 'Traces are deleted after a while,'
        : `Traces are deleted after ${plural(days, 'day')},`}{' '}
      but the audit log keeps the record of every call.
    </EmptyState>
  )
}

function firstInteresting(trace: RunTrace): number {
  const at = trace.steps.findIndex(
    (s) => isBlocked(s) || s.type === 'failed' || s.type === 'needs-user' || s.type === 'confirmation',
  )
  return at === -1 ? 0 : at
}

function Trace({
  trace,
  crumbs,
  records,
}: {
  readonly trace: RunTrace
  readonly crumbs: ReactNode
  readonly records: readonly AuditRecord[] | null
}) {
  const { summary } = trace
  const now = useNow(60_000)
  const [view, setView] = useState<View>('timeline')
  const [selected, setSelected] = useState(() => firstInteresting(trace))
  const attention = useLoad((api) => api.attention.list(), [], ['attention-changed'])
  const waiting =
    attention.status === 'ready'
      ? (attention.data
          .map((item) => needsYouView(item, () => false))
          .find((v) => v.callId === summary.callId && !v.missed) ?? null)
      : null

  const blocked = trace.steps.flatMap((s, i) => (isBlocked(s) ? [{ step: s, index: i }] : []))
  const shown = trace.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) =>
      view === 'timeline'
        ? true
        : view === 'requests'
          ? isRequest(step) || step.type === 'probe'
          : isBlocked(step),
    )
  const step = trace.steps[selected] ?? trace.steps[0]
  const secrets = [...new Set(trace.secretsUsed.map((s) => s.secret))]
  const fieldsOf = (secret: string) =>
    trace.secretsUsed.filter((s) => s.secret === secret).map((s) => s.field)

  return (
    <Page>
      <PageHeader
        breadcrumb={crumbs}
        // "Added to the trolley" only when it did; any other outcome names the call, not a result.
        title={
          summary.outcome === 'ok'
            ? toolPhrase(summary.tool)
            : `Call ${callRef(summary.callId)} · ${summary.tool}`
        }
        status={<OutcomeBadge run={summary} />}
        actions={
          <>
            <Value mono copy={summary.callId} title={summary.callId}>
              {callRef(summary.callId)}
            </Value>
            <Button asChild>
              <a href={href.audit({ call: summary.callId })}>
                {records === null ? 'Audit records' : `Audit records (${records.length})`}
              </a>
            </Button>
          </>
        }
      >
        <dl className="m-0 flex flex-wrap gap-x-5 gap-y-3 pb-4">
          <Fact term="Site">
            <ObjectLink href={href.site(summary.adapterId)}>{summary.adapterName}</ObjectLink>
          </Fact>
          <Fact term="Version">
            <ObjectLink mono href={href.site(summary.adapterId, 'versions')}>
              {trace.adapterVersion}
            </ObjectLink>
            {trace.adapterHash !== '' ? <HashChip value={trace.adapterHash} label="adapter hash" /> : null}
          </Fact>
          <Fact term="Tool">
            <ObjectLink mono href={href.calls({ site: summary.adapterId, tool: summary.tool })}>
              {summary.tool}
            </ObjectLink>
          </Fact>
          <Fact term="App">
            <AppLink reported={summary.client} records={records} />
          </Fact>
          <Fact term="When">
            {formatTime(summary.startedAt, now)} · {formatDuration(summary.durationMs)}
          </Fact>
          <Fact term="Login used">
            {secrets.length === 0 ? (
              <span className="text-fg-muted">None</span>
            ) : (
              secrets.map((secret) => (
                <ObjectLink key={secret} href={href.login(summary.adapterId, secret)}>
                  {secret} ({fieldsOf(secret).join(', ')})
                </ObjectLink>
              ))
            )}
          </Fact>
          <Fact term="Requests">
            {trace.requests.sent === null || trace.requests.probes === null
              ? `${trace.requests.blocked} blocked`
              : `${trace.requests.sent} sent (${plural(trace.requests.probes, 'check')}) · ${trace.requests.blocked} blocked`}
          </Fact>
        </dl>
      </PageHeader>
      <SplitView
        // A trace has no list beside it: only the timeline and its inspector.
        className="[&>div>div:first-child]:hidden"
        list={null}
        listWidth={0}
        inspectorWidth={340}
        detail={
          <div className="flex flex-col gap-5 px-6 py-5">
            <OutcomeBanner trace={trace} waiting={waiting} onShowBlocked={() => setView('blocked')} />
            <Stack gap={3}>
              <div className="flex flex-wrap items-center gap-2">
                <Heading level={2} size="group" className="flex-1">
                  Steps
                </Heading>
                <Segmented<View>
                  label="Show"
                  size="sm"
                  value={view}
                  onValueChange={setView}
                  options={[
                    { value: 'timeline', label: 'Timeline' },
                    { value: 'requests', label: 'Requests' },
                    ...(blocked.length > 0 ? [{ value: 'blocked' as const, label: 'Blocked only' }] : []),
                  ]}
                />
              </div>
              <Timeline
                label="Steps"
                items={shown.map(({ step: s, index }) => stepItem(s, String(index)))}
                selected={String(selected)}
                onSelect={(id) => setSelected(Number(id))}
              />
            </Stack>
            {blocked.length > 0 ? (
              <Section
                id="blocked-requests"
                title={blocked.length === 1 ? 'Blocked request' : 'Blocked requests'}
                description="Valet refused these before they left your Mac. Nothing was sent."
              >
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {blocked.map(({ step: b, index }) => (
                    <li
                      key={index}
                      className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md bg-warning-soft px-3 py-2 ring-[0.5px] ring-warning-border ring-inset"
                    >
                      <div className="flex min-w-[min(100%,16rem)] flex-1 flex-col gap-0.5">
                        <Value mono className="font-semibold">
                          {b.method} {b.target}
                        </Value>
                        <Text size="sm">
                          {b.initiator === 'page' ? 'The site’s own page scripts' : 'Tool code'} asked for
                          this. {b.blockedReason !== null ? blockedExplanation(b.blockedReason) : ''}
                        </Text>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(index)}>
                        Show step at {offset(b.atMs)}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            <Section title={`Input from ${clientLabel(summary.client)}`}>
              <PreviewBlock parts={trace.input} label="Input" />
            </Section>
            <Section
              title="Output sent to the app"
              actions={
                trace.outputBytes !== null ? (
                  <Text tone="subtle" size="sm">
                    {formatBytes(trace.outputBytes)}
                  </Text>
                ) : null
              }
            >
              {trace.output === null ? (
                <Text tone="muted">
                  No output:{' '}
                  {summary.outcome === 'needsUser'
                    ? 'the call stopped to wait for you'
                    : `the call ended ${OUTCOME_WORDING[summary.outcome]}`}
                  {summary.stage !== null && summary.errorClass !== null
                    ? ` (${stageWording(summary.stage)}: ${errorWording(summary.errorClass)})`
                    : ''}
                  {summary.needsUser !== null ? ` (${needsUserWording(summary.needsUser).short})` : ''}. The
                  app was told only the code.
                </Text>
              ) : (
                <PreviewBlock parts={trace.output} label="Output" />
              )}
              <Text tone="subtle" size="sm" className="flex items-start gap-1.5">
                <EyeOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                Valet knows every secret it filled and the current cookie values, and replaces exact matches
                in results and traces before anything leaves the app.
              </Text>
            </Section>
          </div>
        }
        inspector={
          step === undefined ? null : (
            <section aria-label="Step details" className="px-4 py-5">
              <StepDetails step={step} trace={trace} />
            </section>
          )
        }
      />
    </Page>
  )
}

/**
 * The app that made the call. The credential's client (from the call's tool-called record) is who
 * it really was, so that links to its page; the reported name is only a claim, shown as one.
 */
function AppLink({
  reported,
  records,
}: {
  readonly reported: string
  readonly records: readonly AuditRecord[] | null
}) {
  const clients = useLoad((api) => api.clients.list(), [], ['clients-changed'])
  const called = records?.find((r) => r.event.type === 'tool-called')?.event
  const clientId = called?.type === 'tool-called' ? called.clientId : undefined
  const local = clientId?.startsWith('local:') ? clientId.slice('local:'.length) : null
  const client: ClientInfo | undefined =
    local !== null && clients.status === 'ready' ? clients.data.find((c) => c.id === local) : undefined
  const claim = (
    <span
      className="text-fg-muted"
      title="The name this app reported. Any app with the endpoint token can report any name."
    >
      calls itself “{clientLabel(reported)}”
    </span>
  )
  if (client !== undefined)
    return (
      <>
        <ObjectLink href={href.client(client.id)}>{client.name}</ObjectLink>
        {client.reportedName !== reported ? claim : null}
      </>
    )
  if (clientId?.startsWith('remote:'))
    return (
      <>
        <ObjectLink href={href.client(clientId.slice('remote:'.length))}>A cloud agent</ObjectLink>
        {claim}
      </>
    )
  return (
    <ObjectLink href={href.calls({ client: reported })}>
      <span title="The name this app reported. Any app with the endpoint token can report any name.">
        “{clientLabel(reported)}”
      </span>
    </ObjectLink>
  )
}

function OutcomeBanner({
  trace,
  waiting,
  onShowBlocked,
}: {
  readonly trace: RunTrace
  readonly waiting: NeedsYouView | null
  readonly onShowBlocked: () => void
}) {
  const api = useApi()
  const action = useAction()
  const { summary } = trace
  const openSite = (
    <Button size="sm" asChild>
      <a href={href.site(summary.adapterId)}>Open {summary.adapterName}</a>
    </Button>
  )
  if (summary.outcome === 'ok') {
    if (trace.requests.blocked === 0) return null
    return (
      <Banner
        tone="warning"
        title={`It worked, but Valet blocked ${plural(trace.requests.blocked, 'request')} the adapter didn’t declare.`}
        action={
          <Button size="sm" onClick={onShowBlocked}>
            Show blocked only
          </Button>
        }
      >
        Nothing was sent for them. If this keeps happening, the site may have changed.
      </Banner>
    )
  }
  if (summary.outcome === 'running') return <Banner tone="info" title="This call is still running." />
  if (summary.outcome === 'needsUser')
    return (
      <Banner
        tone="warning"
        title={`It stopped to wait for you: ${summary.needsUser === null ? 'Needs you' : needsUserWording(summary.needsUser).short}.`}
        action={
          waiting !== null ? (
            <Button
              size="sm"
              variant="primary"
              loading={action.busy}
              onClick={() => void action.run(() => runNeedsYouAction(api, waiting.action, navigate))}
            >
              {waiting.actionLabel}
            </Button>
          ) : null
        }
      >
        {summary.needsUser === null ? null : needsUserWording(summary.needsUser).detail}
      </Banner>
    )
  if (summary.outcome === 'declined')
    return (
      <Banner tone="neutral" title="You said no, so nothing was changed.">
        The app was told the call was declined.
      </Banner>
    )
  if (askedToRetry(summary))
    return (
      <Banner tone="info" title="Valet asked the app to call again.">
        {summary.errorClass === null ? null : errorWording(summary.errorClass)}. Nothing went wrong; the next
        call from the same app usually follows within seconds.
      </Banner>
    )
  return (
    <Banner
      tone="danger"
      title={
        summary.stage !== null && summary.errorClass !== null
          ? `Stopped at ${stageWording(summary.stage)}: ${errorWording(summary.errorClass)}.`
          : summary.outcome === 'blocked'
            ? `${summary.adapterName} refused the call.`
            : 'The call failed.'
      }
      action={openSite}
    >
      Nothing more was sent to {summary.adapterName}. The app was told only the code, and can see it in Valet
      as call {callRef(summary.callId)}.
    </Banner>
  )
}
