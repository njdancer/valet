// What one agent may use (docs/access.md): each Mail account, calendar and reminder list at Off,
// Read or Edit, and for a cloud agent each tool of an approved site and Valet's own (the browser's),
// on or off. Changes are a draft until Save, and one Save is one Touch ID for everything it adds.
// Taking things away needs no Touch ID.

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
  calendar: 'Edit: adds, changes and deletes events, invitations included.',
  reminders: 'Edit: adds, changes and completes reminders.',
}

const RANK: Readonly<Record<AccessChoice, number>> = { off: 0, read: 1, edit: 2 }

type Draft = Partial<Record<AccessApp, Record<string, AccessChoice>>> & { tools?: Record<string, boolean> }

/** The draft's changes against what is saved, and whether any of them adds something. */
export function accessChanges(
  apps: readonly AgentAccessApp[],
  draft: Draft,
  tools: readonly AgentAccessTool[] = [],
  gone: readonly string[] = [],
): { readonly changes: AgentAccessChanges; readonly count: number; readonly widens: boolean } {
  const changes: Partial<Record<AccessApp, Record<string, AccessChoice>>> & {
    tools?: Record<string, boolean>
  } = {}
  let count = 0
  let widens = false
  for (const [ref, on] of Object.entries(draft.tools ?? {})) {
    const saved = tools.find((t) => t.ref === ref)?.on ?? gone.includes(ref)
    if (on === saved) continue
    changes.tools = { ...(changes.tools ?? {}), [ref]: on }
    count += 1
    if (on) widens = true
  }
  for (const app of apps) {
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
  const { apps, tools, gone } = view.data
  if (apps.length === 0 && tools.length === 0 && gone.length === 0) return null
  const pending = accessChanges(apps, draft, tools, gone)
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
                            {on !== t.on ? <span className="text-fg-muted text-sm">· not saved</span> : null}
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
