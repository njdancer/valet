// Settings › Calendar and Settings › Reminders (#/settings/calendar, docs/calendar.md): turning one
// on walks through what it needs. Start the reader helper, let it use Calendar (or Reminders) when
// macOS asks, then pick what agents may see and whether they may add, change and delete things.

import {
  Button,
  Card,
  CardContent,
  CheckboxOption,
  Field,
  Section,
  Stack,
  Switch,
  Text,
  TextLink,
  toast,
} from '@valet/ui'
import { useEffect, useState } from 'react'
import type {
  EventKitAction,
  EventKitApp,
  EventKitSettingsPatch,
  EventKitStatus,
  RemoteClientItem,
} from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { href } from '../../lib/routes'
import { clientLabel } from '../../lib/wording'
import { Failed } from '../connections/shared'

/** How often the screen looks again while macOS asks, or the person is in System Settings. */
const RECHECK_MS = 2000
/** How often the list is looked at again while the screen is in the foreground. */
const LIST_RECHECK_MS = 5000

interface Words {
  readonly name: string
  readonly things: string
  readonly picked: string
  readonly none: string
  readonly on: string
  readonly onDetail: string
  readonly writes: string
  readonly writesDetail: string
  readonly readTools: readonly string[]
  readonly writeTools: readonly string[]
  readonly agentRead: string
  readonly agentWrite: string
}

const WORDS: Readonly<Record<EventKitApp, Words>> = {
  calendar: {
    name: 'Calendar',
    things: 'calendars',
    picked: 'Calendars agents may see',
    none: 'There are no calendars on this Mac yet.',
    on: 'Let agents see your calendars on this Mac',
    onDetail:
      'Agents see the events in the calendars you pick, from every account the Calendar app has. The Calendar app doesn’t need to be open.',
    writes: 'Let agents add, change and delete events',
    writesDetail:
      'An agent can add an event to a calendar you picked, or change one’s title, time, place or notes. It can also delete events, and change or delete ones other people are on, which may tell them. It can’t invite anyone. Every call is in Activity.',
    readTools: ['calendars', 'events'],
    writeTools: ['create_event', 'update_event', 'delete_event'],
    agentRead: 'See the events in the calendars above. Touch ID once for each of the two tools.',
    agentWrite: 'Add, change and delete events. Touch ID once for each of the three tools.',
  },
  reminders: {
    name: 'Reminders',
    things: 'lists',
    picked: 'Lists agents may see',
    none: 'There are no reminder lists on this Mac yet.',
    on: 'Let agents see your reminders on this Mac',
    onDetail:
      'Agents see the reminders in the lists you pick, from every account the Reminders app has. The Reminders app doesn’t need to be open.',
    writes: 'Let agents add, change, complete and delete reminders',
    writesDetail:
      'An agent can add a reminder to a list you picked, change one, mark it done, or delete it. Every call is in Activity.',
    readTools: ['lists', 'search'],
    writeTools: ['create', 'update', 'delete'],
    agentRead: 'See the reminders in the lists above. Touch ID once for each of the two tools.',
    agentWrite: 'Add, change, complete and delete reminders. Touch ID once for each of the three tools.',
  },
}

export function EventKitSection({ app }: { readonly app: EventKitApp }) {
  const api = useApi()
  const words = WORDS[app]
  const loaded = useLoad((a) => a.eventKit.status(app), [app], ['adapters-changed'])
  const [latest, setLatest] = useState<EventKitStatus | null>(null)
  const action = useAction()
  const status = latest ?? (loaded.status === 'ready' ? loaded.data : null)
  const waiting =
    status !== null &&
    (status.state === 'not-running' || status.state === 'needs-access' || status.state === 'denied')

  // Look again while this screen is showing in the foreground: quickly while macOS asks or the
  // person is in System Settings, so the next step appears, and otherwise every few seconds so a
  // calendar or list added meanwhile shows. Nothing polls while the window is hidden or in the
  // background; it looks again the moment it comes back (Nick, 2026-11-25).
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const look = () =>
      void api.eventKit
        .status(app)
        .then((s) => {
          if (s !== null) setLatest(s)
        })
        .catch(() => undefined)
    const active = () => document.visibilityState === 'visible' && document.hasFocus()
    const stop = () => {
      clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      stop()
      if (!active()) return
      timer = setInterval(() => (active() ? look() : stop()), waiting ? RECHECK_MS : LIST_RECHECK_MS)
    }
    const back = () => {
      if (!active()) return stop()
      look()
      start()
    }
    start()
    window.addEventListener('focus', back)
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', back)
    return () => {
      stop()
      window.removeEventListener('focus', back)
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', back)
    }
  }, [api, app, waiting])

  const update = (patch: EventKitSettingsPatch) =>
    void action.run(async () => {
      const next = await api.eventKit.update(app, patch)
      if (next !== null) setLatest(next)
    })
  const press = (which: EventKitAction) =>
    void action.run(async () => {
      await api.eventKit.action(app, which)
      const next = await api.eventKit.status(app)
      if (next !== null) setLatest(next)
    })

  if (loaded.status === 'error') return <Failed failed what={`load ${words.name}’s settings`} />
  if (status === null) return null
  const on = status.settings.enabled
  return (
    <Section title={words.name}>
      <Failed failed={action.failed} what={`change ${words.name}’s settings`} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Field inline label={words.on} description={words.onDetail}>
            <Switch checked={on} onCheckedChange={(v) => update({ enabled: v })} disabled={action.busy} />
          </Field>
        </CardContent>
      </Card>
      {on && status.state === 'no-reader' ? (
        <Text tone="muted">
          This build of Valet has no reader that can use {words.name}. A development build needs “Valet
          Reader”, made again by swift-bridge/build-helper-apps.sh.
        </Text>
      ) : null}
      {on && status.state === 'not-running' ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Text weight="semibold">Start the reader</Text>
            <Text tone="muted">
              The same small helper that reads Mail uses {words.name} for Valet. It is the only part of Valet
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
            <Text weight="semibold">Let the reader use {words.name}</Text>
            <Text tone="muted">
              macOS asks once whether “Valet Reader” may use {words.name}. Choose Allow (or Allow Full
              Access).
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => press('request-access')} disabled={action.busy}>
                Ask macOS
              </Button>
              <Button variant="secondary" onClick={() => press('privacy-settings')} disabled={action.busy}>
                Open System Settings
              </Button>
            </div>
            <Text size="sm" tone="muted">
              This page notices by itself once access is on.
            </Text>
          </CardContent>
        </Card>
      ) : null}
      {on && status.state === 'denied' ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Text weight="semibold">macOS doesn’t let the reader use {words.name}</Text>
            <Text tone="muted">
              In System Settings › Privacy &amp; Security › {words.name}, turn on “Valet Reader” (with full
              access).
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => press('privacy-settings')} disabled={action.busy}>
                Open System Settings
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {on && status.state === 'ready' ? (
        <Choices app={app} status={status} update={update} busy={action.busy} />
      ) : null}
    </Section>
  )
}

function Choices({
  app,
  status,
  update,
  busy,
}: {
  readonly app: EventKitApp
  readonly status: EventKitStatus
  readonly update: (patch: EventKitSettingsPatch) => void
  readonly busy: boolean
}) {
  const words = WORDS[app]
  const allowed = new Set(status.settings.calendars)
  const toggle = (id: string, on: boolean) => {
    const next = new Set(allowed)
    if (on) next.add(id)
    else next.delete(id)
    update({ calendars: status.calendars.map((c) => c.id).filter((c) => next.has(c)) })
  }
  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Text weight="semibold">{words.picked}</Text>
          {status.calendars.length === 0 ? (
            <Text tone="muted">{words.none}</Text>
          ) : (
            <Stack gap={3}>
              {status.calendars.map((c) => (
                <CheckboxOption
                  key={c.id}
                  label={c.title}
                  description={[c.account, c.writable ? null : 'read only']
                    .filter((x) => x !== null)
                    .join(' · ')}
                  checked={c.allowed}
                  disabled={busy}
                  onCheckedChange={(v) => toggle(c.id, v)}
                />
              ))}
            </Stack>
          )}
          {status.calendars.length > 0 && allowed.size === 0 ? (
            <Text size="sm" tone="muted">
              Agents see no {words.name} tools until you pick at least one of your {words.things}.
            </Text>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Field inline label={words.writes} description={words.writesDetail}>
            <Switch
              checked={status.settings.writes}
              onCheckedChange={(v) => update({ writes: v })}
              disabled={busy}
            />
          </Field>
        </CardContent>
      </Card>
      {allowed.size > 0 ? <CloudAgents app={app} writes={status.settings.writes} /> : null}
    </>
  )
}

/**
 * Each approved cloud agent, with a switch that gives it the reading tools and (while writes are
 * on) one for adding and changing. On asks for Touch ID for each tool; reading off takes every tool.
 */
function CloudAgents({ app, writes }: { readonly app: EventKitApp; readonly writes: boolean }) {
  const api = useApi()
  const words = WORDS[app]
  const loaded = useLoad((a) => a.remote.clients(), [], ['remote-changed'])
  const action = useAction()
  if (loaded.status !== 'ready') return null
  const agents = loaded.data.filter((c) => c.grant !== null)
  const all = [...words.readTools, ...words.writeTools]
  const name = (agent: RemoteClientItem) =>
    agent.clientName === null ? agent.host : `${clientLabel(agent.clientName)} (${agent.host})`
  const holds = (agent: RemoteClientItem, tools: readonly string[]) =>
    tools.every((t) => agent.grant?.tools.includes(`${app}.${t}`) ?? false)
  const set = (agent: RemoteClientItem, tools: readonly string[], on: boolean, done: string) =>
    void action
      .run(async () => {
        const held = new Set(agent.grant?.tools ?? [])
        for (const tool of tools)
          if (held.has(`${app}.${tool}`) !== on) await api.remote.setClientTool(agent.id, app, tool, on)
      })
      .then((ok) => {
        if (ok)
          toast(done, {
            description: 'Its tool list changes now. If it doesn’t see the change, start a new chat.',
          })
      })
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <Text weight="semibold">Cloud agents that may use {words.name}</Text>
        <Failed failed={action.failed} what={`change which agents may use ${words.name}`} />
        {agents.length === 0 ? (
          <Text tone="muted">
            No cloud agent is connected yet. Once you approve one in Connections, you can let it use{' '}
            {words.name} here.
          </Text>
        ) : (
          <Stack gap={4}>
            {agents.map((agent) => (
              <Stack key={agent.id} gap={2}>
                <Field inline label={name(agent)} description={words.agentRead}>
                  <Switch
                    aria-label={`Let ${name(agent)} see ${words.name}`}
                    checked={holds(agent, words.readTools)}
                    onCheckedChange={(v) =>
                      set(
                        agent,
                        v ? words.readTools : all,
                        v,
                        v
                          ? `${name(agent)} may see ${words.name}`
                          : `${name(agent)} can no longer use ${words.name}`,
                      )
                    }
                    disabled={action.busy}
                  />
                </Field>
                {writes && holds(agent, words.readTools) ? (
                  <Field inline label="Add and change" description={words.agentWrite}>
                    <Switch
                      aria-label={`Let ${name(agent)} change ${words.name}`}
                      checked={holds(agent, words.writeTools)}
                      onCheckedChange={(v) =>
                        set(
                          agent,
                          words.writeTools,
                          v,
                          v
                            ? `${name(agent)} may change ${words.name}`
                            : `${name(agent)} can no longer change ${words.name}`,
                        )
                      }
                      disabled={action.busy}
                    />
                  </Field>
                ) : null}
              </Stack>
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
