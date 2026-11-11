// Settings (#/settings[/notifications|/data|/updates|/reset]): how the app behaves. 1Password, its
// CLI and one-time codes from Messages live in Secrets (IA section 10); General links there.

import {
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  Field,
  HealthLine,
  NavTabs,
  Page,
  PageBody,
  PageHeader,
  Section,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Stack,
  Switch,
  Text,
  TextLink,
} from '@valet/ui'
import { useState } from 'react'
import type { Settings, SettingsPatch, UpdateStatus } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { formatTime } from '../../lib/format'
import { href, type SettingsSection } from '../../lib/router'
import { updatesOffWording } from '../../lib/wording'
import { Failed } from '../connections/shared'

const SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'data', label: 'Data and privacy' },
  { id: 'updates', label: 'Updates' },
  { id: 'reset', label: 'Reset and uninstall' },
]

export function SettingsPage({ section }: { readonly section: SettingsSection }) {
  const api = useApi()
  const settings = useLoad((a) => a.settings.get(), [], ['settings-changed'])
  const action = useAction()
  const set = (patch: SettingsPatch) => void action.run(() => api.settings.set(patch))
  const s = settings.status === 'ready' ? settings.data : null
  return (
    <Page>
      <PageHeader title="Settings">
        <NavTabs
          label="Settings sections"
          items={SECTIONS.map((t) => ({
            href: href.settings(t.id),
            label: t.label,
            active: t.id === section,
          }))}
        />
      </PageHeader>
      <PageBody width="form">
        {settings.status === 'error' ? <Failed failed what="load the settings" /> : null}
        <Failed failed={action.failed} what="save the setting" />
        {section === 'general' && s !== null ? <General settings={s} set={set} /> : null}
        {section === 'notifications' && s !== null ? <Notifications settings={s} set={set} /> : null}
        {section === 'data' && s !== null ? <Data settings={s} set={set} /> : null}
        {section === 'updates' ? <Updates settings={s} set={set} /> : null}
        {section === 'reset' ? <Reset /> : null}
      </PageBody>
    </Page>
  )
}

interface SectionProps {
  readonly settings: Settings
  readonly set: (patch: SettingsPatch) => void
}

function General({ settings, set }: SectionProps) {
  return (
    <Section title="General">
      <Card>
        <CardContent className="flex flex-col gap-5">
          <Field
            inline
            label="Open Valet when you log in"
            description="Valet lives in the menu bar; this starts it with your Mac."
          >
            <Switch checked={settings.launchAtLogin} onCheckedChange={(on) => set({ launchAtLogin: on })} />
          </Field>
          <Field
            inline
            label="1Password and one-time codes"
            description="The 1Password account, its command-line tool and codes from Messages are set in Secrets, beside the logins that use them."
          >
            <Button asChild>
              <a href={href.secrets()}>Open Secrets</a>
            </Button>
          </Field>
        </CardContent>
      </Card>
    </Section>
  )
}

function Notifications({ settings, set }: SectionProps) {
  return (
    <Section title="Notifications">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Field
            inline
            label="Tell me when Valet needs me"
            description="An approval, a login, a site Valet stopped calling, or a downloaded update. A notification only opens Valet; nothing is approved from it."
          >
            <Switch checked={settings.notifications} onCheckedChange={(on) => set({ notifications: on })} />
          </Field>
        </CardContent>
      </Card>
      <Text size="sm" tone="muted">
        Whatever is waiting is also in <TextLink href={href.needsYou()}>Needs you</TextLink> and the menu bar.
      </Text>
    </Section>
  )
}

/** The retention choices offered, plus the current value if a settings file holds another. */
export function retentionChoices(current: number): number[] {
  const choices = [1, 7, 14, 30, 90, 365]
  return choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b)
}

function Data({ settings, set }: SectionProps) {
  const api = useApi()
  const exporting = useAction()
  return (
    <Section title="Data and privacy">
      <Card>
        <CardContent className="flex flex-col gap-5">
          <Field
            inline
            label="Keep call traces and screenshots for"
            description="Older ones are deleted. The audit log is always kept."
          >
            <Select
              value={String(settings.traceRetentionDays)}
              onValueChange={(v) => set({ traceRetentionDays: Number(v) })}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {retentionChoices(settings.traceRetentionDays).map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {days === 1 ? '1 day' : `${days} days`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            inline
            label="Audit log"
            description={
              <>
                Every call, login and approval, chained so a change can be spotted.{' '}
                <TextLink href={href.audit()}>Open the audit log</TextLink>
              </>
            }
          >
            <Button
              loading={exporting.busy}
              onClick={() => void exporting.run(() => api.audit.exportJsonl())}
            >
              Export…
            </Button>
          </Field>
          <Failed failed={exporting.failed} what="export the audit log" />
        </CardContent>
      </Card>
    </Section>
  )
}

function updateLine(
  status: UpdateStatus,
  now: number,
): { tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent'; text: string } {
  const checked = status.checkedAt !== null ? ` · checked ${formatTime(status.checkedAt, now)}` : ''
  switch (status.state) {
    case 'disabled':
      return {
        tone: 'neutral',
        text: `Valet ${status.current} · ${updatesOffWording(status.disabledReason ?? '')}`,
      }
    case 'not-checked':
      return { tone: 'neutral', text: `Valet ${status.current} · not checked yet` }
    case 'up-to-date':
      return { tone: 'success', text: `Valet ${status.current} is up to date${checked}` }
    case 'checking':
      return { tone: 'accent', text: `Valet ${status.current} · checking…` }
    case 'available':
      return { tone: 'accent', text: `${status.available} available${checked}` }
    case 'downloading':
      return { tone: 'accent', text: `Downloading ${status.available}` }
    case 'ready':
      return { tone: 'accent', text: `${status.available} downloaded` }
    case 'error':
      return { tone: 'danger', text: `Couldn’t check for updates${checked}` }
  }
}

function Updates({
  settings,
  set,
}: {
  readonly settings: Settings | null
  readonly set: (patch: SettingsPatch) => void
}) {
  const api = useApi()
  const now = useNow(60_000)
  const status = useLoad((a) => a.updates.status(), [], ['settings-changed', 'app-changed'])
  const check = useAction()
  const u = status.status === 'ready' ? status.data : null
  const line = u === null ? null : updateLine(u, now)
  return (
    <Section title="Updates">
      <Card>
        <CardContent className="flex flex-col gap-5">
          {status.status === 'error' ? <Failed failed what="load the update status" /> : null}
          {u !== null && line !== null ? (
            <Stack gap={2}>
              <HealthLine
                tone={line.tone}
                action={
                  <Button
                    size="sm"
                    loading={check.busy || u.state === 'checking'}
                    disabled={u.state === 'disabled'}
                    disabledReason={
                      u.disabledReason !== null ? updatesOffWording(u.disabledReason) : undefined
                    }
                    onClick={() => void check.run(() => api.updates.check())}
                  >
                    Check now
                  </Button>
                }
              >
                {line.text}
              </HealthLine>
              {u.state === 'ready' && settings !== null ? (
                // There is no install action: a downloaded update installs on quit, and only if that's on.
                <Text size="sm" tone="muted">
                  {settings.autoInstallUpdates
                    ? 'It installs when Valet quits.'
                    : 'Turn on automatic installs below to apply it.'}
                </Text>
              ) : null}
              <HealthLine tone={u.signed ? 'success' : 'danger'}>
                {u.signed ? 'Signed with a Developer ID' : 'Not signed with a Developer ID'}
              </HealthLine>
              <Failed failed={check.failed} what="check for updates" />
            </Stack>
          ) : null}
          {settings !== null ? (
            <>
              <Field inline label="Channel" description="Beta gets new versions first.">
                <Segmented
                  label="Update channel"
                  value={settings.updateChannel}
                  onValueChange={(updateChannel) => set({ updateChannel })}
                  options={[
                    { value: 'stable', label: 'Stable' },
                    { value: 'beta', label: 'Beta' },
                  ]}
                />
              </Field>
              <Field
                inline
                label="Install updates automatically"
                description="Download in the background, install when Valet quits."
              >
                <Switch
                  checked={settings.autoInstallUpdates}
                  onCheckedChange={(on) => set({ autoInstallUpdates: on })}
                />
              </Field>
            </>
          ) : null}
        </CardContent>
      </Card>
    </Section>
  )
}

/**
 * Reset and uninstall. Each button asks here first, then asks the main process for its own native
 * dialog, which says what goes and is the one place the person agrees; nothing is erased from here.
 */
function Reset() {
  const api = useApi()
  const action = useAction()
  const [asking, setAsking] = useState<'reset' | 'uninstall' | null>(null)
  const erase = (kind: 'reset' | 'uninstall') => void action.run(() => api.app.erase(kind))
  return (
    <>
      <Section title="Setup">
        <Card>
          <CardContent>
            <Field
              inline
              label="Run setup again"
              description="Walks through 1Password, a site, its login and connecting Claude. Nothing is removed."
            >
              <Button asChild>
                <a href={href.setup()}>Run setup</a>
              </Button>
            </Field>
          </CardContent>
        </Card>
      </Section>
      <Section title="Reset and uninstall">
        <Card>
          <CardContent className="flex flex-col gap-5">
            <Field
              inline
              label="Reset Valet"
              description="Erase everything Valet keeps and start again: Keychain copies, logins given, approvals, apps, site sessions, the audit log and settings."
            >
              <Button variant="danger-soft" onClick={() => setAsking('reset')}>
                Reset Valet…
              </Button>
            </Field>
            <Field
              inline
              label="Uninstall Valet"
              description="Erase the same things, then move Valet to the Trash. Valet lists what you have to remove yourself, such as its entry in Claude’s config."
            >
              <Button variant="danger-soft" onClick={() => setAsking('uninstall')}>
                Uninstall Valet…
              </Button>
            </Field>
            <Failed failed={action.failed} what="start that" />
          </CardContent>
        </Card>
      </Section>
      <ConfirmDialog
        open={asking === 'reset'}
        onOpenChange={(open) => setAsking(open ? 'reset' : null)}
        destructive
        title="Reset Valet?"
        description="Everything Valet keeps is erased and it starts again as new. This can’t be undone."
        confirmLabel="Reset Valet"
        onConfirm={() => erase('reset')}
      >
        <EraseList />
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === 'uninstall'}
        onOpenChange={(open) => setAsking(open ? 'uninstall' : null)}
        destructive
        title="Uninstall Valet?"
        description="Everything Valet keeps is erased, then Valet moves itself to the Trash. This can’t be undone."
        confirmLabel="Uninstall Valet"
        onConfirm={() => erase('uninstall')}
      >
        <EraseList />
      </ConfirmDialog>
    </>
  )
}

function EraseList() {
  return (
    <Stack gap={2}>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-md">
        <li>Keychain copies and the logins sites may use</li>
        <li>Site approvals, apps and cloud agents</li>
        <li>Site sessions, call traces and the audit log</li>
        <li>Settings</li>
      </ul>
      <Text size="sm" tone="muted">
        Your 1Password items aren’t touched. Want the audit log first?{' '}
        <TextLink href={href.settings('data')}>Export it</TextLink>. Valet asks once more before anything
        goes.
      </Text>
    </Stack>
  )
}
