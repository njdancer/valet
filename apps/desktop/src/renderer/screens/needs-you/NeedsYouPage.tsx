// Needs you (IA section 5): the one inbox. Every waiting thing is an item with its own action, sorted
// by deadline, then by age; missed items stay a day under their own heading. With nothing waiting it
// says so and shows the system status instead: each site's health, the endpoint, the audit chain.

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DeadlineChip,
  EmptyState,
  HealthLine,
  InboxItem,
  Page,
  PageBody,
  PageHeader,
  Section,
  SiteAvatar,
  Stack,
  Text,
  TextLink,
} from '@valet/ui'
import { CheckCircle2, RotateCw } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { callRef, formatClock, formatTime, plural } from '../../lib/format'
import { type NeedsYouView, needsYouOrder, needsYouView, runNeedsYouAction } from '../../lib/needs-you'
import { href, navigate } from '../../lib/router'
import { healthFor, isFirstReview, siteStatus } from '../../lib/site-status'
import { useSetupLeft } from '../setup/setup-logic'

export function NeedsYouPage({ item }: { readonly item: string | null }) {
  const api = useApi()
  const attention = useLoad((a) => a.attention.list(), [], ['attention-changed'])
  const adapters = useLoad((a) => a.adapters.list(), [], ['adapters-changed', 'approvals-changed'])
  const now = useNow(1000)
  const unapproved = new Set(
    adapters.status === 'ready' ? adapters.data.filter(isFirstReview).map((a) => a.id) : [],
  )
  const views =
    attention.status === 'ready'
      ? needsYouOrder(attention.data.map((i) => needsYouView(i, (id) => unapproved.has(id))))
      : []
  const waiting = views.filter((v) => !v.missed)
  const missed = views.filter((v) => v.missed)
  const soonest = waiting.find((v) => v.deadline !== null)
  // Skipped setup steps wait as one item, as in the menu bar (IA section 5, "Setup unfinished").
  const setupLeft = useSetupLeft()
  const count = waiting.length + (setupLeft === null ? 0 : 1)

  // A notification's deep link (#/needs-you/<id>) runs that item's action once, when it has loaded.
  const target = item === null ? null : (views.find((v) => v.id === item) ?? null)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (target === null || target.missed || handled.current === target.id) return
    handled.current = target.id
    void runNeedsYouAction(api, target.action, navigate).catch(() => undefined)
    // The item's own window took over; this window stays on the list.
    if (target.action.kind !== 'route') {
      window.history.replaceState(null, '', href.needsYou())
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
  }, [api, target])

  return (
    <Page>
      <PageHeader
        title="Needs you"
        description={
          count === 0
            ? null
            : 'Things only you can answer. Each one waits here, in the menu bar and in its notification.'
        }
        status={
          attention.status !== 'ready' ? null : count === 0 ? (
            <Text tone="muted">Nothing waiting</Text>
          ) : (
            <>
              <Text tone="muted">{count} waiting</Text>
              {soonest?.deadline != null ? (
                <DeadlineChip until={soonest.deadline} now={now} subject={soonest.title} />
              ) : (
                <Text tone="muted">· none time-limited</Text>
              )}
            </>
          )
        }
        actions={
          <Button variant="ghost" size="sm" asChild>
            <a href={href.settings('notifications')}>Notification settings</a>
          </Button>
        }
      />
      <PageBody width="form">
        {attention.status === 'error' ? (
          <Text tone="muted">Valet couldn’t load what’s waiting. It tries again when something changes.</Text>
        ) : attention.status === 'loading' ? null : count === 0 ? (
          <NothingWaiting />
        ) : (
          <ul aria-label="Waiting for you" className="m-0 flex list-none flex-col gap-3 p-0">
            {setupLeft !== null ? <FinishSetupRow left={setupLeft} /> : null}
            {waiting.map((v) => (
              <NeedsYouRow key={v.id} view={v} now={now} />
            ))}
          </ul>
        )}
        {missed.length > 0 ? (
          <Section
            title="Missed in the last 24 hours"
            description="Nobody answered these in time, so the call was told so."
          >
            <ul aria-label="Missed" className="m-0 flex list-none flex-col gap-2 p-0">
              {missed.map((v) => (
                <MissedRow key={v.id} view={v} />
              ))}
            </ul>
          </Section>
        ) : null}
        {count > 0 ? <StatusCard /> : null}
      </PageBody>
    </Page>
  )
}

function NeedsYouRow({ view, now }: { readonly view: NeedsYouView; readonly now: number }) {
  const api = useApi()
  const action = useAction()
  return (
    <InboxItem
      tone={
        view.deadline !== null && view.deadline - now < 30_000
          ? 'danger'
          : view.tone === 'danger'
            ? 'accent'
            : view.tone
      }
      icon={
        view.adapterId !== null ? (
          <SiteAvatar id={view.adapterId} name={view.adapterName ?? '?'} size="md" />
        ) : null
      }
      title={view.title}
      description={
        <>
          {view.description}
          {view.callId !== null ? (
            <>
              {view.description ? ' ' : null}
              Raised by call{' '}
              <TextLink href={href.call(view.callId)} className="font-mono">
                {callRef(view.callId)}
              </TextLink>
              .
            </>
          ) : null}
        </>
      }
      meta={
        view.deadline !== null ? <DeadlineChip until={view.deadline} now={now} subject={view.title} /> : null
      }
      action={
        <Button
          variant={view.kind === 'confirmation' ? 'primary' : 'secondary'}
          size="sm"
          loading={action.busy}
          onClick={() => void action.run(() => runNeedsYouAction(api, view.action, navigate))}
        >
          {view.actionLabel}
        </Button>
      }
    />
  )
}

function FinishSetupRow({ left }: { readonly left: number }) {
  return (
    <InboxItem
      tone="accent"
      icon={<RotateCw aria-hidden="true" className="size-5 text-fg-muted" />}
      title={`Finish setup (${plural(left, 'step')} left)`}
      description="About 5 minutes. Claude can use Woolworths once it’s done."
      action={
        <Button variant="secondary" size="sm" asChild>
          <a href={href.setup()}>Continue setup</a>
        </Button>
      }
    />
  )
}

function MissedRow({ view }: { readonly view: NeedsYouView }) {
  const api = useApi()
  const action = useAction()
  const sentence = `Valet asked me "${view.title.replace(/^Missed: /, '')}" and I missed it. Please try again.`
  return (
    <InboxItem
      missed
      title={view.title}
      description={view.callId !== null ? `Call ${callRef(view.callId)}` : null}
      action={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void action.run(() => api.attention.dismiss(view.id))}
          >
            Dismiss
          </Button>
          <Button size="sm" onClick={() => void action.run(() => api.app.copyText(sentence))}>
            Copy “try again” for Claude
          </Button>
        </>
      }
    />
  )
}

function NothingWaiting() {
  return (
    <Stack gap={6}>
      <EmptyState icon={<CheckCircle2 />} title="Nothing needs you">
        When an agent needs your yes, a login or a review, it shows up here, in the menu bar and as a
        notification.
      </EmptyState>
      <StatusCard />
    </Stack>
  )
}

/** The system status (IA principle 8): every line says when it was checked and can be re-checked. */
function StatusCard() {
  const api = useApi()
  const now = useNow(60_000)
  const adapters = useLoad((a) => a.adapters.list(), [], ['adapters-changed', 'approvals-changed'])
  const sites = useLoad((a) => a.health.sites(), [], ['health-changed'])
  const endpoint = useLoad((a) => a.endpoint.status(), [], ['endpoint-changed'])
  const chain = useLoad((a) => a.audit.chainStatus(), [], ['audit-appended', 'audit-verified'])
  const stats = useLoad((a) => a.runs.statsToday(), [], ['runs-changed'])
  const verify = useAction()
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Status</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          loading={verify.busy}
          onClick={() => void verify.run(() => api.audit.verify())}
        >
          Check audit log now
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {adapters.status === 'ready'
          ? adapters.data.map((a) => {
              const s = siteStatus(a, sites.status === 'ready' ? healthFor(a, sites.data) : null)
              return (
                <HealthLine
                  key={a.id}
                  tone={s.tone}
                  action={
                    <Button size="sm" variant="secondary" asChild>
                      <a href={href.site(a.id)}>Open {a.name}</a>
                    </Button>
                  }
                >
                  <span className="font-medium text-fg">{a.name}</span> · {s.text}
                </HealthLine>
              )
            })
          : null}
        {endpoint.status === 'ready' ? (
          <HealthLine
            tone={endpoint.data.listening ? 'success' : 'neutral'}
            action={
              <Button size="sm" variant="secondary" asChild>
                <a href={href.connections()}>Connections</a>
              </Button>
            }
          >
            {endpoint.data.listening
              ? `Endpoint on · ${endpoint.data.connectedClients === 1 ? '1 app' : `${endpoint.data.connectedClients} apps`} connected`
              : 'Endpoint off · apps on this Mac can’t reach Valet'}
          </HealthLine>
        ) : null}
        {chain.status === 'ready' ? (
          <HealthLine
            tone={
              chain.data.state === 'broken' ? 'danger' : chain.data.state === 'intact' ? 'success' : 'neutral'
            }
            action={
              <Button size="sm" variant="secondary" asChild>
                <a
                  href={chain.data.state === 'broken' ? href.audit({}, chain.data.firstBadSeq) : href.audit()}
                >
                  {chain.data.state === 'broken' ? 'See where' : 'Audit log'}
                </a>
              </Button>
            }
          >
            {chain.data.state === 'broken'
              ? `The audit log doesn’t check out from record ${chain.data.firstBadSeq}`
              : chain.data.state === 'intact'
                ? // As of the last check: records written since aren't checked yet, so it names where it got to.
                  `Audit log checked ${formatTime(chain.data.verifiedAt, now)} · checks out up to record ${chain.data.headSeq}`
                : 'Audit log not checked yet'}
          </HealthLine>
        ) : null}
        {stats.status === 'ready' ? (
          <Text tone="muted" size="sm">
            Today: <TextLink href={href.calls()}>{stats.data.toolCalls} calls</TextLink> ·{' '}
            <TextLink href={href.audit({ category: 'logins' })}>
              {stats.data.loginsFailed} logins failed
            </TextLink>{' '}
            ·{' '}
            <TextLink href={href.audit({ category: 'blocked' })}>
              {stats.data.blockedRequests} requests blocked
            </TextLink>
            {' · '}as of {formatClock(now)}
          </Text>
        ) : null}
      </CardContent>
    </Card>
  )
}
