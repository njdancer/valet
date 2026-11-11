// The confirmation window (#/confirm/<id>; wireframes 80-windows, confirm-*): a step a tool wants to
// take that only the person may allow, answered on this Mac. The main process opens it floating and
// on top; nothing else ever shows a confirmation, and the main process accepts an Allow only from
// this window. MCP clients have no way to reach it.
//
// What Valet checked itself comes first and is worded by the app; the adapter's own text sits apart
// under "From the site", attributed and marked unverified. The client's name is only the name it
// gave itself, so it is always worded as that claim.
//
// A client can time a call so this window appears under a click the person was already making in
// another app. So Decline has the focus (Return and Escape decline), and Allow stays off for
// CONFIRM_ARM_MS after the window mounts and again whenever it regains focus or visibility
// (useArmed). The main process enforces the same delay on its side.

import {
  Badge,
  Banner,
  Button,
  CheckItem,
  CheckList,
  Code,
  ConfirmationPanel,
  type ConfirmationState,
  DescriptionList,
  Disclosure,
  EmptyState,
  HashChip,
  ObjectLink,
  RiskBadge,
  SiteAvatar,
  Spinner,
  Stack,
  Text,
  Value,
} from '@valet/ui'
import { CircleCheck } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { CONFIRM_ARM_MS, type ConfirmationItem } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { callRef, formatClock, formatDay } from '../../lib/format'
import { confirmTitle, needsYouOrder, needsYouView } from '../../lib/needs-you'
import { linksOpenInValet, needsYouHref, openRoute } from '../../lib/open-in-valet'
import { href } from '../../lib/routes'
import { clientClaim, TRANSPORT_WORDING } from '../../lib/wording'
import { capText, InputPreview } from './InputPreview'
import { useArmed } from './use-armed'

/** Longest adapter note shown; the rest is cut so it can't push the buttons out of the window. */
const MAX_NOTE = 600

/** What this window did with the confirmation. */
type Answered =
  | { readonly by: 'me'; readonly approved: boolean; readonly at: number }
  /** It left the list without an answer from here: answered elsewhere, cancelled, or locked down. */
  | { readonly by: 'elsewhere'; readonly at: number }

export function ConfirmationWindow({
  confirmationId,
  armDelayMs = CONFIRM_ARM_MS,
}: {
  readonly confirmationId: string
  /** Tests shorten it; the window always uses CONFIRM_ARM_MS. */
  readonly armDelayMs?: number
}) {
  const api = useApi()
  const now = useNow(1000)
  const attention = useLoad((a) => a.attention.list(), [], ['attention-changed'])
  const [answered, setAnswered] = useState<Answered | null>(null)
  // The last time this window saw its confirmation, so it can still say what it was once it's gone.
  const last = useRef<ConfirmationItem | null>(null)
  const items = attention.status === 'ready' ? attention.data : []
  const found =
    items.find((i): i is ConfirmationItem => i.kind === 'confirmation' && i.id === confirmationId) ?? null
  if (found !== null) last.current = found
  const item = found ?? last.current

  // Gone from the list while this window showed it, without an answer from here.
  useEffect(() => {
    if (attention.status === 'ready' && found === null && last.current !== null && answered === null)
      setAnswered({ by: 'elsewhere', at: Date.now() })
  }, [attention.status, found, answered])

  const views = needsYouOrder(items.map((i) => needsYouView(i, () => false))).filter((v) => !v.missed)
  const position = views.findIndex((v) => v.id === confirmationId)

  return (
    // In-app links (the call, the next item) open in the control panel, never in this window.
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates link clicks; links keep their own keys
    // biome-ignore lint/a11y/noStaticElementInteractions: as above
    <div className="flex h-full flex-col bg-raised" onClick={linksOpenInValet(api)}>
      {item === null ? (
        attention.status === 'loading' ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              icon={<CircleCheck />}
              title={attention.status === 'error' ? 'Couldn’t load the confirmation' : 'Nothing to confirm'}
              action={
                <Button size="lg" onClick={() => window.close()}>
                  Close
                </Button>
              }
            >
              {attention.status === 'error'
                ? 'Valet will try again when something changes. Nothing was allowed.'
                : 'This confirmation was answered or has timed out.'}
            </EmptyState>
          </div>
        )
      ) : (
        <Confirm
          item={item}
          now={now}
          answered={answered}
          onAnswered={(approved) => setAnswered({ by: 'me', approved, at: Date.now() })}
          armDelayMs={armDelayMs}
          queue={
            position === -1
              ? { position: 1, total: views.length + 1 }
              : { position: position + 1, total: views.length }
          }
          next={answered === null ? null : (views.find((v) => v.id !== confirmationId) ?? null)}
          waiting={views.filter((v) => v.id !== confirmationId).length}
          onNext={(to) => void openRoute(api, to).catch(() => undefined)}
        />
      )}
    </div>
  )
}

function Confirm({
  item,
  now,
  answered,
  onAnswered,
  armDelayMs,
  queue,
  next,
  waiting,
  onNext,
}: {
  readonly item: ConfirmationItem
  readonly now: number
  readonly answered: Answered | null
  readonly onAnswered: (approved: boolean) => void
  readonly armDelayMs: number
  readonly queue: { readonly position: number; readonly total: number }
  readonly next: ReturnType<typeof needsYouView> | null
  /** How many other things still wait, for "3 still waiting" once this one is answered. */
  readonly waiting: number
  readonly onNext: (to: ReturnType<typeof needsYouHref>) => void
}) {
  const api = useApi()
  const action = useAction()
  const armed = useArmed(armDelayMs)
  const until = Date.parse(item.expiresAt)
  const expired = answered === null && until <= now
  const irreversible = item.sideEffect === 'irreversible'
  const allowLabel = irreversible ? `Approve ${item.toolTitle}` : item.toolTitle
  const canApprove = armed && !action.busy && !expired && answered === null
  const ref = callRef(item.callId)

  const answer = async (approved: boolean) => {
    // The button is off too; this also stops a click queued before the render that turned it off.
    if (approved && !canApprove) return
    if (action.busy || expired || answered !== null) return
    if (await action.run(() => api.answerConfirmation(item.id, approved))) onAnswered(approved)
  }

  // Escape declines wherever the focus is (the panel handles it when the focus is inside it).
  const answerRef = useRef(answer)
  answerRef.current = answer
  const declinable = !action.busy && !expired && answered === null
  useEffect(() => {
    if (!declinable) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) void answerRef.current(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [declinable])

  const state: ConfirmationState =
    answered !== null ? 'answered' : expired ? 'expired' : canApprove ? 'ready' : 'arming'
  const title = `${expired ? 'Missed: ' : ''}${confirmTitle(item.toolTitle, item.adapterName)}`
  const done = state === 'answered' || state === 'expired'

  return (
    <ConfirmationPanel
      className="min-h-0 flex-1"
      site={<SiteAvatar id={item.adapterId} name={item.adapterName} size="lg" />}
      title={title}
      sentence={
        <>
          <strong className="font-semibold text-fg">{clientClaim(item.client)}</strong>, connected over{' '}
          {TRANSPORT_WORDING[item.clientTransport]}, asked at {formatClock(item.requestedAt)} to run{' '}
          <strong className="font-semibold text-fg">{item.toolTitle}</strong> on {item.adapterName}.{' '}
          {irreversible
            ? 'This can’t be undone.'
            : item.trigger === 'tool-request'
              ? 'The tool stopped to ask you before it goes on.'
              : 'It changes your account.'}
        </>
      }
      fromSite={
        item.adapterNote !== null ? (
          <FromSite
            note={item.adapterNote}
            adapterName={item.adapterName}
            struck={expired || (answered !== null && !(answered.by === 'me' && answered.approved))}
          />
        ) : undefined
      }
      purpose={irreversible ? 'irreversible' : 'write'}
      allowLabel={allowLabel}
      declineLabel="Decline"
      state={state}
      armingReason="Ready in a moment, so a key press meant for another app can’t answer this."
      until={until}
      now={now}
      queue={done ? undefined : queue}
      result={
        answered?.by === 'me'
          ? `You chose ${answered.approved ? allowLabel : 'Decline'} at ${formatClock(answered.at)}.`
          : undefined
      }
      next={
        next !== null ? <Button onClick={() => onNext(needsYouHref(next))}>Next: {next.title}</Button> : null
      }
      missedActions={
        <>
          <Button variant="ghost" asChild>
            <a href={href.call(item.callId)}>Open call {ref}</a>
          </Button>
          <Button
            onClick={() =>
              void api.app
                .copyText(
                  `In Valet, "${confirmTitle(item.toolTitle, item.adapterName)}" was missed at ${formatClock(until)} (call ${ref}). Please try again; I'm at the Mac now.`,
                )
                .catch(() => undefined)
            }
          >
            Copy “try again” for Claude
          </Button>
        </>
      }
      onAllow={() => void answer(true)}
      onDecline={() => void answer(false)}
      onClose={() => window.close()}
      details={
        <Stack gap={4}>
          {answered !== null ? <AnsweredBanner item={item} answered={answered} waiting={waiting} /> : null}
          {expired ? (
            <Banner tone="neutral" title={`Nobody answered by ${formatClock(until)}.`}>
              Nothing was done, and {clientClaim(item.client, 'inline')} was told it timed out.
            </Banner>
          ) : null}
          {done ? null : (
            <>
              <Stack gap={1.5}>
                <Text size="sm" tone="muted" weight="medium">
                  Input from the client
                </Text>
                <InputPreview parts={item.input} label="Input from the client" />
              </Stack>
              <Checked item={item} />
            </>
          )}
          <Disclosure summary="Details: tool, call, version">
            <DescriptionList
              items={[
                { term: 'Tool', value: <Value mono>{item.tool}</Value> },
                {
                  term: 'Call',
                  value: (
                    <ObjectLink href={href.call(item.callId)} mono>
                      {ref}
                    </ObjectLink>
                  ),
                },
                {
                  term: 'Asked by',
                  value: `${clientClaim(item.client)} over ${TRANSPORT_WORDING[item.clientTransport]}`,
                },
                {
                  term: 'Version',
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <ObjectLink href={href.site(item.adapterId, 'versions')}>
                        {item.adapterName} {item.adapterVersion}
                      </ObjectLink>
                      <HashChip value={item.adapterHash} label="adapter hash" />
                    </span>
                  ),
                },
              ]}
            />
          </Disclosure>
          {done ? null : (
            <Text size="sm" tone="muted">
              If nobody answers by {formatClock(until)}, nothing is done and the app is told it timed out. The
              AI app can’t answer this for you.
            </Text>
          )}
          {action.failed ? (
            <Text role="alert" size="sm" tone="danger" weight="medium">
              Couldn’t send your answer. Try again.
            </Text>
          ) : null}
        </Stack>
      }
    />
  )
}

function FromSite({
  note,
  adapterName,
  struck,
}: {
  readonly note: string
  readonly adapterName: string
  readonly struck: boolean
}) {
  return (
    <span className="flex flex-col gap-1.5">
      {/* Plain text, never markup: the adapter wrote it. */}
      <span data-testid="adapter-note" className={struck ? 'text-fg-subtle line-through' : 'text-fg'}>
        {capText(note, MAX_NOTE)}
      </span>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle not-italic">
        Written by the {adapterName} adapter; Valet can’t check its wording.
        <Badge tone="warning" size="sm">
          Not verified by Valet
        </Badge>
      </span>
    </span>
  )
}

/** What Valet checked itself, from the runtime's own knowledge (never the adapter's words). */
function Checked({ item }: { readonly item: ConfirmationItem }) {
  const irreversible = item.sideEffect === 'irreversible'
  return (
    <CheckList label="Valet checked the request itself">
      <CheckItem
        state="pass"
        title={
          <>
            {item.adapterName} {item.adapterVersion}
            {item.approvedAt !== null ? `, the version you approved on ${formatDay(item.approvedAt)}` : ''}
          </>
        }
      />
      <CheckItem
        state="pass"
        title={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            The tool declared it
            <RiskBadge purpose={item.sideEffect} />
            {irreversible ? 'so only you can approve it' : null}
          </span>
        }
      />
      {item.requests.length > 0 ? (
        <CheckItem
          state="pass"
          title={
            <span data-testid="confirm-requests">
              If you allow it, the tool says it will make{' '}
              {item.requests.map((r) => (
                <span key={`${r.method} ${r.path}`} className="inline-flex items-center gap-1">
                  <Code>
                    {r.method} {r.path}
                  </Code>{' '}
                  <RiskBadge purpose={r.purpose} />{' '}
                </span>
              ))}
              . Each is declared in the manifest and allowed for this tool. Approving doesn’t unlock them.
            </span>
          }
        />
      ) : null}
      <CheckItem
        state="pass"
        title={`Its requests stay within the manifest’s declared paths, at most ${item.requestCeiling} this run`}
      />
      <CheckItem
        state={item.unlocks.length === 0 ? 'pass' : 'info'}
        title={
          item.unlocks.length === 0 ? (
            'Approving unlocks no irreversible request'
          ) : (
            <span>
              Approving unlocks, for this run only:{' '}
              {item.unlocks.map((u) => (
                <Code key={`${u.method} ${u.path}`} className="mr-1">
                  {u.method} {u.path}
                </Code>
              ))}
            </span>
          )
        }
      />
    </CheckList>
  )
}

/** What happened after the answer: what was chosen, and, once the call ends, how it went. */
function AnsweredBanner({
  item,
  answered,
  waiting,
}: {
  readonly item: ConfirmationItem
  readonly answered: Answered
  readonly waiting: number
}) {
  const approved = answered.by === 'me' && answered.approved
  // After an Allow, the call runs on: its outcome says whether the site did it.
  const trace = useLoad(
    (a) => (approved ? a.runs.trace(item.callId) : Promise.resolve(null)),
    [approved, item.callId],
    ['runs-changed'],
  )
  const outcome = trace.status === 'ready' ? (trace.data?.summary.outcome ?? null) : null
  const who = clientClaim(item.client)
  const ref = callRef(item.callId)
  const call = (
    <ObjectLink href={href.call(item.callId)} mono>
      {ref}
    </ObjectLink>
  )
  let banner: ReactNode
  if (answered.by === 'elsewhere') {
    banner = (
      <Banner tone="neutral" title={`Answered somewhere else at ${formatClock(answered.at)}.`}>
        It was answered from a notification, ended by Lock down, or the call was cancelled. Nothing more is
        needed here.
      </Banner>
    )
  } else if (!answered.approved) {
    banner = (
      <Banner tone="neutral" title="Nothing was done.">
        {who} was told you declined. See call {call}.
      </Banner>
    )
  } else if (outcome === 'failed' || outcome === 'blocked') {
    banner = (
      <Banner tone="danger" title="It didn’t work." live>
        {item.adapterName} answered with an error, so nothing changed. {who} was told:{' '}
        <Value>{`Failed · see call ${ref}. The person can see it in Valet, Activity, call ${ref}.`}</Value>{' '}
        Open call {call} to see what happened.
      </Banner>
    )
  } else if (outcome === 'ok') {
    banner = (
      <Banner tone="success" title="Done.">
        {who} has the result of call {call}.
      </Banner>
    )
  } else {
    banner = (
      <Banner tone="info" title="Valet is doing it now.">
        {who} gets the result of call {call}.
      </Banner>
    )
  }
  return (
    <Stack gap={2}>
      {banner}
      <Text size="sm" tone="muted">
        {waiting === 0 ? 'Nothing else is waiting for you.' : `${waiting} still waiting for you.`}
      </Text>
    </Stack>
  )
}
