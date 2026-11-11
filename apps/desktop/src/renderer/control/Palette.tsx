// The command palette (mod+K): every place, site, waiting item, recent call (by its ref), app and
// setting is reachable by name, and the kill switches run from here too. It answers "where is that
// screen?" for anything the sidebar doesn't show.

import { CommandGroup, CommandItem, CommandPalette, SiteAvatar } from '@valet/ui'
import { FileClock, Inbox, Pause, Play, Plug, Settings, ShieldCheck } from 'lucide-react'
import { useApi, useLoad } from '../lib/api-context'
import { callRef } from '../lib/format'
import { needsYouView } from '../lib/needs-you'
import { href, navigate, SETTINGS_SECTIONS, type SettingsSection } from '../lib/router'
import { PLACES } from './Sidebar'

const SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General',
  notifications: 'Notifications',
  data: 'Data and privacy',
  updates: 'Updates',
  reset: 'Reset and uninstall',
}

export function CommandMenu({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const api = useApi()
  const adapters = useLoad((a) => a.adapters.list(), [], ['adapters-changed'])
  const attention = useLoad((a) => a.attention.list(), [], ['attention-changed'])
  const runs = useLoad((a) => a.runs.list({ limit: 30 }), [], ['runs-changed'])
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const app = useLoad((a) => a.app.status(), [], ['app-changed'])

  const go = (to: string) => {
    onOpenChange(false)
    navigate(to)
  }
  const unapproved = new Set(
    adapters.status === 'ready'
      ? adapters.data.filter((a) => a.approval !== 'approved').map((a) => a.id)
      : [],
  )

  return (
    <CommandPalette open={open} onOpenChange={onOpenChange}>
      {attention.status === 'ready' && attention.data.length > 0 ? (
        <CommandGroup heading="Needs you">
          {attention.data.map((item) => {
            const view = needsYouView(item, (id) => unapproved.has(id))
            return (
              <CommandItem key={item.id} icon={<Inbox />} onSelect={() => go(href.needsYou(item.id))}>
                {view.title}
              </CommandItem>
            )
          })}
        </CommandGroup>
      ) : null}
      <CommandGroup heading="Go to">
        {PLACES.map((p) => (
          <CommandItem key={p.place} shortcut={p.shortcut} onSelect={() => go(p.to)}>
            {p.label}
          </CommandItem>
        ))}
        <CommandItem icon={<FileClock />} shortcut="mod+shift+3" onSelect={() => go(href.audit())}>
          Audit log
        </CommandItem>
        <CommandItem icon={<Plug />} onSelect={() => go(href.remote())}>
          Remote access
        </CommandItem>
      </CommandGroup>
      {adapters.status === 'ready' && adapters.data.length > 0 ? (
        <CommandGroup heading="Sites">
          {adapters.data.map((a) => (
            <CommandItem
              key={a.id}
              value={`site ${a.name} ${a.site}`}
              icon={<SiteAvatar id={a.id} name={a.name} size="xs" />}
              hint={a.site}
              onSelect={() => go(href.site(a.id))}
            >
              {a.name}
            </CommandItem>
          ))}
          {adapters.data
            .filter((a) => a.pendingUpdate !== null || a.approval === 'unapproved')
            .map((a) => (
              <CommandItem key={`review-${a.id}`} onSelect={() => go(href.review(a.id))}>
                {a.approval === 'unapproved' ? `Review ${a.name}` : `Review ${a.name} update`}
              </CommandItem>
            ))}
        </CommandGroup>
      ) : null}
      {runs.status === 'ready' && runs.data.length > 0 ? (
        <CommandGroup heading="Recent calls">
          {runs.data.map((r) => (
            <CommandItem
              key={r.callId}
              value={`call ${callRef(r.callId)} ${r.tool} ${r.adapterName}`}
              hint={r.adapterName}
              onSelect={() => go(href.call(r.callId))}
            >
              <span className="font-mono">{callRef(r.callId)}</span> · {r.tool}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {clients.status === 'ready' && clients.data.some((c) => c.revokedAt === null) ? (
        <CommandGroup heading="Apps">
          {clients.data
            .filter((c) => c.revokedAt === null)
            .map((c) => (
              <CommandItem key={c.id} value={`app ${c.name}`} onSelect={() => go(href.client(c.id))}>
                {c.name}
              </CommandItem>
            ))}
        </CommandGroup>
      ) : null}
      <CommandGroup heading="Settings">
        {SETTINGS_SECTIONS.map((s) => (
          <CommandItem
            key={s}
            icon={<Settings />}
            value={`settings ${SECTION_LABEL[s]}`}
            onSelect={() => go(href.settings(s))}
          >
            {SECTION_LABEL[s]}
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandGroup heading="Actions">
        {app.status === 'ready' ? (
          <CommandItem
            icon={app.data.paused ? <Play /> : <Pause />}
            shortcut="mod+shift+P"
            onSelect={() => {
              onOpenChange(false)
              void api.app.setPaused(!app.data.paused).catch(() => undefined)
            }}
          >
            {app.data.paused ? 'Resume Valet' : 'Pause Valet'}
          </CommandItem>
        ) : null}
        <CommandItem
          icon={<ShieldCheck />}
          onSelect={() => {
            onOpenChange(false)
            void api.audit.verify().catch(() => undefined)
            navigate(href.audit())
          }}
        >
          Check the audit log now
        </CommandItem>
        <CommandItem onSelect={() => go(href.setup('welcome'))}>Run setup again</CommandItem>
      </CommandGroup>
    </CommandPalette>
  )
}
