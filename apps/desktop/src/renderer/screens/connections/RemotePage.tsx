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
import type { RemoteSetup, RemoteSetupTool } from '../../../shared/api'
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
                disabled={!data.enabled && data.hosts.length === 0 && data.relayUrl === null}
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

function stateWords(setup: RemoteSetup): string {
  if (!setup.enabled)
    return setup.hosts.length > 0 || setup.relayUrl !== null
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
      {setup.relayUrl !== null ? <ThroughRelay url={setup.relayUrl} /> : null}
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

function ThroughRelay({ url }: { readonly url: string }) {
  const api = useApi()
  return (
    <Card aria-label="Through Valet’s relay" role="region">
      <CardHeader className="flex-col gap-0.5">
        <CardTitle>Through Valet’s relay</CardTitle>
        <Text size="sm" tone="muted">
          No tunnel needed. A cloud agent connects to this URL, and the relay passes its calls to this Mac.
        </Text>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2" data-testid="remote-relay">
        <Value mono>{url}</Value>
        <CopyThrough label="Copy the relay URL" copy={() => api.app.copyText(url)} />
      </CardContent>
    </Card>
  )
}

function PublicNames({ setup }: { readonly setup: RemoteSetup }) {
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
        {setup.hosts.length === 0 ? <Text tone="muted">None yet.</Text> : null}
        {setup.hosts.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {setup.hosts.map((name) => (
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
