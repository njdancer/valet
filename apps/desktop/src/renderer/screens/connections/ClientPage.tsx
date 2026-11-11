// One app on this Mac, or one cloud agent (#/connections/<id>): who it is as far as Valet knows,
// what a call from it can reach (computed from what is approved now), its calls, and its access.
// Reset access and Revoke both ask first and have no Undo: a token is often reset because it
// leaked, so the old one stops at once (IA section 10).

import {
  Badge,
  Breadcrumb,
  Button,
  CanReach,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Code,
  ConfirmDialog,
  DescriptionList,
  Disclosure,
  Inline,
  ObjectLink,
  Page,
  PageBody,
  PageHeader,
  RiskBadge,
  SiteAvatar,
  Stack,
  Text,
  TextLink,
  toast,
  Value,
} from '@valet/ui'
import { useState } from 'react'
import type { ClientInfo, RemoteClientItem } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatAgo, formatDay, plural } from '../../lib/format'
import { href, navigate } from '../../lib/router'
import { clientLabel, TRANSPORT_WORDING } from '../../lib/wording'
import { SetupSnippets } from './SetupSnippets'
import { AppTile, Failed, loginName, reportedAs, type SiteReach, toolSummary, useReach } from './shared'

export function ClientPage({ clientId }: { readonly clientId: string }) {
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const agents = useLoad((a) => a.remote.clients(), [], ['remote-changed'])
  const local = clients.status === 'ready' ? clients.data.find((c) => c.id === clientId) : undefined
  const remote = agents.status === 'ready' ? agents.data.find((c) => c.id === clientId) : undefined
  if (local !== undefined) return <AppPage client={local} />
  if (remote !== undefined) return <AgentPage agent={remote} />
  if (clients.status === 'loading' || agents.status === 'loading') return <Page />
  return (
    <Page>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: 'Connections', href: href.connections() }]} />}
        title="Not found"
      />
      <PageBody width="form">
        {clients.status === 'error' || agents.status === 'error' ? (
          <Failed failed what="load the connections" />
        ) : (
          <Stack gap={3} align="start">
            <Text tone="muted">
              No app or cloud agent has that id. It may have been revoked and removed, or the link is from
              another Mac.
            </Text>
            <Button asChild>
              <a href={href.connections()}>Back to Connections</a>
            </Button>
          </Stack>
        )}
      </PageBody>
    </Page>
  )
}

function reachItems(reach: readonly SiteReach[]) {
  return {
    tools: reach.map((s) => (
      <span key={s.id} className="flex min-w-0 flex-col whitespace-normal">
        <ObjectLink href={href.site(s.id, 'tools')} icon={<SiteAvatar id={s.id} name={s.name} size="xs" />}>
          {s.name}
        </ObjectLink>
        <span className="text-sm text-fg-muted">{toolSummary(s.tools)}</span>
      </span>
    )),
    hosts: [...new Set(reach.flatMap((s) => s.hosts))].map((h) => (
      <Code key={h} title={h}>
        {h}
      </Code>
    )),
    logins: reach.flatMap((s) =>
      s.logins.map((g) => (
        <ObjectLink key={`${s.id}/${g.secret}`} href={href.login(s.id, g.secret)}>
          {loginName(s.name, g)}
        </ObjectLink>
      )),
    ),
  }
}

function AppPage({ client }: { readonly client: ClientInfo }) {
  const api = useApi()
  const now = useNow(60_000)
  const reach = useReach()
  const action = useAction()
  const [asking, setAsking] = useState<'reset' | 'revoke' | null>(null)
  const [announce, setAnnounce] = useState('')
  const revoked = client.revokedAt !== null
  const items = reach.status === 'ready' ? reachItems(reach.data) : null

  const reset = async () => {
    if (await action.run(() => api.clients.resetAccess(client.id))) {
      setAnnounce(`${client.name} has a new token.`)
      toast.success(`${client.name} has a new token`, {
        description: 'Its bridge picks it up by itself.',
      })
    }
  }
  const revoke = async () => {
    if (await action.run(() => api.clients.revoke(client.id))) toast(`${client.name} revoked`)
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[{ label: 'Connections', href: href.connections() }, { label: 'Apps on this Mac' }]}
          />
        }
        leading={<AppTile name={client.name} size="lg" />}
        title={client.name}
        status={revoked ? <Badge>Revoked</Badge> : <Badge tone="success">Has access</Badge>}
        description={
          revoked
            ? `Revoked ${formatDay(client.revokedAt)}. It can’t call Valet; its calls stay in Activity and the audit log.`
            : 'An app on this Mac, with its own token.'
        }
        actions={
          revoked ? null : (
            <>
              <Button onClick={() => setAsking('reset')}>Reset access…</Button>
              <Button variant="danger-soft" onClick={() => setAsking('revoke')}>
                Revoke…
              </Button>
            </>
          )
        }
      />
      <PageBody width="form">
        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
        <Failed failed={action.failed} what={`change ${client.name}’s access`} />
        {revoked ? null : (
          <Stack gap={2}>
            {items !== null ? (
              <CanReach title="Can reach" tools={items.tools} hosts={items.hosts} logins={items.logins} />
            ) : null}
            <Text size="sm" tone="muted">
              Apps on this Mac can call every tool of every approved site. Cloud agents get only the tools you
              tick for them.
            </Text>
          </Stack>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Access</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                {
                  term: 'Calls itself',
                  value:
                    client.reportedName === null ? (
                      <Text tone="muted">It hasn’t called yet</Text>
                    ) : (
                      <Inline gap={2}>
                        <Value>“{reportedAs(client.reportedName)}”</Value>
                        <Badge size="sm">not verified</Badge>
                      </Inline>
                    ),
                },
                {
                  term: 'Connects',
                  value:
                    client.transport === null
                      ? '—'
                      : client.transport === 'stdio'
                        ? 'Through the Valet bridge (stdio)'
                        : `Over ${TRANSPORT_WORDING.http}, this Mac only`,
                },
                {
                  term: 'Token',
                  value: revoked
                    ? `Withdrawn ${formatDay(client.revokedAt)}`
                    : client.accessResetAt === null
                      ? `Its own · issued ${formatDay(client.addedAt)} · never reset`
                      : `Its own · reset ${formatDay(client.accessResetAt)}`,
                },
                { term: 'Added', value: formatDay(client.addedAt) },
                {
                  term: 'Last call',
                  value: client.lastSeen === null ? 'Never' : formatAgo(client.lastSeen, now),
                },
                {
                  term: 'Calls · 7 days',
                  value: (
                    <TextLink href={href.calls({ client: client.id })}>
                      {plural(client.calls7d, 'call')}
                    </TextLink>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>
        {revoked ? null : (
          <Card>
            <CardContent>
              <Disclosure summary="Show setup command">
                <div className="pt-3">
                  <SetupSnippets client={client} />
                </div>
              </Disclosure>
            </CardContent>
          </Card>
        )}
      </PageBody>
      <ConfirmDialog
        open={asking === 'reset'}
        onOpenChange={(open) => setAsking(open ? 'reset' : null)}
        destructive
        title={`Reset ${client.name}’s access?`}
        description={`${client.name} gets a new token now. The old one stops at once and its open sessions end. This can’t be undone.`}
        confirmLabel="Reset access"
        onConfirm={() => void reset()}
      >
        <Text size="sm" tone="muted">
          Nothing has to be set up again: its bridge reads the new token from its own config file.
        </Text>
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === 'revoke'}
        onOpenChange={(open) => setAsking(open ? 'revoke' : null)}
        destructive
        title={`Revoke ${client.name}?`}
        description={`${client.name} can’t call Valet again: its token stops at once and its bridge config file is deleted.`}
        confirmLabel={`Revoke ${client.name}`}
        onConfirm={() => void revoke()}
      >
        <Text size="sm" tone="muted">
          Its {plural(client.calls7d, 'call')} in the last 7 days stay in{' '}
          <TextLink href={href.calls({ client: client.id })}>Activity</TextLink>. To use it again, add it as a
          new app.
        </Text>
      </ConfirmDialog>
    </Page>
  )
}

function AgentPage({ agent }: { readonly agent: RemoteClientItem }) {
  const api = useApi()
  const reach = useReach()
  const setup = useLoad((a) => a.remote.setup(), [], ['remote-changed'])
  const action = useAction()
  const [asking, setAsking] = useState(false)
  const granted = new Set(agent.grant?.tools ?? [])
  const scoped: SiteReach[] =
    reach.status === 'ready'
      ? reach.data
          .map((s) => ({ ...s, tools: s.tools.filter((t) => granted.has(`${s.id}.${t.name}`)) }))
          .filter((s) => s.tools.length > 0)
      : []
  const items = reach.status === 'ready' ? reachItems(scoped) : null
  const matched = new Set(scoped.flatMap((s) => s.tools.map((t) => `${s.id}.${t.name}`)))
  const unmatched = reach.status === 'ready' ? [...granted].filter((ref) => !matched.has(ref)) : []
  const label = agent.clientName === null ? null : clientLabel(agent.clientName)
  const revoke = async () => {
    if (await action.run(() => api.remote.revokeClient(agent.id))) {
      toast(`${agent.host} revoked`)
      navigate(href.connections())
    }
  }
  return (
    <Page>
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[{ label: 'Connections', href: href.connections() }, { label: 'Cloud agents' }]}
          />
        }
        leading={<AppTile name={agent.host} size="lg" />}
        title={<span className="font-mono">{agent.host}</span>}
        status={
          agent.grant === null ? (
            <Badge tone="warning">Not approved</Badge>
          ) : (
            <Badge tone="success">Approved</Badge>
          )
        }
        description={
          <>
            {label !== null ? `Calls itself “${label}” (not verified) · ` : null}
            {agent.grant === null
              ? 'Nobody approved it; its registration expires within the hour.'
              : `approved ${formatDay(agent.grant.grantedAt)}`}
          </>
        }
        actions={
          <Button variant="danger-soft" onClick={() => setAsking(true)}>
            Revoke…
          </Button>
        }
      />
      <PageBody width="form">
        <Failed failed={action.failed} what={`revoke ${agent.host}`} />
        {items !== null ? (
          <CanReach title="Can reach" tools={items.tools} hosts={items.hosts} logins={items.logins} />
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Access</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                { term: 'Asks as', value: <Value mono>{agent.host}</Value> },
                {
                  term: 'Calls itself',
                  value:
                    label === null ? (
                      <Text tone="muted">No name given</Text>
                    ) : (
                      <Inline gap={2}>
                        <Value>“{label}”</Value>
                        <Badge size="sm">not verified</Badge>
                      </Inline>
                    ),
                },
                {
                  term: 'Comes in through',
                  value:
                    setup.status === 'ready' && setup.data.hosts.length > 0 ? (
                      <Value mono>{setup.data.hosts.join(', ')}</Value>
                    ) : (
                      '—'
                    ),
                },
                { term: 'Registered', value: formatDay(agent.registeredAt) },
                { term: 'Token', value: 'Its own · ends when you revoke it or turn remote access off' },
                {
                  term: 'Calls',
                  value: <TextLink href={href.calls({ client: agent.id })}>Its calls in Activity</TextLink>,
                },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Tools it may use</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {granted.size === 0 ? (
              <Text tone="muted">None. It can connect, but it can’t call any tool.</Text>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {scoped.flatMap((s) =>
                  s.tools.map((t) => (
                    <li key={`${s.id}.${t.name}`} className="flex flex-wrap items-center gap-2">
                      <SiteAvatar id={s.id} name={s.name} size="xs" />
                      <span>
                        {s.name}: {t.title}
                      </span>
                      <Code>{t.name}</Code>
                      <RiskBadge purpose={t.sideEffect as 'read' | 'write' | 'irreversible'} />
                    </li>
                  )),
                )}
                {/* A tool granted on a site that is no longer approved: shown, so nothing is hidden. */}
                {unmatched.map((ref) => (
                  <li key={ref} className="flex flex-wrap items-center gap-2">
                    <Code>{ref}</Code>
                    <Text size="sm" tone="muted">
                      its site isn’t approved now, so it can’t be called
                    </Text>
                  </li>
                ))}
              </ul>
            )}
            <Text size="sm" tone="muted">
              To give it other tools, revoke it and approve it again. A tool turned off in{' '}
              <TextLink href={href.remote()}>Remote access</TextLink> is off for every cloud agent.
            </Text>
          </CardContent>
        </Card>
      </PageBody>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive
        title={`Revoke ${agent.host}?`}
        description="Its registration, grant and tokens are deleted and its sessions close. Adding it again needs your approval on this Mac."
        confirmLabel={`Revoke ${agent.host}`}
        onConfirm={() => void revoke()}
      />
    </Page>
  )
}
