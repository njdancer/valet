// A site's Overview (wireframes `site-overview*`): the review it waits for, its health line with the
// fix beside it, then one card per thing the person sets or watches: store, login, trolley, today's
// calls and who made them, and what a call can reach.

import {
  Badge,
  Banner,
  Button,
  CanReach,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  DescriptionList,
  Disclosure,
  HashChip,
  HealthLine,
  Inline,
  ObjectLink,
  Spacer,
  Stack,
  Text,
  TextLink,
  Value,
} from '@valet/ui'
import { type ReactNode, useState } from 'react'
import type { AdapterDetail, ClientInfo, PendingReview, RunSummary } from '../../../shared/api'
import { useAction, useApi, useNow } from '../../lib/api-context'
import { callRef, formatAgo, formatClock, formatTime, hostOf, plural } from '../../lib/format'
import { href } from '../../lib/router'
import {
  clientLabel,
  FIELD_WORDING,
  needsUserWording,
  PROVIDER_WORDING,
  SESSION_WORDING,
} from '../../lib/wording'
import type { SiteData } from './SitePage'
import { ActionError, callers, callsToday, SiteFixButton, SiteText } from './site-ui'

export function SiteOverview({ data }: { readonly data: SiteData }) {
  const { adapter, status, review } = data
  const approved = adapter.approval === 'approved'
  // A review, when one waits, has the page's one primary button; the health line's fix steps back.
  const reviewBanner = !approved || (review !== null && adapter.pendingUpdate !== null)
  const healthSaysReview = status.fix === 'review' || status.fix === 'review-update'
  return (
    <Stack gap={4}>
      {!approved ? (
        <FirstReviewBanner adapter={adapter} />
      ) : review !== null && adapter.pendingUpdate !== null ? (
        <UpdateBanner adapter={adapter} review={review} />
      ) : null}
      {healthSaysReview && reviewBanner ? null : <Health data={data} primary={!reviewBanner} />}
      <div className="grid grid-cols-1 items-start gap-4 @min-[720px]:grid-cols-2">
        <Stack gap={4}>
          {adapter.settings.map((s) => (
            <SettingCard key={s.name} adapter={adapter} name={s.name} />
          ))}
          <LoginCard adapter={adapter} />
          {adapter.cartUrl !== null && approved ? <TrolleyCard adapter={adapter} /> : null}
        </Stack>
        <Stack gap={4}>
          <TodayCard adapter={adapter} runs={data.runs} clients={data.clients} />
          <ReachCard adapter={adapter} />
        </Stack>
      </div>
    </Stack>
  )
}

function FirstReviewBanner({ adapter }: { readonly adapter: AdapterDetail }) {
  const rejected = adapter.approval === 'rejected'
  const needs = [
    adapter.secretRequests.length > 0 ? `your ${adapter.name} login` : null,
    ...adapter.settings.filter((s) => s.required).map((s) => `a ${s.title.toLowerCase()}`),
  ].filter((x): x is string => x !== null)
  return (
    <Banner
      tone={rejected ? 'danger' : 'attention'}
      title={
        rejected
          ? `You turned down ${adapter.name} ${adapter.version}.`
          : `${adapter.name} isn’t approved yet.`
      }
      action={
        <Button size="sm" variant="primary" asChild>
          <a href={href.review(adapter.id)}>Review {adapter.name}</a>
        </Button>
      }
    >
      {rejected
        ? 'Its tools are off. Review it again to turn them on.'
        : `Nothing runs until you review what it can do.${needs.length > 0 ? ` It will ask for ${needs.join(' and ')} next.` : ''}`}
    </Banner>
  )
}

/** "It adds 1 web address and 1 tool", from the permission diff. */
export function updateSummary(review: PendingReview): string {
  const d = review.diff
  const removedTools = new Set(d.tools.removed.map((t) => t.name))
  const parts = [
    d.egress.added.length > 0 ? plural(d.egress.added.length, 'web address', 'web addresses') : null,
    d.navigation.added.length > 0 ? plural(d.navigation.added.length, 'login page') : null,
    d.tools.added.filter((t) => !removedTools.has(t.name)).length > 0
      ? plural(d.tools.added.filter((t) => !removedTools.has(t.name)).length, 'tool')
      : null,
    d.secrets.added.length > 0 ? plural(d.secrets.added.length, 'login') : null,
    d.requests.added.length > 0
      ? plural(d.requests.added.length, 'kind of request', 'kinds of request')
      : null,
  ].filter((x): x is string => x !== null)
  if (parts.length === 0) return 'It asks for nothing new.'
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return `It adds ${list}.`
}

const SOURCE_WORDING: Readonly<Record<PendingReview['source'], string>> = {
  import: 'Imported from a file',
  ide: 'Made in your IDE',
  'authoring-agent': 'Made by the authoring agent (IDE)',
}

function UpdateBanner({
  adapter,
  review,
}: {
  readonly adapter: AdapterDetail
  readonly review: PendingReview
}) {
  return (
    <Banner
      tone="info"
      title={`${adapter.name} ${review.to.version} is waiting for your review.`}
      action={
        <Button size="sm" variant="primary" asChild>
          <a href={href.review(adapter.id)}>Review {adapter.name} update</a>
        </Button>
      }
    >
      {updateSummary(review)} Calls keep using {adapter.version} until you approve.{' '}
      {SOURCE_WORDING[review.source]} at {formatClock(review.submittedAt)}.
    </Banner>
  )
}

function Health({ data, primary }: { readonly data: SiteData; readonly primary: boolean }) {
  const { adapter, health, status } = data
  const now = useNow(30_000)
  const setting = adapter.settings.find((s) => s.required && s.chosen === null) ?? null
  const needsUser = adapter.session.state === 'needs-user' ? adapter.session.needsUser : null
  const open = health !== null && health.breaker === 'open'
  return (
    <Stack gap={1.5}>
      <HealthLine
        tone={status.tone}
        action={
          <>
            <SiteFixButton
              adapter={adapter}
              status={status}
              setting={setting}
              variant={primary ? 'primary' : 'secondary'}
            />
          </>
        }
      >
        <span className="font-medium text-fg">{status.text}</span>
        {needsUser !== null ? (
          <>
            {' · '}
            {needsUserWording(needsUser).detail}
            {adapter.session.since !== null ? ` Since ${formatTime(adapter.session.since, now)}.` : null}
          </>
        ) : status.fix === 'login' ? (
          ' · anything that needs your account waits for it.'
        ) : open ? (
          ' · nothing to do: calls start again by themselves.'
        ) : null}
      </HealthLine>
      {open && health !== null ? (
        <div className="pl-4">
          <Disclosure summary="Details">
            <Text size="sm" tone="muted">
              {health.cause === 'rate-limited'
                ? `Valet slowed its own requests to ${adapter.name}`
                : `${adapter.name} refused or slowed a request`}
              {health.lastOpenedAt !== null ? ` at ${formatClock(health.lastOpenedAt)}` : ''}. No call reaches{' '}
              <Value mono>{health.host}</Value> until then; if it happens again Valet waits{' '}
              {Math.round(health.nextCooldownSeconds / 60)} min. See{' '}
              <TextLink href={href.calls({ site: adapter.id, outcome: 'blocked' })}>blocked calls</TextLink>.
            </Text>
          </Disclosure>
        </div>
      ) : null}
    </Stack>
  )
}

/** A card whose header holds its title and its one action, named by what it changes. */
function SiteCard({
  title,
  action,
  children,
}: {
  readonly title: string
  readonly action?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <CardTitle>{title}</CardTitle>
        <Spacer />
        {action}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  )
}

function SettingCard({ adapter, name }: { readonly adapter: AdapterDetail; readonly name: string }) {
  const now = useNow(60_000)
  const setting = adapter.settings.find((s) => s.name === name)
  if (setting === undefined) return null
  const noun = setting.title.toLowerCase()
  const approved = adapter.approval === 'approved'
  const chosen = setting.chosen
  return (
    <div data-testid={`setting-${setting.name}`}>
      <SiteCard
        title={setting.title}
        action={
          approved ? (
            <Button size="sm" asChild>
              <a href={href.setting(adapter.id, setting.name)}>
                {chosen === null ? `Choose ${noun}…` : `Change ${noun}…`}
              </a>
            </Button>
          ) : null
        }
      >
        {!approved ? (
          <Text tone="subtle">You choose a {noun} after approving.</Text>
        ) : chosen === null ? (
          <Text tone="muted">
            No {noun} chosen
            {setting.required ? `, so ${adapter.name}’s tools wait until you choose one.` : '.'}
          </Text>
        ) : (
          <div data-testid="setting-chosen">
            <DescriptionList
              items={[
                {
                  term: 'Chosen',
                  value: (
                    <Stack gap={0.5}>
                      <SiteText text={chosen.label} from="From the site" />
                      {chosen.detail === null || chosen.detail === '' ? null : (
                        <span className="text-sm text-fg-muted">
                          <SiteText text={chosen.detail} from={null} />
                        </span>
                      )}
                    </Stack>
                  ),
                },
                { term: 'Since', value: formatAgo(chosen.chosenAt, now) },
              ]}
            />
          </div>
        )}
      </SiteCard>
    </div>
  )
}

function LoginCard({ adapter }: { readonly adapter: AdapterDetail }) {
  const approved = adapter.approval === 'approved'
  const now = useNow(30_000)
  const { session } = adapter
  if (adapter.secretRequests.length === 0 && adapter.messages.length === 0) {
    return (
      <SiteCard title="Login">
        <Text tone="muted">{adapter.name} needs no login. Valet never signs in here.</Text>
      </SiteCard>
    )
  }
  return (
    <SiteCard title="Login">
      {!approved ? (
        <Text tone="subtle">
          You choose a login after approving. Valet fills it only on{' '}
          {adapter.secretRequests.flatMap((s) => s.origins.map(hostOf)).join(', ') || adapter.site}.
        </Text>
      ) : (
        <>
          {adapter.secretRequests.map((s) => (
            <SecretBlock key={s.name} adapter={adapter} name={s.name} />
          ))}
          {adapter.messages.map((m) => (
            <Stack key={m.sender} gap={1.5}>
              <Inline gap={2}>
                <Text weight="medium">One-time codes by SMS</Text>
                <Spacer />
                <Button size="sm" asChild>
                  <a href={href.grant(adapter.id, 'messages')}>{m.grant !== null ? 'Change…' : 'Choose…'}</a>
                </Button>
              </Inline>
              <DescriptionList
                items={[
                  { term: 'From', value: <Value mono>{m.sender}</Value> },
                  {
                    term: 'Valet may read them',
                    value: m.grant !== null ? <Badge tone="success">Yes, from Messages</Badge> : 'Not yet',
                  },
                ]}
              />
            </Stack>
          ))}
          <Text size="sm" tone="muted">
            Session: {SESSION_WORDING[session.state]}
            {session.checkedAt !== null ? ` · checked ${formatTime(session.checkedAt, now)}` : ''}
          </Text>
        </>
      )}
    </SiteCard>
  )
}

function SecretBlock({ adapter, name }: { readonly adapter: AdapterDetail; readonly name: string }) {
  const api = useApi()
  const revoke = useAction()
  const [confirming, setConfirming] = useState(false)
  const request = adapter.secretRequests.find((s) => s.name === name)
  if (request === undefined) return null
  const { grant } = request
  const notGiven = grant === null ? [] : request.origins.filter((o) => !grant.origins.includes(o))
  return (
    <Stack gap={2}>
      <Inline gap={2}>
        <Text weight="medium">
          {request.fields
            .map((f) => FIELD_WORDING[f])
            .join(' and ')
            .replace(/^./, (c) => c.toUpperCase())}
        </Text>
        <Spacer />
        <Button size="sm" variant={grant === null ? 'primary' : 'secondary'} asChild>
          <a href={href.grant(adapter.id, request.name)}>{grant === null ? 'Choose login…' : 'Change…'}</a>
        </Button>
      </Inline>
      <Text size="sm" tone="muted">
        <SiteText text={request.description} />
      </Text>
      {grant === null ? (
        <Text tone="muted">
          Valet has no {adapter.name} login yet. Anything that needs your account waits for one. It would be
          filled only on {request.origins.map(hostOf).join(', ')}.
        </Text>
      ) : (
        <>
          <DescriptionList
            items={[
              {
                term: 'Valet may use',
                value: (
                  <span>
                    <ObjectLink href={href.login(adapter.id, request.name)}>{grant.itemTitle}</ObjectLink>{' '}
                    <span className="text-fg-muted">· {PROVIDER_WORDING[grant.provider].title}</span>
                  </span>
                ),
              },
              {
                term: 'Filled only on',
                value: (
                  <Inline gap={1.5}>
                    {grant.origins.map((o) => (
                      <Value key={o} mono>
                        {hostOf(o)}
                      </Value>
                    ))}
                  </Inline>
                ),
              },
              ...(notGiven.length > 0
                ? [{ term: 'Not given', value: <Value mono>{notGiven.map(hostOf).join(', ')}</Value> }]
                : []),
              {
                term: 'Given to',
                value: (
                  <span>
                    this version only ·{' '}
                    <HashChip value={grant.adapterHash} href={href.site(adapter.id, 'versions')} />
                  </span>
                ),
              },
            ]}
          />
          <Inline gap={2}>
            <TextLink href={href.calls({ site: adapter.id, login: `${adapter.id}/${request.name}` })}>
              Calls that used it
            </TextLink>
            <Spacer />
            <Button size="sm" variant="ghost" loading={revoke.busy} onClick={() => setConfirming(true)}>
              Take back login…
            </Button>
          </Inline>
          <ActionError failed={revoke.failed} what="take back the login" />
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            destructive
            title={`Take back the ${adapter.name} login?`}
            description={`Valet stops using “${grant.itemTitle}” for ${adapter.name}. Anything that needs your account waits until you choose a login again. Your 1Password item stays as it is.`}
            confirmLabel="Take back login"
            onConfirm={() => void revoke.run(() => api.grants.revoke(adapter.id, request.name))}
          />
        </>
      )}
    </Stack>
  )
}

function TrolleyCard({ adapter }: { readonly adapter: AdapterDetail }) {
  const api = useApi()
  const open = useAction()
  return (
    <SiteCard
      title="Trolley"
      action={
        <Button
          size="sm"
          loading={open.busy}
          onClick={() => void open.run(() => api.adapters.openCart(adapter.id))}
        >
          Open my trolley
        </Button>
      }
    >
      <Text tone="muted">
        Your agents fill the trolley on {adapter.site}; Valet never checks out or pays. Open it in your
        browser to check it and pay there.
      </Text>
      <ActionError failed={open.failed} what="open your trolley" />
    </SiteCard>
  )
}

function TodayCard({
  adapter,
  runs,
  clients,
}: {
  readonly adapter: AdapterDetail
  readonly runs: readonly RunSummary[] | null
  readonly clients: readonly ClientInfo[]
}) {
  const now = useNow(60_000)
  if (adapter.approval !== 'approved') {
    return (
      <SiteCard title="Today">
        <Text tone="subtle">
          Agents can’t call {adapter.name} until it is approved. They are told it is waiting for review in
          Valet.
        </Text>
      </SiteCard>
    )
  }
  if (runs === null) {
    return (
      <SiteCard title="Today">
        <Text tone="subtle">Loading calls…</Text>
      </SiteCard>
    )
  }
  const today = callsToday(runs, adapter.id, now)
  const failed = today.filter((r) => r.outcome !== 'ok' && r.outcome !== 'running').length
  const blocked = today.reduce((n, r) => n + r.blockedRequests, 0)
  const last = today[0] ?? null
  const by = callers(today)
  return (
    <SiteCard
      title="Today"
      action={
        <Button size="sm" variant="ghost" asChild>
          <a href={href.calls({ site: adapter.id })}>All calls</a>
        </Button>
      }
    >
      {today.length === 0 ? (
        <Text tone="muted">
          No calls yet today.{' '}
          <TextLink href={href.calls({ site: adapter.id })}>{adapter.calls7d} in the last 7 days</TextLink>.
        </Text>
      ) : (
        <>
          <Inline gap={4} align="baseline">
            <TextLink href={href.calls({ site: adapter.id })} className="text-2xl font-semibold tabular">
              {today.length}
            </TextLink>
            <Text tone="muted">{today.length === 1 ? 'call' : 'calls'}</Text>
            {failed > 0 ? (
              <TextLink href={href.calls({ site: adapter.id, outcome: 'failed' })}>{failed} failed</TextLink>
            ) : null}
            {blocked > 0 ? (
              <TextLink href={href.calls({ site: adapter.id, outcome: 'blocked' })}>
                {plural(blocked, 'request')} blocked
              </TextLink>
            ) : null}
            <Text tone="subtle" size="sm">
              {adapter.calls7d} in 7 days
            </Text>
          </Inline>
          {last !== null ? (
            <Text size="sm" tone="muted">
              Last call {formatClock(last.startedAt)} ·{' '}
              <TextLink href={href.calls({ site: adapter.id, tool: last.tool })}>
                {adapter.tools.find((t) => t.name === last.tool)?.title ?? last.tool}
              </TextLink>{' '}
              · call{' '}
              <TextLink href={href.call(last.callId)} className="font-mono">
                {callRef(last.callId)}
              </TextLink>
            </Text>
          ) : null}
          <Inline gap={2} className="border-t border-line-subtle pt-3">
            <Text size="sm" tone="muted">
              Called by
            </Text>
            {by.map((c) => {
              const client = clients.find((k) => k.reportedName === c.client && k.revokedAt === null)
              return (
                <span key={c.client} className="inline-flex items-baseline gap-1">
                  <ObjectLink
                    href={client !== undefined ? href.client(client.id) : href.calls({ site: adapter.id })}
                  >
                    {client !== undefined ? client.name : clientLabel(c.client)}
                  </ObjectLink>
                  <span className="text-sm text-fg-subtle tabular">{c.calls}</span>
                </span>
              )
            })}
          </Inline>
        </>
      )}
    </SiteCard>
  )
}

function ReachCard({ adapter }: { readonly adapter: AdapterDetail }) {
  const tools = adapter.tools.filter((t) => !t.internal)
  const logins = adapter.secretRequests.filter((s) => s.grant !== null)
  return (
    <Stack gap={1.5}>
      <CanReach
        title="Can reach"
        tools={tools.map((t) => (
          <ObjectLink key={t.name} href={href.calls({ site: adapter.id, tool: t.name })}>
            {t.title}
          </ObjectLink>
        ))}
        hosts={adapter.egress.map((h) => (
          <Value key={h} mono>
            {h}
          </Value>
        ))}
        logins={logins.map((s) => (
          <ObjectLink key={s.name} href={href.login(adapter.id, s.name)}>
            {s.grant?.itemTitle ?? s.name}
          </ObjectLink>
        ))}
        className="@container"
      />
      <Text size="sm" tone="subtle">
        Worked out by Valet from {adapter.version}’s declaration.{' '}
        <TextLink href={href.site(adapter.id, 'permissions')}>See all permissions</TextLink>
      </Text>
    </Stack>
  )
}
