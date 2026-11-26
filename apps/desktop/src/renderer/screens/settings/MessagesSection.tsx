// Settings › Messages (#/settings/messages, docs/messages.md): one switch lets agents read the Mac's
// Messages history. The reader helper needs Full Disk Access (the same grant Mail uses). Then agents
// see every conversation except the ones hidden here (Nick, 2026-11-26), and never a message that
// looks like a one-time code unless the person turns that off. Nothing sends or changes a message.

import {
  Button,
  Card,
  CardContent,
  CheckboxOption,
  Field,
  Input,
  Section,
  Stack,
  Switch,
  Text,
  TextLink,
  toast,
} from '@valet/ui'
import { useEffect, useState } from 'react'
import type {
  MessagesAction,
  MessagesSettingsPatch,
  MessagesStatus,
  RemoteClientItem,
} from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { href } from '../../lib/routes'
import { clientLabel } from '../../lib/wording'
import { Failed } from '../connections/shared'

/** Every Messages tool: a cloud agent's switch gives and takes them all, one Touch ID each. */
const TOOLS = ['chats', 'search', 'read', 'attachment'] as const
/** How often the screen looks again while the person is in System Settings. */
const RECHECK_MS = 2000
/** Conversations shown before "Show more". */
const SHOWN = 30

export function MessagesSection() {
  const api = useApi()
  const loaded = useLoad((a) => a.messages.status(), [], ['adapters-changed'])
  const [latest, setLatest] = useState<MessagesStatus | null>(null)
  const action = useAction()
  const status = latest ?? (loaded.status === 'ready' ? loaded.data : null)
  const waiting = status !== null && (status.state === 'not-running' || status.state === 'needs-access')

  // While setup waits on System Settings, look again every few seconds so the next step appears.
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void api.messages
        .status()
        .then((s) => {
          if (s !== null) setLatest(s)
        })
        .catch(() => undefined)
    }, RECHECK_MS)
    return () => clearInterval(timer)
  }, [api, waiting])

  const update = (patch: MessagesSettingsPatch) =>
    void action.run(async () => {
      const next = await api.messages.update(patch)
      if (next !== null) setLatest(next)
    })
  const press = (which: MessagesAction) =>
    void action.run(async () => {
      await api.messages.action(which)
      const next = await api.messages.status()
      if (next !== null) setLatest(next)
    })

  if (loaded.status === 'error') return <Failed failed what="load Messages’ settings" />
  if (status === null) return null
  const on = status.settings.enabled
  return (
    <Section title="Messages">
      <Failed failed={action.failed} what="change Messages’ settings" />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Field
            inline
            label="Let agents read your messages on this Mac"
            description="Agents can list your conversations, search them and read them, iMessage and SMS alike, with names from Contacts. They can’t send anything or mark anything read. Every call is in Activity."
          >
            <Switch checked={on} onCheckedChange={(v) => update({ enabled: v })} disabled={action.busy} />
          </Field>
        </CardContent>
      </Card>
      {on && status.state === 'no-reader' ? (
        <Text tone="muted">
          This build of Valet has no reader that can read Messages. A development build needs “Valet Reader”,
          made again by swift-bridge/build-helper-apps.sh.
        </Text>
      ) : null}
      {on && status.state === 'unsupported' ? (
        <Text tone="muted">
          Messages on this Mac keeps its history in a way this version of Valet doesn’t read yet, so agents
          see nothing.
        </Text>
      ) : null}
      {on && status.state === 'not-running' ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Text weight="semibold">Start the reader</Text>
            <Text tone="muted">
              The same small helper that reads Mail reads Messages for Valet. It is the only part of Valet
              that can.
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => press('start-reader')} disabled={action.busy}>
                Start the reader
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {on && status.state === 'needs-access' ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Text weight="semibold">Give the reader Full Disk Access</Text>
            <Text tone="muted">
              macOS keeps Messages private. In System Settings › Privacy &amp; Security › Full Disk Access,
              turn on “Valet Reader” (drag it in if it isn’t listed). If Mail already works, this is done.
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => press('full-disk-access')} disabled={action.busy}>
                Open System Settings
              </Button>
              <Button variant="secondary" onClick={() => press('reveal-reader')} disabled={action.busy}>
                Show the reader in Finder
              </Button>
            </div>
            <Text size="sm" tone="muted">
              This page notices by itself once access is on.
            </Text>
          </CardContent>
        </Card>
      ) : null}
      {on && status.state === 'ready' ? <Choices status={status} update={update} busy={action.busy} /> : null}
    </Section>
  )
}

function Choices({
  status,
  update,
  busy,
}: {
  readonly status: MessagesStatus
  readonly update: (patch: MessagesSettingsPatch) => void
  readonly busy: boolean
}) {
  const [filter, setFilter] = useState('')
  const [all, setAll] = useState(false)
  const hidden = new Set(status.settings.hidden)
  const toggle = (id: string, hide: boolean) => {
    const next = new Set(hidden)
    if (hide) next.add(id)
    else next.delete(id)
    update({ hidden: [...next] })
  }
  const words = filter.trim().toLowerCase()
  const matching = status.chats.filter(
    (c) => words === '' || `${c.name}\n${c.detail ?? ''}\n${c.id}`.toLowerCase().includes(words),
  )
  // Hidden ones first, so they are easy to find again.
  const ordered = [...matching.filter((c) => c.hidden), ...matching.filter((c) => !c.hidden)]
  const shown = all || words !== '' ? ordered : ordered.slice(0, SHOWN)
  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Field
            inline
            label="Hide one-time codes"
            description="Messages that look like a sign-in or verification code come back to agents with their text hidden, and never match a search. Valet still reads codes itself to sign you in."
          >
            <Switch
              checked={status.settings.hideCodes}
              onCheckedChange={(v) => update({ hideCodes: v })}
              disabled={busy}
            />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Text weight="semibold">Conversations agents can’t see</Text>
          <Text tone="muted">
            Agents see every conversation except the ones you tick here, new ones included.
          </Text>
          <Input
            aria-label="Find a conversation"
            placeholder="Find a conversation"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {status.chats.length === 0 ? (
            <Text tone="muted">There are no conversations in Messages on this Mac yet.</Text>
          ) : (
            <Stack gap={3}>
              {shown.map((c) => (
                <CheckboxOption
                  key={c.id}
                  label={c.name}
                  description={c.detail ?? undefined}
                  checked={c.hidden}
                  disabled={busy}
                  onCheckedChange={(v) => toggle(c.id, v)}
                />
              ))}
            </Stack>
          )}
          {!all && words === '' && ordered.length > SHOWN ? (
            <div>
              <Button variant="secondary" onClick={() => setAll(true)}>
                Show all {ordered.length}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <CloudAgents />
    </>
  )
}

/** Each approved cloud agent, with one switch for every Messages tool. On asks Touch ID per tool. */
function CloudAgents() {
  const api = useApi()
  const loaded = useLoad((a) => a.remote.clients(), [], ['remote-changed'])
  const action = useAction()
  if (loaded.status !== 'ready') return null
  const agents = loaded.data.filter((c) => c.grant !== null)
  const name = (agent: RemoteClientItem) =>
    agent.clientName === null ? agent.host : `${clientLabel(agent.clientName)} (${agent.host})`
  const holds = (agent: RemoteClientItem) =>
    TOOLS.every((t) => agent.grant?.tools.includes(`messages.${t}`) ?? false)
  const set = (agent: RemoteClientItem, on: boolean) =>
    void action
      .run(async () => {
        const held = new Set(agent.grant?.tools ?? [])
        for (const tool of TOOLS)
          if (held.has(`messages.${tool}`) !== on)
            await api.remote.setClientTool(agent.id, 'messages', tool, on)
      })
      .then((ok) => {
        if (ok)
          toast(on ? `${name(agent)} may read Messages` : `${name(agent)} can no longer read Messages`, {
            description: 'Its tool list changes now. If it doesn’t see the change, start a new chat.',
          })
      })
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <Text weight="semibold">Cloud agents that may read Messages</Text>
        <Failed failed={action.failed} what="change which agents may read Messages" />
        {agents.length === 0 ? (
          <Text tone="muted">
            No cloud agent is connected yet. Once you approve one in Connections, you can let it read Messages
            here.
          </Text>
        ) : (
          <Stack gap={4}>
            {agents.map((agent) => (
              <Field
                key={agent.id}
                inline
                label={name(agent)}
                description="List, search and read conversations, and see photos. Touch ID once for each of the four tools."
              >
                <Switch
                  aria-label={`Let ${name(agent)} read Messages`}
                  checked={holds(agent)}
                  onCheckedChange={(v) => set(agent, v)}
                  disabled={action.busy}
                />
              </Field>
            ))}
          </Stack>
        )}
        <Text size="sm" tone="muted">
          To give an agent single tools, open it in <TextLink href={href.connections()}>Connections</TextLink>
          .
        </Text>
      </CardContent>
    </Card>
  )
}
