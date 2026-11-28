// What one agent may use (docs/access.md): each Mail account, calendar and reminder list at Off,
// Read or Edit, and for a cloud agent each tool of an approved site and Valet's own (the browser's),
// on or off, and what it may do in Valet itself (See Valet, Ask for changes). Changes are a draft
// until Save, and one Save is one Touch ID for everything it adds. Taking things away needs no
// Touch ID.

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Code,
  Inline,
  RiskBadge,
  Segmented,
  SiteAvatar,
  Stack,
  Switch,
  Text,
  TextLink,
  toast,
} from '@valet/ui'
import { useState } from 'react'
import type {
  AccessApp,
  AccessChoice,
  AgentAccessApp,
  AgentAccessChanges,
  AgentAccessItem,
  AgentAccessTool,
  AgentValetAccess,
} from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { href } from '../../lib/router'
import { Failed } from './shared'

const APP_NAMES: Readonly<Record<AccessApp, string>> = {
  mail: 'Mail',
  calendar: 'Calendar',
  reminders: 'Reminders',
}

/** What Edit lets it do in each app, beside reading. */
const EDIT_MEANS: Readonly<Record<AccessApp, string>> = {
  mail: 'Edit: drafts, moves and marks messages. It never sends.',
  calendar:
    'Edit: adds, changes and deletes events, invitations included. With Full access, it may delete the calendar too.',
  reminders: 'Edit: adds, changes and completes reminders. With Full access, it may delete the list too.',
}

const RANK: Readonly<Record<AccessChoice, number>> = { off: 0, read: 1, edit: 2 }

type ValetKey = 'seeValet' | 'allActivity' | 'askForChanges'
type Draft = Partial<Record<AccessApp, Record<string, AccessChoice>>> & {
  tools?: Record<string, boolean>
  full?: Partial<Record<'calendar' | 'reminders', boolean>>
  /** `seeByAsk`: See Valet went on only because Ask for changes did, so it goes off with it. */
  valet?: Partial<Record<ValetKey | 'seeByAsk', boolean>>
}

/**
 * Valet itself as the draft has it: Ask for changes brings See Valet, and without See Valet there
 * is neither Ask for changes nor All agents' activity.
 */
export function valetDraft(saved: AgentValetAccess, draft: Draft['valet'] = {}): AgentValetAccess {
  const ask = draft.askForChanges ?? saved.askForChanges
  const see = ask || (draft.seeValet ?? saved.seeValet)
  return {
    seeValet: see,
    allActivity: saved.allActivity === null ? null : see && (draft.allActivity ?? saved.allActivity),
    askForChanges: see && ask,
    seeValetSignedAgain: saved.seeValetSignedAgain,
  }
}

/** A switch's change in the draft, with what it brings or takes along. */
function valetChoose(
  saved: AgentValetAccess,
  draft: Draft['valet'],
  key: ValetKey,
  on: boolean,
): Draft['valet'] {
  const now = valetDraft(saved, draft)
  if (key === 'askForChanges' && on)
    return { ...draft, askForChanges: true, seeValet: true, seeByAsk: !now.seeValet }
  if (key === 'askForChanges' && !on) {
    const { seeByAsk, ...rest } = draft ?? {}
    return seeByAsk === true
      ? { ...rest, askForChanges: false, seeValet: false }
      : { ...rest, askForChanges: false }
  }
  if (key === 'seeValet' && !on)
    return {
      ...draft,
      seeValet: false,
      askForChanges: false,
      ...(now.allActivity === null ? {} : { allActivity: false }),
    }
  return { ...draft, [key]: on }
}

/** The draft's changes against what is saved, and whether any of them adds something. */
export function accessChanges(
  apps: readonly AgentAccessApp[],
  draft: Draft,
  tools: readonly AgentAccessTool[] = [],
  gone: readonly string[] = [],
  valet: AgentValetAccess | null = null,
): { readonly changes: AgentAccessChanges; readonly count: number; readonly widens: boolean } {
  const changes: Partial<Record<AccessApp, Record<string, AccessChoice>>> & {
    tools?: Record<string, boolean>
    full?: Partial<Record<'calendar' | 'reminders', boolean>>
    valet?: Partial<Record<ValetKey, boolean>>
  } = {}
  let count = 0
  let widens = false
  if (valet !== null) {
    const next = valetDraft(valet, draft.valet)
    for (const key of ['seeValet', 'allActivity', 'askForChanges'] as const) {
      if (next[key] === null || next[key] === valet[key]) continue
      changes.valet = { ...(changes.valet ?? {}), [key]: next[key] }
      count += 1
      // A cloud agent's are signed for; an app on this Mac's are its own choices.
      if (next[key] === true && valet.allActivity === null) widens = true
    }
    // Ask for changes off alone, with See Valet signed only beside it: See Valet is signed again.
    if (valet.seeValetSignedAgain && valet.askForChanges && !next.askForChanges && next.seeValet)
      widens = true
  }
  for (const [ref, on] of Object.entries(draft.tools ?? {})) {
    const tool = tools.find((t) => t.ref === ref)
    const saved = tool?.on ?? gone.includes(ref)
    // Held but off for every cloud agent now: Off takes it out of the grant.
    const latent = tool !== undefined && tool.held && !tool.on
    if (on === saved && !(latent && !on)) continue
    changes.tools = { ...(changes.tools ?? {}), [ref]: on }
    count += 1
    if (on) widens = true
  }
  for (const app of apps) {
    const fullTo = app.app === 'mail' ? undefined : draft.full?.[app.app]
    if (
      app.app !== 'mail' &&
      app.full !== null &&
      fullTo !== undefined &&
      fullTo !== app.full &&
      (app.ready || !fullTo)
    ) {
      changes.full = { ...(changes.full ?? {}), [app.app]: fullTo }
      count += 1
      if (fullTo) widens = true
    }
    for (const item of app.items) {
      const next = draft[app.app]?.[item.id]
      if (next === undefined || next === item.level) continue
      changes[app.app] = { ...(changes[app.app] ?? {}), [item.id]: next }
      count += 1
      if (RANK[next] > RANK[item.level]) widens = true
    }
  }
  return { changes, count, widens }
}

export function AppsAccess({ clientId, name }: { readonly clientId: string; readonly name: string }) {
  const api = useApi()
  const action = useAction()
  const view = useLoad(
    (a) => a.agentAccess.view(clientId),
    [clientId],
    ['clients-changed', 'remote-changed', 'adapters-changed'],
  )
  const [draft, setDraft] = useState<Draft>({})
  if (view.status !== 'ready')
    return view.status === 'error' ? <Failed failed what="load its access" /> : null
  const { apps, tools, gone, valet } = view.data
  const pending = accessChanges(apps, draft, tools, gone, valet)
  const valetNow = valetDraft(valet, draft.valet)
  const chooseValet = (key: ValetKey, on: boolean) =>
    setDraft((d) => ({ ...d, valet: valetChoose(valet, d.valet, key, on) }))
  const local = valet.allActivity !== null
  const toolOn = (t: { readonly ref: string; readonly on: boolean }) => draft.tools?.[t.ref] ?? t.on
  const chooseTool = (ref: string, on: boolean) =>
    setDraft((d) => ({ ...d, tools: { ...(d.tools ?? {}), [ref]: on } }))
  const sites = new Map<string, AgentAccessTool[]>()
  for (const t of tools) sites.set(t.adapterId, [...(sites.get(t.adapterId) ?? []), t])
  const level = (app: AccessApp, item: AgentAccessItem) => draft[app]?.[item.id] ?? item.level
  const choose = (app: AccessApp, id: string, next: AccessChoice) =>
    setDraft((d) => ({ ...d, [app]: { ...(d[app] ?? {}), [id]: next } }))
  const save = async () => {
    let saved = false
    const ran = await action.run(async () => {
      saved = await api.agentAccess.save(clientId, pending.changes)
    })
    if (!ran) return
    if (!saved) {
      toast('Nothing changed', { description: 'Touch ID was cancelled. Your changes are still here.' })
      return
    }
    setDraft({})
    view.reload()
    toast(`${name}’s access is saved`, {
      description: 'Its tool list changes now. If it doesn’t see the change, start a new chat.',
    })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>What it may use</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Failed failed={action.failed} what="save its access" />
        {apps.map((app) => (
          <section key={app.app} aria-label={APP_NAMES[app.app]} className="flex flex-col gap-2">
            <Text weight="medium">{APP_NAMES[app.app]}</Text>
            {!app.ready ? (
              <Text size="sm" tone="muted">
                Set up {APP_NAMES[app.app]} in <TextLink href={href.settings(app.app)}>Settings</TextLink> to
                choose what it may use.
              </Text>
            ) : app.items.length === 0 ? (
              <Text size="sm" tone="muted">
                {APP_NAMES[app.app]} has nothing on this Mac yet.
              </Text>
            ) : (
              <>
                <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid={`access-${app.app}`}>
                  {app.items.map((item) => {
                    const value = level(app.app, item)
                    const changed = value !== item.level
                    return (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex min-w-0 flex-col">
                          <span>
                            {item.label}
                            {changed ? <span className="text-fg-muted text-sm"> · not saved</span> : null}
                          </span>
                          {item.detail === null ? null : (
                            <Text size="sm" tone="muted">
                              {item.detail}
                            </Text>
                          )}
                        </span>
                        <Segmented<AccessChoice>
                          size="sm"
                          label={`${APP_NAMES[app.app]}: ${item.label}`}
                          value={value}
                          onValueChange={(next) => choose(app.app, item.id, next)}
                          options={[
                            { value: 'off', label: 'Off' },
                            { value: 'read', label: 'Read' },
                            ...(item.editable ? [{ value: 'edit' as const, label: 'Edit' }] : []),
                          ]}
                        />
                      </li>
                    )
                  })}
                </ul>
                <Text size="sm" tone="muted">
                  {EDIT_MEANS[app.app]}
                </Text>
              </>
            )}
            {/* Off stays in reach while the app isn't set up; on needs it set up. */}
            {app.app === 'mail' || app.full === null || (!app.ready && !app.full) ? null : (
              <FullAccess
                app={app.app}
                on={draft.full?.[app.app] ?? app.full}
                changed={(draft.full?.[app.app] ?? app.full) !== app.full}
                onChange={(on) => setDraft((d) => ({ ...d, full: { ...(d.full ?? {}), [app.app]: on } }))}
              />
            )}
          </section>
        ))}
        {tools.length === 0 && gone.length === 0 ? null : (
          <section aria-label="Tools" className="flex flex-col gap-3">
            <Stack gap={0.5}>
              <Text weight="medium">Tools</Text>
              <Text size="sm" tone="muted">
                Each approved site’s tools, and Valet’s own. A cloud agent has none until you turn them on.
              </Text>
            </Stack>
            <ul className="m-0 flex list-none flex-col gap-4 p-0" data-testid="access-tools">
              {[...sites.entries()].map(([siteId, siteTools]) => (
                <li key={siteId} className="flex flex-col gap-2">
                  <Inline gap={2}>
                    <SiteAvatar id={siteId} name={siteTools[0]?.siteName ?? siteId} size="xs" />
                    <Text weight="medium">{siteTools[0]?.siteName ?? siteId}</Text>
                  </Inline>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0 pl-6">
                    {siteTools.map((t) => {
                      const on = toolOn(t)
                      return (
                        <li key={t.ref} className="flex flex-wrap items-center justify-between gap-2">
                          <span className="flex min-w-0 flex-wrap items-center gap-2">
                            <span>{t.title}</span>
                            <Code>{t.tool}</Code>
                            <RiskBadge purpose={t.sideEffect} />
                            {on !== t.on || (t.held && !t.on && draft.tools?.[t.ref] === false) ? (
                              <span className="text-fg-muted text-sm">· not saved</span>
                            ) : null}
                            {t.held && !t.on && draft.tools?.[t.ref] !== false ? (
                              <span className="flex items-center gap-2">
                                <Text size="sm" tone="muted">
                                  It still holds this, but it’s off for every cloud agent now
                                </Text>
                                <Button size="sm" variant="ghost" onClick={() => chooseTool(t.ref, false)}>
                                  Take away
                                </Button>
                              </span>
                            ) : null}
                          </span>
                          <Segmented<'off' | 'on'>
                            size="sm"
                            label={`${t.siteName}: ${t.title}`}
                            value={on ? 'on' : 'off'}
                            onValueChange={(next) => chooseTool(t.ref, next === 'on')}
                            options={[
                              { value: 'off', label: 'Off' },
                              { value: 'on', label: 'On' },
                            ]}
                          />
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ul>
            {/* Granted on a site that is no longer offered: shown, so nothing is hidden. */}
            {gone.map((ref) => {
              const on = toolOn({ ref, on: true })
              return (
                <div key={ref} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Code>{ref}</Code>
                    <Badge size="sm">not offered now</Badge>
                  </span>
                  {on ? (
                    <Button size="sm" variant="ghost" onClick={() => chooseTool(ref, false)}>
                      Take away
                    </Button>
                  ) : (
                    <Text size="sm" tone="muted">
                      Taken away · not saved
                    </Text>
                  )}
                </div>
              )
            })}
          </section>
        )}
        <section aria-label="Valet itself" className="flex flex-col gap-3" data-testid="access-valet">
          <Stack gap={0.5}>
            <Text weight="medium">Valet itself</Text>
            <Text size="sm" tone="muted">
              {local
                ? 'Besides calling tools. Changing these needs no Touch ID: it’s an app on this Mac.'
                : 'Besides calling tools. Turning these on is signed with the rest of the Save.'}
            </Text>
          </Stack>
          <ValetSwitch
            label="See Valet"
            description={
              local
                ? 'Read Valet’s status, sites, Needs you, its own calls and the audit log.'
                : 'Read Valet’s status, its sites and their health, and its own calls.'
            }
            on={valetNow.seeValet}
            changed={valetNow.seeValet !== valet.seeValet}
            onChange={(on) => chooseValet('seeValet', on)}
          />
          {valetNow.allActivity === null ? null : (
            <ValetSwitch
              label="All agents’ activity"
              description="With See Valet, it also sees other apps’ and agents’ calls, not only its own."
              on={valetNow.allActivity}
              disabled={!valetNow.seeValet}
              changed={valetNow.allActivity !== valet.allActivity}
              onChange={(on) => chooseValet('allActivity', on)}
            />
          )}
          <ValetSwitch
            label="Ask for changes"
            description="Build and repair adapters, and ask you for access, settings, logins and sessions. Nothing it writes runs, and nothing widens, until you approve it. Brings See Valet."
            on={valetNow.askForChanges}
            changed={valetNow.askForChanges !== valet.askForChanges}
            onChange={(on) => chooseValet('askForChanges', on)}
          />
          {valet.seeValetSignedAgain &&
          valet.askForChanges &&
          !valetNow.askForChanges &&
          valetNow.seeValet ? (
            <Text size="sm" tone="muted" data-testid="see-valet-signed-again">
              You gave See Valet together with Ask for changes, so keeping it needs Touch ID once more. Turn
              See Valet off too to take both away without it.
            </Text>
          ) : null}
        </section>
        <Stack gap={2}>
          <Inline gap={2}>
            <Button
              disabled={pending.count === 0 || action.busy}
              onClick={() => void save()}
              data-testid="access-save"
            >
              {pending.widens ? 'Save with Touch ID' : 'Save'}
            </Button>
            {pending.count === 0 ? null : (
              <Button variant="ghost" disabled={action.busy} onClick={() => setDraft({})}>
                Discard changes
              </Button>
            )}
          </Inline>
          <Text size="sm" tone="muted">
            Anything you add needs Touch ID once, for the whole Save. Taking things away doesn’t. Only {name}{' '}
            gets what you choose here.
          </Text>
        </Stack>
      </CardContent>
    </Card>
  )
}

function ValetSwitch({
  label,
  description,
  on,
  changed,
  disabled = false,
  onChange,
}: {
  readonly label: string
  readonly description: string
  readonly on: boolean
  readonly changed: boolean
  readonly disabled?: boolean
  readonly onChange: (on: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch aria-label={label} checked={on} disabled={disabled} onCheckedChange={onChange} />
      <Stack gap={0.5}>
        <Text weight="medium">
          {label}
          {changed ? <span className="font-normal text-fg-muted text-sm"> · not saved</span> : null}
        </Text>
        <Text size="sm" tone="muted">
          {description}
        </Text>
      </Stack>
    </div>
  )
}

/** Full access in Calendar or Reminders: adding whole calendars or lists, and deleting its own. */
function FullAccess({
  app,
  on,
  changed,
  onChange,
}: {
  readonly app: 'calendar' | 'reminders'
  readonly on: boolean
  readonly changed: boolean
  readonly onChange: (on: boolean) => void
}) {
  const what = app === 'calendar' ? 'calendars' : 'lists'
  return (
    <ValetSwitch
      label={`Let it add and remove ${what}`}
      description={`Full access: it may add ${what}, which only it is given, and delete the ones it may edit, with everything in them. Off unless you need it.`}
      on={on}
      changed={changed}
      onChange={onChange}
    />
  )
}
