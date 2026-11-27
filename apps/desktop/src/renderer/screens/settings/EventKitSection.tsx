// Settings › Calendar and Settings › Reminders (#/settings/calendar, docs/calendar.md): turning one
// on walks through what it needs. Start the reader helper, let it use Calendar (or Reminders) when
// macOS asks. What each agent may see and change is chosen on its own page (docs/access.md).

import { Button, Card, CardContent, Field, Section, Switch, Text, TextLink } from '@valet/ui'
import { useEffect, useState } from 'react'
import type { EventKitAction, EventKitApp, EventKitSettingsPatch, EventKitStatus } from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { href } from '../../lib/routes'
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
    picked: 'Calendars on this Mac',
    none: 'There are no calendars on this Mac yet.',
    on: 'Let agents see your calendars on this Mac',
    onDetail:
      'Each agent sees only the calendars you give it, from every account the Calendar app has. The Calendar app doesn’t need to be open.',
    writes: 'Let agents add, change and delete events',
    writesDetail:
      'With Edit, an agent can add an event to that calendar, or change one’s title, time, place or notes. It can also delete events, and change or delete ones other people are on, which may tell them. It can’t invite anyone. Every call is in Activity.',
    readTools: ['calendars', 'events'],
    writeTools: ['create_event', 'update_event', 'delete_event'],
    agentRead: 'See the events in the calendars above. Touch ID once for each of the two tools.',
    agentWrite: 'Add, change and delete events. Touch ID once for each of the three tools.',
  },
  reminders: {
    name: 'Reminders',
    things: 'lists',
    picked: 'Reminder lists on this Mac',
    none: 'There are no reminder lists on this Mac yet.',
    on: 'Let agents see your reminders on this Mac',
    onDetail:
      'Each agent sees only the lists you give it, from every account the Reminders app has. The Reminders app doesn’t need to be open.',
    writes: 'Let agents add, change, complete and delete reminders',
    writesDetail:
      'With Edit, an agent can add a reminder to that list, change one, mark it done, or delete it. Every call is in Activity.',
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
      {on && status.state === 'ready' ? <Choices app={app} status={status} /> : null}
    </Section>
  )
}

/**
 * The calendars (or lists) on this Mac. Which of them each agent may use, at Read or Edit, is
 * chosen on that agent's page in Connections (docs/access.md): nothing here gives anything.
 */
function Choices({ app, status }: { readonly app: EventKitApp; readonly status: EventKitStatus }) {
  const words = WORDS[app]
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <Text weight="semibold">{words.picked}</Text>
        {status.calendars.length === 0 ? (
          <Text tone="muted">{words.none}</Text>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid={`${app}-items`}>
            {status.calendars.map((c) => (
              <li key={c.id} className="flex flex-col">
                <span>{c.title}</span>
                <Text size="sm" tone="muted">
                  {[c.account, c.writable ? null : 'read only'].filter((x) => x !== null).join(' · ')}
                </Text>
              </li>
            ))}
          </ul>
        )}
        <Text size="sm" tone="muted">
          No agent can use one until you give it to that agent. Open an app or cloud agent in{' '}
          <TextLink href={href.connections()}>Connections</TextLink> and choose Read or Edit for each of your{' '}
          {words.things}. {words.writesDetail}
        </Text>
      </CardContent>
    </Card>
  )
}
