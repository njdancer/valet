// Remote access (#/connections/remote): on or off, the connector URL through Valet's relay when
// it's set up (Settings › Devices), the public names the person's tunnel forwards (Cloudflare
// Tunnel, which they run), the cloud agents approved, and which tools cloud agents
// may use at all. Every tool starts off; only approved sites' tools are listed. Consent itself is
// answered in the code sheet (ApproveConnectionSheet), never here.

import {
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Code,
  ConfirmDialog,
  Field,
  Inline,
  Input,
  ObjectLink,
  Page,
  PageBody,
  PageHeader,
  RiskBadge,
  Section,
  SiteAvatar,
  Stack,
  Switch,
  Text,
  TextLink,
  toast,
  Value,
} from '@valet/ui'
import { useState } from 'react'
import type {
  CloudflareConnectAnswer,
  CloudflareTunnelState,
  RemoteSetup,
  RemoteSetupTool,
  ValetRelayView,
} from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { href } from '../../lib/router'
import { AskingToConnect } from './Asking'
import { CloudAgentTable } from './ConnectionsPage'
import { connectorUrl, tunnelTarget } from './consent'
import { CopyThrough, Failed } from './shared'

export function RemotePage() {
  const api = useApi()
  const setup = useLoad((a) => a.remote.setup(), [], ['remote-changed', 'approvals-changed'])
  const toggle = useAction()
  const setEnabled = async (on: boolean) => {
    const ok = await toggle.run(() => api.remote.setEnabled(on))
    if (ok && !on)
      toast('Remote access off. Cloud agents can’t reach this Mac.', {
        action: { label: 'Undo', onClick: () => void api.remote.setEnabled(true) },
      })
  }
  const data = setup.status === 'ready' ? setup.data : null
  return (
    <Page>
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: 'Connections', href: href.connections() }]} />}
        title="Remote access"
        description={
          data === null ? null : (
            <span id="remote-state" data-testid="remote-state">
              {stateWords(data)}
            </span>
          )
        }
        actions={
          data === null ? null : (
            <Inline gap={2} wrap={false}>
              <Text size="sm" weight="medium" aria-hidden="true">
                {data.enabled ? 'On' : 'Off'}
              </Text>
              <Switch
                aria-label="Remote access on"
                aria-describedby="remote-state"
                checked={data.enabled}
                disabled={!data.enabled && !reachable(data)}
                pending={toggle.busy}
                onCheckedChange={(on) => void setEnabled(on)}
              />
            </Inline>
          )
        }
      />
      <PageBody width="form">
        {setup.status === 'error' ? <Failed failed what="load remote access" /> : null}
        <Failed failed={toggle.failed} what="change remote access" />
        {data !== null ? <RemoteBody setup={data} /> : null}
      </PageBody>
    </Page>
  )
}

/** Something can carry agents here: a public name, a relay URL, or Valet's relay setting one up. */
function reachable(setup: RemoteSetup): boolean {
  return setup.hosts.length > 0 || setup.relayUrl !== null || setup.valetRelay !== null
}

function stateWords(setup: RemoteSetup): string {
  if (!setup.enabled)
    return reachable(setup)
      ? 'Off. Cloud agents can’t reach this Mac.'
      : 'Off. Set up Valet’s relay in Settings, or add the public name your tunnel forwards, then turn it on.'
  if (setup.listening && setup.url !== null)
    return 'On. Cloud agents you approve can reach the tools you allow.'
  return 'On, but not listening: something else holds its port.'
}

function RemoteBody({ setup }: { readonly setup: RemoteSetup }) {
  return (
    <>
      {setup.enabled && setup.listening && setup.url !== null ? (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Text>Point your tunnel at</Text>
            <Value mono>{tunnelTarget(setup.url)}</Value>
          </CardContent>
        </Card>
      ) : null}
      {setup.relayUrl !== null || setup.valetRelay !== null ? <ThroughRelay setup={setup} /> : null}
      {setup.cloudflare !== null ? <OwnCloudflare setup={setup} /> : null}
      <PublicNames setup={setup} />
      <Section
        title="Cloud agents"
        description="Each one asks with a code your browser shows, and can call only the tools you tick for it."
      >
        <AskingToConnect />
        <ApprovedAgents />
      </Section>
      <RemoteTools setup={setup} />
    </>
  )
}

/** Where this Mac has got at Valet's relay, while its own address isn't ready; null once it is. */
export function valetRelayWords(relay: ValetRelayView, now = new Date()): string | null {
  if (relay.relay === 'refused') return 'Valet’s relay refused this Mac. Trying again shortly.'
  if (relay.relay === 'replaced')
    return 'Another copy of Valet on this Mac connected to the relay as this Mac, so this one stopped. Quit the other one.'
  if (relay.certificate === 'ready') return relay.relay === 'online' ? null : 'Reconnecting to Valet’s relay…'
  if (relay.relay !== 'online') return 'Connecting to Valet’s relay…'
  if (relay.certificate === 'queued') {
    const at = relay.retryAt === null ? null : new Date(relay.retryAt)
    return at === null || at <= now
      ? 'Still setting up this Mac’s address. Trying again shortly.'
      : `Still setting up this Mac’s address. Trying again ${at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
  }
  return 'Setting up this Mac’s address. This takes a minute or two.'
}

function ThroughRelay({ setup }: { readonly setup: RemoteSetup }) {
  const api = useApi()
  const words = setup.valetRelay === null ? null : valetRelayWords(setup.valetRelay)
  // Valet's relay's own address once it can serve; until then, the older relay's if there is one.
  const url = setup.relayUrl
  return (
    <Card aria-label="Through Valet’s relay" role="region">
      <CardHeader className="flex-col gap-0.5">
        <CardTitle>Through Valet’s relay</CardTitle>
        <Text size="sm" tone="muted">
          No tunnel needed. A cloud agent connects to this URL, and the relay passes its calls to this Mac.
        </Text>
      </CardHeader>
      {url !== null ? (
        <CardContent className="flex flex-wrap items-center gap-2" data-testid="remote-relay">
          <Value mono>{url}</Value>
          <CopyThrough label="Copy the relay URL" copy={() => api.app.copyText(url)} />
        </CardContent>
      ) : null}
      {words !== null ? (
        <CardContent>
          <Text size="sm" tone="muted" data-testid="remote-valet-relay-state">
            {words}
          </Text>
        </CardContent>
      ) : null}
    </Card>
  )
}

const CLOUDFLARE_ANSWER: Record<Exclude<CloudflareConnectAnswer, 'connected'>, string> = {
  'no-binary': 'This build of Valet doesn’t include Cloudflare’s connector.',
  'remote-off':
    'Remote access isn’t listening, so there’s nothing yet for the tunnel to reach. Try again in a moment.',
  refused: 'Not approved, so the name wasn’t added. Nothing was left in your Cloudflare account.',
  token: 'Cloudflare didn’t accept that token. Check you copied all of it.',
  permission:
    'The token can’t make tunnels or DNS records there. It needs Cloudflare Tunnel: Edit and DNS: Edit.',
  zone: 'None of the domains this token can see holds that name. Use a name under one of your domains.',
  'name-taken':
    'That name already has a DNS record. Choose another name, or remove that record in Cloudflare first.',
  network: 'Couldn’t reach Cloudflare. Check this Mac is online and try again.',
  cloudflare: 'Cloudflare refused the change. Try again in a minute.',
}

const CLOUDFLARE_STATE: Record<CloudflareTunnelState, string> = {
  connected: 'Connected to Cloudflare.',
  starting: 'Connecting to Cloudflare…',
  restarting: 'Lost Cloudflare. Trying again shortly.',
  stopped: 'Not running.',
  'no-binary': 'This build of Valet can’t run Cloudflare’s connector.',
  'waiting-for-listener': 'Waiting for remote access to be on.',
}

function OwnCloudflare({ setup }: { readonly setup: RemoteSetup }) {
  const api = useApi()
  const action = useAction()
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [answer, setAnswer] = useState<CloudflareConnectAnswer | null>(null)
  const [asking, setAsking] = useState(false)
  const tunnel = setup.cloudflare?.tunnel ?? null
  const connect = async () => {
    const got: { answer: CloudflareConnectAnswer | null } = { answer: null }
    const ok = await action.run(async () => {
      got.answer = await api.remote.connectCloudflare(token, name)
    })
    if (!ok || got.answer === null) return
    setAnswer(got.answer)
    if (got.answer === 'connected') {
      setToken('')
      setName('')
    }
  }
  return (
    <Card aria-label="Your own Cloudflare account" role="region">
      <CardHeader className="flex-col gap-0.5">
        <CardTitle>Your own Cloudflare account</CardTitle>
        <Text size="sm" tone="muted">
          Instead of Valet’s relay, cloud agents can reach this Mac through a Cloudflare Tunnel in your own
          account, at a name under your own domain. Cloudflare decrypts traffic at its edge in this mode, so
          Cloudflare can read what agents send this Mac. Valet’s relay can’t.
        </Text>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {tunnel !== null ? (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="remote-cloudflare">
              <Value mono>{connectorUrl(tunnel.hostname)}</Value>
              <CopyThrough
                label="Copy the Cloudflare URL"
                copy={() => api.app.copyText(connectorUrl(tunnel.hostname))}
              />
            </div>
            <Text size="sm" data-testid="remote-cloudflare-state">
              {CLOUDFLARE_STATE[tunnel.state]}
            </Text>
            <Inline gap={2}>
              <Button size="sm" variant="danger-soft" disabled={action.busy} onClick={() => setAsking(true)}>
                Disconnect…
              </Button>
            </Inline>
            <ConfirmDialog
              open={asking}
              onOpenChange={setAsking}
              destructive
              title="Disconnect your Cloudflare account?"
              description={`Cloud agents stop reaching this Mac at ${tunnel.hostname}. Valet removes the tunnel and DNS record it made in your account.`}
              confirmLabel="Disconnect"
              onConfirm={() =>
                void action.run(async () => {
                  const done = await api.remote.disconnectCloudflare()
                  if (done === 'left-in-cloudflare')
                    toast(
                      'Disconnected. Valet couldn’t remove the tunnel from your Cloudflare account; remove it there.',
                    )
                })
              }
            />
          </>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void connect()
            }}
          >
            <Field
              label="API token"
              description="Make one in Cloudflare under My Profile, API Tokens, with Cloudflare Tunnel: Edit for the account and DNS: Edit for the domain. Valet keeps it in your Keychain."
            >
              <Input
                type="password"
                value={token}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            <Field
              label="Public name"
              description="A name under one of your domains. Valet adds its DNS record."
            >
              <Input
                value={name}
                autoComplete="off"
                spellCheck={false}
                placeholder="valet.example.com"
                className="font-mono"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Inline gap={2}>
              <Button
                type="submit"
                loading={action.busy}
                disabled={token.trim().length === 0 || name.trim().length === 0}
                disabledReason="Paste a token and type a name first"
              >
                Connect
              </Button>
            </Inline>
          </form>
        )}
        {answer !== null && answer !== 'connected' ? (
          <Text role="alert" size="sm" tone="danger">
            {CLOUDFLARE_ANSWER[answer]}
          </Text>
        ) : null}
        <Failed failed={action.failed} what="change your Cloudflare connection" />
      </CardContent>
    </Card>
  )
}

function PublicNames({ setup }: { readonly setup: RemoteSetup }) {
  // The name Valet's own Cloudflare tunnel serves is shown, and removed, on its own card.
  const managed = setup.cloudflare?.tunnel?.hostname ?? null
  const shown = setup.hosts.filter((h) => h !== managed)
  const api = useApi()
  const action = useAction()
  const [host, setHost] = useState('')
  const addHost = async () => {
    const name = host.trim()
    if (name.length === 0) return
    if (await action.run(() => api.remote.setHosts([...setup.hosts, name]))) setHost('')
  }
  return (
    <Card aria-label="Public names" role="region">
      <CardHeader className="flex-col gap-0.5">
        <CardTitle>Public names</CardTitle>
        <Text size="sm" tone="muted">
          The names your tunnel forwards to this Mac. A cloud agent connects to the URL beside each.
        </Text>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {shown.length === 0 ? <Text tone="muted">None yet.</Text> : null}
        {shown.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {shown.map((name) => (
              <li key={name} data-testid="remote-host" className="flex flex-wrap items-center gap-2">
                <Value mono>{connectorUrl(name)}</Value>
                <CopyThrough
                  label={`Copy the URL for ${name}`}
                  copy={() => api.app.copyText(connectorUrl(name))}
                />
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() => api.remote.setHosts(setup.hosts.filter((h) => h !== name)))
                  }
                >
                  Remove {name}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void addHost()
          }}
        >
          <Field label="Add a public name" className="min-w-[16rem] flex-1">
            <Input
              value={host}
              autoComplete="off"
              spellCheck={false}
              placeholder="valet.example.com"
              className="font-mono"
              onChange={(e) => setHost(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            loading={action.busy}
            disabled={host.trim().length === 0}
            disabledReason="Type a name first"
          >
            Add
          </Button>
        </form>
        <Failed failed={action.failed} what="save the public names. A name looks like valet.example.com" />
      </CardContent>
    </Card>
  )
}

function ApprovedAgents() {
  const api = useApi()
  const agents = useLoad((a) => a.remote.clients(), [], ['remote-changed'])
  const action = useAction()
  const [asking, setAsking] = useState(false)
  if (agents.status === 'error') return <Failed failed what="load the cloud agents" />
  if (agents.status === 'loading') return null
  const approved = agents.data.filter((c) => c.grant !== null)
  if (approved.length === 0) return <Text tone="muted">No cloud agents approved.</Text>
  return (
    <Stack gap={2}>
      <CloudAgentTable agents={approved} />
      <Inline gap={2}>
        <Button size="sm" variant="danger-soft" onClick={() => setAsking(true)}>
          Revoke every cloud agent…
        </Button>
        <Failed failed={action.failed} what="revoke them" />
      </Inline>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive
        title="Revoke every cloud agent?"
        description="Their sessions and tokens end now. Each connector has to be added and approved again."
        confirmLabel={`Revoke all ${agents.data.length}`}
        onConfirm={() => void action.run(() => api.remote.revokeAllClients())}
      />
    </Stack>
  )
}

function RemoteTools({ setup }: { readonly setup: RemoteSetup }) {
  const bySite = new Map<string, RemoteSetupTool[]>()
  for (const tool of setup.tools) bySite.set(tool.adapterId, [...(bySite.get(tool.adapterId) ?? []), tool])
  return (
    <Card aria-label="Tools cloud agents may use" role="region">
      <CardHeader className="flex-col gap-0.5">
        <CardTitle>Tools cloud agents may use</CardTitle>
        <Text size="sm" tone="muted">
          Every tool starts off. A cloud agent also gets only the tools you tick when you approve it.
        </Text>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {setup.tools.length === 0 ? (
          <Text tone="muted">
            No approved sites yet. Approve one from <TextLink href={href.sites()}>Sites</TextLink> first.
          </Text>
        ) : null}
        {[...bySite.entries()].map(([siteId, tools]) => (
          <SiteTools key={siteId} siteId={siteId} tools={tools} />
        ))}
      </CardContent>
    </Card>
  )
}

function SiteTools({
  siteId,
  tools,
}: {
  readonly siteId: string
  readonly tools: readonly RemoteSetupTool[]
}) {
  const api = useApi()
  const action = useAction()
  const name = tools[0]?.adapterName ?? siteId
  const set = async (tool: RemoteSetupTool, on: boolean) => {
    const ok = await action.run(() => api.remote.setTool(tool.adapterId, tool.tool, on))
    if (ok && !on)
      toast(`${tool.toolTitle} is off for cloud agents`, {
        action: { label: 'Undo', onClick: () => void api.remote.setTool(tool.adapterId, tool.tool, true) },
      })
  }
  const on = tools.filter((t) => t.enabled).length
  return (
    <Stack gap={2}>
      <Inline gap={2}>
        <SiteAvatar id={siteId} name={name} size="xs" />
        <ObjectLink href={href.site(siteId, 'tools')}>{name}</ObjectLink>
        <Text size="sm" tone="muted">
          {on} of {tools.length} on
        </Text>
      </Inline>
      <ul className="m-0 flex list-none flex-col p-0 [&>li+li]:border-t [&>li+li]:border-line-subtle">
        {tools.map((tool) => (
          <li key={tool.ref} className="flex flex-wrap items-center gap-2 py-2">
            <Switch
              size="sm"
              aria-label={`${name}: ${tool.toolTitle}`}
              checked={tool.enabled}
              onCheckedChange={(next) => void set(tool, next)}
            />
            <span>{tool.toolTitle}</span>
            <Code>{tool.tool}</Code>
            <RiskBadge purpose={tool.sideEffect} />
          </li>
        ))}
      </ul>
      <Failed failed={action.failed} what="change that tool" />
    </Stack>
  )
}
