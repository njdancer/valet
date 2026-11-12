// Settings › Devices (#/settings/devices): the iPhones paired with this Mac, and "Pair an iPhone"
// (J1, docs/phone-channel.md). The sheet shows a QR code; once a phone has scanned it, three codes,
// one of which the phone shows. The right one asks for Touch ID, then the phone is paired.

import {
  Button,
  Card,
  CardContent,
  Dialog,
  Field,
  Inline,
  Input,
  List,
  ListRow,
  Section,
  SheetContent,
  Spacer,
  Stack,
  StatusDot,
  SuccessCheck,
  Text,
} from '@valet/ui'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import type { PairingView, PhonesStatus } from '../../../shared/api'
import { useAction, useApi, useLoad } from '../../lib/api-context'
import { Failed } from '../connections/shared'

const UNAVAILABLE: Record<NonNullable<PhonesStatus['unavailableReason']>, string> = {
  'no-relay': 'Pairing a phone needs Valet’s relay. Enter its host name below.',
  'no-keys':
    'This build of Valet can’t pair a phone yet: its Secure Enclave keys don’t do the phone channel so far.',
  'approvals-unavailable': 'Valet can’t ask for approvals right now, so it can’t pair a phone.',
}

const FAILED: Record<Extract<PairingView, { step: 'failed' }>['why'], string> = {
  expired: 'The code expired before a phone scanned it. Start again for a new one.',
  declined:
    'Nothing was paired. If you didn’t start this on your phone, someone else may have scanned the code.',
  'too-many-attempts': 'Three wrong picks, so Valet stopped. Nothing was paired. Start again for a new code.',
  cancelled: 'Pairing was cancelled.',
  'not-sent': 'Valet couldn’t reach its relay. Check the Mac is online, then try again.',
  unavailable: 'Valet couldn’t finish pairing. Nothing was paired.',
}

export function DevicesSection() {
  const status = useLoad((a) => a.phones.status(), [], ['phones-changed'])
  const [pairing, setPairing] = useState(false)
  const s = status.status === 'ready' ? status.data : null
  return (
    <Section title="Devices">
      {status.status === 'error' ? <Failed failed what="load your devices" /> : null}
      <Card>
        <CardContent className="flex flex-col gap-4">
          <Text tone="muted">
            A paired iPhone gets Valet’s approvals and alerts. You can approve there with Face ID or your
            passcode, and lock Valet down from it.
          </Text>
          {s !== null && s.phones.length > 0 ? (
            <List label="Paired phones">
              {s.phones.map((p) => (
                <ListRow
                  key={p.deviceId}
                  leading={<StatusDot tone={p.online ? 'success' : 'neutral'} />}
                  title={p.name}
                  description={`${p.online ? 'Connected' : 'Not connected now'} · paired ${new Date(p.pairedAt).toLocaleDateString()}`}
                  trailing={<RemovePhone deviceId={p.deviceId} name={p.name} />}
                />
              ))}
            </List>
          ) : null}
          {s !== null && !s.available && s.unavailableReason !== null ? (
            <Text tone="muted">{UNAVAILABLE[s.unavailableReason]}</Text>
          ) : null}
          <div>
            <Button variant="primary" disabled={s === null || !s.available} onClick={() => setPairing(true)}>
              Pair an iPhone
            </Button>
          </div>
          {s !== null && s.available ? <RelayLine status={s} /> : null}
          <RelaySetting paired={s?.phones.length ?? 0} />
        </CardContent>
      </Card>
      <PairSheet open={pairing} onOpenChange={setPairing} view={s?.pairing ?? { step: 'idle' }} />
    </Section>
  )
}

/** A relay's host name, as Settings keeps it: lower case, no scheme, no port, no path. */
export function relayHostFrom(typed: string): string | null {
  const host = typed
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/$/, '')
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(host) &&
    host.length <= 253
    ? host
    : null
}

/**
 * The relay's host name. Phones dial the relay they were paired through, so after a change they
 * need pairing again; the description says so when there are any.
 */
function RelaySetting({ paired }: { readonly paired: number }) {
  const api = useApi()
  const action = useAction()
  const settings = useLoad((a) => a.settings.get(), [], ['settings-changed'])
  const saved = settings.status === 'ready' ? settings.data.relayHost : null
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? saved ?? ''
  const host = text.trim() === '' ? null : relayHostFrom(text)
  const invalid = text.trim() !== '' && host === null
  const changed = !invalid && host !== saved
  if (settings.status !== 'ready') return null
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (changed)
          void action.run(async () => {
            await api.settings.set({ relayHost: host })
            setDraft(null)
          })
      }}
    >
      <Field
        label="Relay"
        description={
          paired > 0
            ? 'The host name of your Valet relay. Phones paired now keep using the relay they were paired through, so after a change, pair them again.'
            : 'The host name of your Valet relay, on Cloudflare. Phones and remote agents reach this Mac through it; it only passes on sealed messages.'
        }
        error={invalid ? 'Enter a host name, like relay.example.com' : undefined}
      >
        <Inline gap={2} wrap={false}>
          <Input
            aria-label="Relay host name"
            placeholder="relay.example.com"
            value={text}
            className="flex-1"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" loading={action.busy} disabled={!changed} disabledReason="Nothing to save">
            Save
          </Button>
        </Inline>
      </Field>
      <Failed failed={action.failed} what="save the relay" />
    </form>
  )
}

function RelayLine({ status }: { readonly status: PhonesStatus }) {
  const online = status.relay === 'online'
  return (
    <div className="flex items-center gap-2">
      <StatusDot tone={online ? 'success' : 'warning'} pulse={status.relay === 'connecting'} />
      <Text size="sm" tone="muted">
        {online
          ? 'Connected to the relay'
          : status.relay === 'connecting'
            ? 'Connecting to the relay…'
            : 'Relay not connected'}
        {status.relayOrigin === null ? '' : ` (${new URL(status.relayOrigin).host})`}
      </Text>
    </div>
  )
}

function RemovePhone({ deviceId, name }: { readonly deviceId: string; readonly name: string }) {
  const api = useApi()
  const action = useAction()
  return (
    <Button
      size="sm"
      loading={action.busy}
      onClick={() => void action.run(() => api.phones.remove(deviceId))}
    >
      Remove {name}
    </Button>
  )
}

function PairSheet({
  open,
  onOpenChange,
  view,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly view: PairingView
}) {
  const api = useApi()
  const action = useAction()
  // A fresh code each time the sheet opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the sheet opens
  useEffect(() => {
    if (open) void action.run(() => api.phones.startPairing())
  }, [open])
  const close = (next: boolean) => {
    if (!next && view.step !== 'paired') void api.phones.cancelPairing()
    onOpenChange(next)
  }
  const pick = (code: string | null) => void action.run(() => api.phones.confirmPairing(code))
  return (
    <Dialog open={open} onOpenChange={close}>
      <SheetContent
        title={view.step === 'paired' ? 'iPhone paired' : 'Pair an iPhone'}
        description={description(view)}
        footer={
          <>
            {view.step === 'confirm' ? <Button onClick={() => pick(null)}>None of these</Button> : null}
            <Spacer />
            {view.step === 'failed' ? (
              <Button onClick={() => void action.run(() => api.phones.startPairing())}>Start again</Button>
            ) : null}
            <Button variant={view.step === 'paired' ? 'primary' : 'secondary'} onClick={() => close(false)}>
              {view.step === 'paired' ? 'Done' : 'Cancel'}
            </Button>
          </>
        }
      >
        <Stack gap={4}>
          {view.step === 'scan' ? <QrCode text={view.qr} /> : null}
          {view.step === 'confirm' ? (
            <Stack gap={3}>
              <fieldset className="m-0 grid grid-cols-3 gap-3 border-0 p-0" aria-label="Codes">
                {view.codes.map((code) => (
                  <Button key={code} size="lg" loading={action.busy} onClick={() => pick(code)}>
                    <span className="font-mono text-xl tracking-widest">
                      {code.slice(0, 3)} {code.slice(3)}
                    </span>
                  </Button>
                ))}
              </fieldset>
              {view.attemptsLeft < 3 ? (
                <Text size="sm" tone="warning">
                  That one doesn’t match. {view.attemptsLeft} {view.attemptsLeft === 1 ? 'try' : 'tries'}{' '}
                  left.
                </Text>
              ) : null}
            </Stack>
          ) : null}
          {view.step === 'approving' ? (
            <div className="flex items-center gap-2">
              <StatusDot tone="accent" pulse />
              <Text>Approve with Touch ID to pair {view.deviceName}.</Text>
            </div>
          ) : null}
          {view.step === 'paired' ? (
            <div className="flex items-center gap-2">
              <SuccessCheck size={20} />
              <Text weight="medium">{view.deviceName} gets Valet’s approvals now.</Text>
            </div>
          ) : null}
          {view.step === 'failed' ? <Text>{FAILED[view.why]}</Text> : null}
          <Failed failed={action.failed} what="pair the phone" />
        </Stack>
      </SheetContent>
    </Dialog>
  )
}

function description(view: PairingView): string {
  switch (view.step) {
    case 'idle':
    case 'scan':
      return 'Open Valet on your iPhone and scan this code. It works once, for five minutes.'
    case 'confirm':
      return `${view.deviceName} scanned the code. Pick the code it shows.`
    case 'approving':
      return 'Check it’s your phone, then approve.'
    case 'paired':
      return 'Requests that need you now reach this phone too. You can still approve here.'
    case 'failed':
      return 'Nothing was paired.'
  }
}

function QrCode({ text }: { readonly text: string }) {
  const modules = useMemo(() => {
    try {
      return QRCode.create(text, { errorCorrectionLevel: 'M' }).modules
    } catch {
      return null
    }
  }, [text])
  if (modules === null) return <Text>Valet couldn’t draw the code.</Text>
  const size = modules.size
  const cells: string[] = []
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (modules.get(x, y)) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`)
  return (
    <div className="flex justify-center">
      <svg
        role="img"
        aria-label="Pairing code to scan with your iPhone"
        data-pairing-qr={text}
        viewBox={`0 0 ${size + 8} ${size + 8}`}
        width={240}
        height={240}
        shapeRendering="crispEdges"
        className="rounded-lg"
      >
        <rect width="100%" height="100%" fill="#fff" />
        <path d={cells.join('')} fill="#000" />
      </svg>
    </div>
  )
}
