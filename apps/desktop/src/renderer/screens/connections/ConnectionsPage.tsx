// Connections (IA section 3): who can call your tools. This Mac's endpoint, the apps on this Mac
// (each with its own token, D42), cloud agents, and a summary of remote access. No token ever
// reaches this page: resetting one happens in the main process, and the setup snippets point at the
// bridge, which reads its app's token itself. An app is named by the person's name for it; what it
// says it is (from MCP initialize) is a claim, shown as one.

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  DescriptionList,
  EmptyState,
  Inline,
  Page,
  PageBody,
  PageHeader,
  RowLink,
  Section,
  Switch,
  Table,
  TBody,
  TD,
  Text,
  TextLink,
  TH,
  THead,
  TR,
  toast,
  Value,
} from '@valet/ui'
import { Cable, Plus } from 'lucide-react'
import { useState } from 'react'
import type { ClientInfo, EndpointStatus, RemoteClientItem, RemoteSetup } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatAgo, formatDay, plural } from '../../lib/format'
import { href } from '../../lib/router'
import { clientLabel } from '../../lib/wording'
import { AddAppSheet } from './AddAppSheet'
import { AskingToConnect } from './Asking'
import { connectorUrl } from './consent'
import { AppTile, activeClients, CopyThrough, Failed, reportedAs, type SiteReach, useReach } from './shared'

export function ConnectionsPage() {
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const [adding, setAdding] = useState(false)
  return (
    <Page>
      <PageHeader title="Connections" description="Apps and agents that can call your tools through Valet." />
      <PageBody>
        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @min-[720px]:grid-cols-2">
            <EndpointCard />
            <RemoteCard />
          </div>
        </div>
        <AppsSection
          clients={clients.status === 'ready' ? clients.data : null}
          failed={clients.status === 'error'}
          onAdd={() => setAdding(true)}
        />
        <CloudAgentsSection />
      </PageBody>
      <AddAppSheet open={adding} onOpenChange={setAdding} />
    </Page>
  )
}

function EndpointCard() {
  const api = useApi()
  const endpoint = useLoad((a) => a.endpoint.status(), [], ['endpoint-changed'])
  const action = useAction()
  const set = async (on: boolean) => {
    const ok = await action.run(() => api.endpoint.setListening(on))
    // Turning it off acts at once, so it can be undone (IA section 4, toasts).
    if (ok && !on)
      toast('Endpoint off. Apps on this Mac can’t reach Valet.', {
        action: { label: 'Undo', onClick: () => void api.endpoint.setListening(true) },
      })
  }
  return (
    <Card id="endpoint">
      <CardHeader className="items-center">
        <CardTitle className="flex-1">This Mac’s endpoint</CardTitle>
        {endpoint.status === 'ready' ? (
          <EndpointSwitch status={endpoint.data} busy={action.busy} onChange={set} />
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {endpoint.status === 'error' ? <Failed failed what="load the endpoint" /> : null}
        {endpoint.status === 'ready' ? (
          <>
            <Text tone="muted" size="sm">
              {endpoint.data.listening
                ? `This Mac only · ${plural(endpoint.data.connectedClients, 'app')} connected now`
                : 'Off · apps on this Mac can’t reach Valet'}
            </Text>
            <DescriptionList
              items={[
                {
                  term: 'Address',
                  value:
                    endpoint.data.url === null ? (
                      <Text tone="muted">Not listening</Text>
                    ) : (
                      <Inline gap={1} wrap={false}>
                        <Value mono truncate="middle">
                          {endpoint.data.url}
                        </Value>
                        <CopyThrough label="Copy address" copy={() => api.endpoint.copyUrl()} />
                      </Inline>
                    ),
                },
                {
                  term: 'How apps connect',
                  value: 'Each app has its own token, kept in its own config file',
                },
              ]}
            />
          </>
        ) : null}
        <Failed failed={action.failed} what="change the endpoint" />
      </CardContent>
    </Card>
  )
}

function EndpointSwitch({
  status,
  busy,
  onChange,
}: {
  readonly status: EndpointStatus
  readonly busy: boolean
  readonly onChange: (on: boolean) => void
}) {
  return (
    <Inline gap={2} wrap={false}>
      <Text size="sm" weight="medium" aria-hidden="true">
        {status.listening ? 'On' : 'Off'}
      </Text>
      <Switch
        aria-label="Endpoint on"
        checked={status.listening}
        pending={busy}
        onCheckedChange={(on) => onChange(on)}
      />
    </Inline>
  )
}

function remoteWords(setup: RemoteSetup): { tone: 'success' | 'warning' | 'neutral'; text: string } {
  if (!setup.enabled) return { tone: 'neutral', text: 'Off' }
  if (!setup.listening) return { tone: 'warning', text: 'On, but not listening' }
  return { tone: 'success', text: 'On' }
}

function RemoteCard() {
  const setup = useLoad((a) => a.remote.setup(), [], ['remote-changed', 'approvals-changed'])
  const agents = useLoad((a) => a.remote.clients(), [], ['remote-changed'])
  const approved = agents.status === 'ready' ? agents.data.filter((c) => c.grant !== null).length : 0
  return (
    <Card>
      <CardHeader className="items-center">
        <CardTitle className="flex-1">Remote access</CardTitle>
        {setup.status === 'ready' ? (
          <Badge tone={remoteWords(setup.data).tone}>{remoteWords(setup.data).text}</Badge>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {setup.status === 'error' ? <Failed failed what="load remote access" /> : null}
        {setup.status === 'ready' ? (
          <>
            <Text tone="muted" size="sm">
              {setup.data.enabled
                ? approved === 0
                  ? 'No cloud agents approved yet'
                  : `${plural(approved, 'cloud agent')} approved`
                : 'Cloud agents can’t reach this Mac.'}
            </Text>
            {setup.data.hosts.length > 0 ? (
              <DescriptionList
                items={setup.data.hosts.map((h) => ({
                  term: 'Public name',
                  value: <Value mono>{connectorUrl(h)}</Value>,
                }))}
              />
            ) : (
              <Text size="sm" tone="muted">
                Cloud agents, such as Claude on the web or your phone, reach Valet through a tunnel you run.
                Add its public name to turn this on.
              </Text>
            )}
          </>
        ) : null}
      </CardContent>
      <CardFooter className="justify-start">
        <Button size="sm" asChild>
          <a href={href.remote()}>
            {setup.status === 'ready' && setup.data.enabled
              ? 'Remote access settings'
              : 'Set up remote access'}
          </a>
        </Button>
      </CardFooter>
    </Card>
  )
}

/** "All 12 tools on 3 sites": what an app on this Mac can call. */
export function reachLine(reach: readonly SiteReach[]): string {
  const tools = reach.reduce((n, s) => n + s.tools.length, 0)
  if (tools === 0) return 'No approved tools yet'
  return `All ${plural(tools, 'tool')} on ${plural(reach.length, 'site')}`
}

/** What the app says it is, worded as the claim it is. */
export function claimLine(client: ClientInfo): string {
  return client.reportedName === null ? 'no calls yet' : `calls itself “${reportedAs(client.reportedName)}”`
}

function sinceLine(client: ClientInfo): string {
  if (client.revokedAt !== null) return `revoked ${formatDay(client.revokedAt)}`
  if (client.accessResetAt !== null) return `access reset ${formatDay(client.accessResetAt)}`
  return `added ${formatDay(client.addedAt)}`
}

function AppsSection({
  clients,
  failed,
  onAdd,
}: {
  readonly clients: readonly ClientInfo[] | null
  readonly failed: boolean
  readonly onAdd: () => void
}) {
  const now = useNow(60_000)
  const reach = useReach()
  const [showRevoked, setShowRevoked] = useState(false)
  const active = clients === null ? [] : activeClients(clients)
  const revoked = clients === null ? [] : clients.filter((c) => c.revokedAt !== null)
  const rows = showRevoked ? [...active, ...revoked] : active
  return (
    <Section
      id="apps"
      title="Apps on this Mac"
      description="Each app has its own token, so its calls are its own, and you can reset or revoke one without touching the others."
      actions={
        <Button variant="primary" leading={<Plus />} onClick={onAdd}>
          Add an app…
        </Button>
      }
    >
      {failed ? <Failed failed what="load the apps" /> : null}
      {clients !== null && clients.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Cable />}
            title="No apps yet"
            action={
              <Button onClick={onAdd} leading={<Plus />}>
                Add an app…
              </Button>
            }
          >
            Add Claude Desktop, Claude Code or another app, and it can call the sites you approved.
          </EmptyState>
        </Card>
      ) : null}
      {rows.length > 0 ? (
        <Table aria-label="Apps on this Mac">
          <THead>
            <TR>
              <TH>App</TH>
              <TH>Last call</TH>
              <TH align="right">Calls · 7 days</TH>
              <TH>Can reach</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((c) => (
              <TR key={c.id} interactive className={c.revokedAt !== null ? 'text-fg-muted' : undefined}>
                <TD className="py-2">
                  <Inline gap={2} wrap={false}>
                    <AppTile name={c.name} />
                    <span className="flex min-w-0 flex-col">
                      <RowLink href={href.client(c.id)}>{c.name}</RowLink>
                      <span className="truncate text-sm text-fg-muted">
                        {claimLine(c)} · {sinceLine(c)}
                      </span>
                    </span>
                    {c.revokedAt !== null ? <Badge size="sm">Revoked</Badge> : null}
                  </Inline>
                </TD>
                <TD className="whitespace-nowrap text-sm">
                  {c.revokedAt !== null || c.lastSeen === null ? '—' : formatAgo(c.lastSeen, now)}
                </TD>
                <TD align="right">
                  <TextLink href={href.calls({ client: c.id })} className="relative z-[1]">
                    {plural(c.calls7d, 'call')}
                  </TextLink>
                </TD>
                <TD className="text-sm text-fg-muted">
                  {c.revokedAt !== null ? 'Nothing' : reach.status === 'ready' ? reachLine(reach.data) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}
      {revoked.length > 0 ? (
        <Inline gap={2}>
          <Text size="sm" tone="muted">
            {revoked.length === 1
              ? `1 revoked app (${revoked[0]?.name}) is kept in history only.`
              : `${revoked.length} revoked apps are kept in history only.`}
          </Text>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showRevoked}
            onClick={() => setShowRevoked(!showRevoked)}
          >
            {showRevoked ? 'Hide revoked' : 'Show revoked'}
          </Button>
        </Inline>
      ) : null}
    </Section>
  )
}

function CloudAgentsSection() {
  const agents = useLoad((a) => a.remote.clients(), [], ['remote-changed'])
  const approved = agents.status === 'ready' ? agents.data.filter((c) => c.grant !== null) : []
  return (
    <Section
      id="cloud-agents"
      title="Cloud agents"
      description="Agents that reach this Mac over the internet, through remote access. Each one can call only the tools you ticked when you approved it."
    >
      <AskingToConnect />
      {agents.status === 'error' ? <Failed failed what="load the cloud agents" /> : null}
      {agents.status === 'ready' && approved.length === 0 ? (
        <Text tone="muted">None approved yet.</Text>
      ) : null}
      {approved.length > 0 ? <CloudAgentTable agents={approved} /> : null}
    </Section>
  )
}

export function CloudAgentTable({ agents }: { readonly agents: readonly RemoteClientItem[] }) {
  return (
    <Table aria-label="Cloud agents">
      <THead>
        <TR>
          <TH>Cloud agent</TH>
          <TH>Approved</TH>
          <TH align="right">Tools</TH>
          <TH align="right">Calls</TH>
        </TR>
      </THead>
      <TBody>
        {agents.map((c) => (
          <TR key={c.id} interactive>
            <TD className="py-2">
              <Inline gap={2} wrap={false}>
                <AppTile name={c.host} />
                <span className="flex min-w-0 flex-col">
                  <RowLink href={href.client(c.id)} className="font-mono">
                    {c.host}
                  </RowLink>
                  {c.clientName !== null ? (
                    <span className="truncate text-sm text-fg-muted">
                      calls itself “{clientLabel(c.clientName)}” · not verified
                    </span>
                  ) : null}
                </span>
              </Inline>
            </TD>
            <TD className="whitespace-nowrap text-sm">{formatDay(c.grant?.grantedAt ?? null)}</TD>
            <TD align="right">{c.grant?.tools.length ?? 0}</TD>
            <TD align="right">
              <TextLink href={href.calls({ client: c.id })} className="relative z-[1]">
                Calls
              </TextLink>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}
