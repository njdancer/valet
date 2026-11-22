// Settings › Mail (#/settings/mail, docs/mail.md): turning on Mail on this Mac walks through what it
// needs, in order. Start the reader helper, give it (and only it) Full Disk Access, then pick the
// accounts agents may read, and whether they may save drafts. Valet never sends mail.

import {
  Button,
  Card,
  CardContent,
  CheckboxOption,
  Field,
  Section,
  Stack,
  Stepper,
  Switch,
  Text,
} from '@valet/ui'
import { useEffect, useState } from 'react'
import type { MailAction, MailSettingsPatch, MailStatus } from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { Failed } from '../connections/shared'

/** Mail's "On My Mac": mailboxes on this Mac only, outside any email account. */
const LOCAL_HINT = 'Mailboxes kept only on this Mac, not in any email account'

/** How often the screen looks again while the person is in System Settings. */
const RECHECK_MS = 2000

export function MailSection() {
  const api = useApi()
  const loaded = useLoad((a) => a.mail.status(), [], ['adapters-changed'])
  const [latest, setLatest] = useState<MailStatus | null>(null)
  const action = useAction()
  const [startResult, setStartResult] = useState<'requires-approval' | 'failed' | null>(null)
  const status = latest ?? (loaded.status === 'ready' ? loaded.data : null)
  const waiting = status !== null && (status.state === 'not-running' || status.state === 'needs-access')

  // While setup waits on System Settings, look again every few seconds so the next step appears.
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void api.mail
        .status()
        .then((s) => {
          if (s !== null) setLatest(s)
        })
        .catch(() => undefined)
    }, RECHECK_MS)
    return () => clearInterval(timer)
  }, [api, waiting])

  const update = (patch: MailSettingsPatch) =>
    void action.run(async () => {
      const next = await api.mail.update(patch)
      if (next !== null) setLatest(next)
    })
  const press = (which: MailAction) =>
    void action.run(async () => {
      await api.mail.action(which)
      const next = await api.mail.status()
      if (next !== null) setLatest(next)
    })
  const start = () =>
    void action.run(async () => {
      await api.mail.action('start-reader')
      const next = await api.mail.status()
      if (next !== null) setLatest(next)
      setStartResult(next?.state === 'not-running' ? 'requires-approval' : null)
    })

  if (loaded.status === 'error') return <Failed failed what="load Mail’s settings" />
  if (status === null) return null
  const on = status.settings.enabled
  return (
    <Section title="Mail">
      <Failed failed={action.failed} what="change Mail’s settings" />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Field
            inline
            label="Let agents read Mail on this Mac"
            description="Agents search and read the accounts you pick, from the mail the Mail app already keeps on this Mac. Valet never sends mail."
          >
            <Switch checked={on} onCheckedChange={(v) => update({ enabled: v })} disabled={action.busy} />
          </Field>
        </CardContent>
      </Card>
      {on ? <SetupSteps status={status} /> : null}
      {on && status.state === 'no-reader' ? (
        <Text tone="muted">
          This build of Valet has no Mail reader. A development build needs “Valet Reader”, made by
          swift-bridge/build-helper-apps.sh.
        </Text>
      ) : null}
      {on && status.state === 'unsupported' ? (
        <Text tone="muted">
          Mail on this Mac keeps its mail in a way this version of Valet can’t read yet. Nothing was read.
        </Text>
      ) : null}
      {on && status.state === 'not-running' ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Text weight="semibold">Start the Mail reader</Text>
            <Text tone="muted">
              A small helper reads Mail’s files for Valet. It is the only part of Valet that gets to see them.
            </Text>
            {startResult === 'requires-approval' ? (
              <Text tone="muted">
                If macOS asked, allow Valet in System Settings › General › Login Items, then come back here.
              </Text>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={start} disabled={action.busy}>
                Start the reader
              </Button>
              {startResult === 'requires-approval' ? (
                <Button variant="secondary" onClick={() => press('login-items')} disabled={action.busy}>
                  Open Login Items
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
      {on && status.state === 'needs-access' ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Text weight="semibold">Give the reader Full Disk Access</Text>
            <Text tone="muted">
              macOS keeps Mail’s files private. In System Settings › Privacy &amp; Security › Full Disk
              Access, turn on “Valet Reader”. If it isn’t in the list, press +, or drag it in from the Finder
              window. Only the reader gets this access, not Valet itself.
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => press('full-disk-access')} disabled={action.busy}>
                Open Full Disk Access
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

function SetupSteps({ status }: { readonly status: MailStatus }) {
  const order = ['not-running', 'needs-access', 'ready'] as const
  const at = order.indexOf(status.state as (typeof order)[number])
  if (at < 0) return null
  const picked = status.settings.accounts.length > 0
  const state = (i: number) =>
    (i < at ? 'done' : i === at ? 'current' : 'upcoming') as 'done' | 'current' | 'upcoming'
  return (
    <Stepper
      orientation="horizontal"
      steps={[
        { id: 'reader', label: 'Start the reader', state: state(0) },
        { id: 'access', label: 'Full Disk Access', state: state(1) },
        { id: 'accounts', label: 'Pick accounts', state: at === 2 && picked ? 'done' : state(2) },
      ]}
    />
  )
}

function Choices({
  status,
  update,
  busy,
}: {
  readonly status: MailStatus
  readonly update: (patch: MailSettingsPatch) => void
  readonly busy: boolean
}) {
  const allowed = new Set(status.settings.accounts)
  const toggle = (id: string, on: boolean) => {
    const next = new Set(allowed)
    if (on) next.add(id)
    else next.delete(id)
    // Keep Mail's order, so the saved list doesn't depend on the order of clicks.
    update({ accounts: status.accounts.map((a) => a.id).filter((a) => next.has(a)) })
  }
  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Text weight="semibold">Accounts agents may read</Text>
          {status.accounts.length === 0 ? (
            <Text tone="muted">Mail has no accounts on this Mac yet.</Text>
          ) : (
            <Stack gap={3}>
              {status.accounts.map((a) => (
                <CheckboxOption
                  key={a.id}
                  label={a.name}
                  {...(a.id === 'local'
                    ? { description: LOCAL_HINT }
                    : a.address === null
                      ? {}
                      : { description: a.address })}
                  checked={a.allowed}
                  disabled={busy}
                  onCheckedChange={(v) => toggle(a.id, v)}
                />
              ))}
            </Stack>
          )}
          {status.accounts.length > 0 && allowed.size === 0 ? (
            <Text size="sm" tone="muted">
              Agents see no Mail tools until you pick at least one account.
            </Text>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Field
            inline
            label="Let agents save drafts"
            description="An agent can write a new message or a reply and leave it in Mail’s Drafts, from an account you picked. You read it there and decide whether to send it."
          >
            <Switch
              checked={status.settings.drafts}
              onCheckedChange={(v) => update({ drafts: v })}
              disabled={busy}
            />
          </Field>
        </CardContent>
      </Card>
    </>
  )
}
