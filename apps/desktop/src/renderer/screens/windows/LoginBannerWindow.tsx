// The login hand-off banner (#/needs-user/<adapterId>; wireframes 80-windows, login-handoff-*). The
// main process shows it in a window of Valet's own just above the site's login window. Trust
// signals live here, outside the page, because anything drawn inside the page the site could
// imitate: what Valet filled (by name only, never a value), where the window may go, and who asked.
//
// Focus starts on "I'm done". The site's page is another window, so the main process gives the login
// window a shortcut (mod+shift+B) that brings focus back here, as a 'focus-banner' event.

import {
  Banner,
  Button,
  Code,
  HandoffBanner,
  type HandoffState,
  ObjectLink,
  SecretBadge,
  Spinner,
  Text,
  Value,
} from '@valet/ui'
import { Globe, KeyRound, Lock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { NeedsUserItem } from '../../../shared/api'
import { useAction, useApi, useLoad, useNow } from '../../lib/api-context'
import { callRef, formatClock, hostOf } from '../../lib/format'
import { loginTitle } from '../../lib/needs-you'
import { linksOpenInValet } from '../../lib/open-in-valet'
import { href } from '../../lib/routes'
import { clientClaim, needsUserWording } from '../../lib/wording'
import { capText } from './InputPreview'

/** The shortcut the login window registers to bring focus back to this banner. */
export const RETURN_SHORTCUT = 'mod+shift+B'

/** Longest adapter note shown. */
const MAX_NOTE = 280

/** What happened to the hand-off from here. */
type Outcome = 'checking' | 'not-yet' | 'success' | null

export function LoginBannerWindow({ adapterId }: { readonly adapterId: string }) {
  const api = useApi()
  const attention = useLoad((a) => a.attention.list(), [], ['attention-changed'])
  const root = useRef<HTMLDivElement>(null)
  const last = useRef<NeedsUserItem | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const found =
    attention.status === 'ready'
      ? (attention.data.find(
          (i): i is NeedsUserItem => i.kind === 'needs-user' && i.adapterId === adapterId,
        ) ?? null)
      : null
  if (found !== null) last.current = found
  // Once "I'm done" worked the item is gone, but the banner still says so until the window closes.
  const item = found ?? (outcome === 'success' ? last.current : null)

  // The login window's shortcut brings focus back to the banner (newer main processes send this).
  useEffect(
    () =>
      api.onEvent((event) => {
        if ((event as { readonly type: string }).type !== 'focus-banner') return
        root.current?.querySelector<HTMLElement>('section[tabindex="-1"]')?.focus()
      }),
    [api],
  )

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates link clicks; links keep their own keys
    // biome-ignore lint/a11y/noStaticElementInteractions: as above
    <div ref={root} className="flex h-full flex-col bg-canvas" onClick={linksOpenInValet(api)}>
      {attention.status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : item === null ? (
        <section
          aria-label="Login hand-off"
          tabIndex={-1}
          className="flex flex-1 items-center gap-3 px-4 outline-hidden"
        >
          <Text weight="semibold">
            {attention.status === 'error'
              ? 'Valet couldn’t load the login hand-off.'
              : 'Nothing is waiting for you here.'}
          </Text>
          <Text tone="muted">
            {attention.status === 'error'
              ? 'It tries again when something changes.'
              : 'The login finished or was closed.'}
          </Text>
          <span className="flex-1" />
          <Button onClick={() => window.close()}>Close</Button>
        </section>
      ) : (
        <Handoff item={item} outcome={outcome} onOutcome={setOutcome} />
      )}
    </div>
  )
}

function Handoff({
  item,
  outcome,
  onOutcome,
}: {
  readonly item: NeedsUserItem
  readonly outcome: Outcome
  readonly onOutcome: (outcome: Outcome) => void
}) {
  const api = useApi()
  const now = useNow(1000)
  const action = useAction()
  // A window the person opened themselves: no automated attempt ran, so no reason to give.
  const byPerson = item.startedBy === 'person'
  const wording = needsUserWording(item.reason)
  const title = byPerson
    ? `Sign in to ${item.adapterName} in this window.`
    : loginTitle(item.adapterName, item.reason)
  const until = item.closesAt === null ? undefined : Date.parse(item.closesAt)
  const ended = until !== undefined && until <= now

  const finish = async () => {
    onOutcome('checking')
    const ok = await action.run(() => api.finishLogin(item.adapterId))
    // The main process checked the site: a hand-off it accepted leaves the list.
    const still = ok
      ? (await api.attention.list().catch(() => [])).some(
          (i) => i.kind === 'needs-user' && i.adapterId === item.adapterId,
        )
      : true
    onOutcome(still ? 'not-yet' : 'success')
  }
  const giveUp = () => {
    onOutcome(null)
    void action.run(() => api.closeLoginWindow(item.adapterId))
  }

  const state: HandoffState =
    outcome === 'success'
      ? 'success'
      : ended
        ? 'expired'
        : outcome === 'checking'
          ? 'checking'
          : outcome === 'not-yet'
            ? 'not-yet'
            : 'waiting'
  const message =
    state === 'waiting' ? (
      <>
        <strong className="font-semibold">{title}</strong>{' '}
        {byPerson ? 'You opened it from Valet; nothing was filled in for you.' : wording.detail}
      </>
    ) : state === 'not-yet' ? (
      <>
        <strong className="font-semibold">{item.adapterName} still shows its login page.</strong> Valet
        checked at {formatClock(now)}. Finish on the page below, then press Check again.
      </>
    ) : state === 'success' ? (
      <>
        <strong className="font-semibold">Logged in to {item.adapterName}.</strong> Valet checked at{' '}
        {formatClock(now)}; Claude’s next call goes through. You can close this window.
      </>
    ) : state === 'expired' ? (
      <>
        <strong className="font-semibold">The login window ran out at {formatClock(until ?? now)}.</strong>{' '}
        Nothing was saved. Claude finds out on its next call and can ask again.
      </>
    ) : undefined

  if (!item.windowOpen && outcome !== 'success') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <section
          aria-label="Login hand-off"
          tabIndex={-1}
          className="border-b border-line-subtle px-4 py-2.5 outline-hidden"
        >
          <Banner
            tone="warning"
            title={`The ${item.adapterName} login window is closed.`}
            action={
              <Button
                variant="primary"
                loading={action.busy}
                onClick={() => void action.run(() => api.openLoginWindow(item.adapterId))}
              >
                Show login window
              </Button>
            }
          >
            Open it again to finish logging in{until !== undefined ? ` before ${formatClock(until)}` : ''}.
          </Banner>
        </section>
        <Facts item={item} failed={action.failed} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HandoffBanner
        site={item.adapterName}
        state={state}
        message={message}
        until={until}
        now={now}
        returnShortcut={RETURN_SHORTCUT}
        onDone={() => void finish()}
        onCancel={giveUp}
        onClose={() => {
          if (state === 'expired') void action.run(() => api.closeLoginWindow(item.adapterId))
          window.close()
        }}
      />
      <Facts item={item} failed={action.failed && outcome !== 'not-yet'} />
    </div>
  )
}

/** Who asked, what Valet filled and where, and where the window may go: Valet's words, never the site's. */
function Facts({ item, failed }: { readonly item: NeedsUserItem; readonly failed: boolean }) {
  return (
    // A short window: the facts scroll, so the region takes focus for the keyboard (WCAG 2.1.1).
    <section
      aria-label="About this login"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus
      tabIndex={0}
      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-2 text-sm text-fg-muted outline-offset-[-2px]"
    >
      {failed ? (
        <p role="alert" className="m-0 font-medium text-danger-fg">
          Couldn’t reach the login window. Try again.
        </p>
      ) : null}
      <p className="m-0">
        {item.tool !== null ? (
          <>
            {item.client !== null ? `${clientClaim(item.client)} asked` : 'A call asked'} for{' '}
            <Code>{item.tool}</Code> at {formatClock(item.at)}
            {item.callId !== null ? (
              <>
                {' '}
                · call{' '}
                <ObjectLink href={href.call(item.callId)} mono>
                  {callRef(item.callId)}
                </ObjectLink>
              </>
            ) : null}
            .{' '}
          </>
        ) : null}
        Once you’re signed in, Valet carries on and the next call goes through.
      </p>
      {item.filled.length > 0 ? (
        <p className="m-0 flex flex-wrap items-center gap-1.5">
          <KeyRound aria-hidden="true" className="size-3.5 text-risk-secret-fg" />
          Valet filled in
          {item.filled.map((f) => (
            <SecretBadge key={`${f.secret}.${f.field}`} name={`${f.secret}.${f.field}`} />
          ))}
          {item.filledOrigin !== null ? (
            <>
              on <Value mono>{hostOf(item.filledOrigin)}</Value>
            </>
          ) : null}
          <span className="text-fg-subtle">
            · nothing is marked inside the page, where the site could fake it
          </span>
        </p>
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <Lock aria-hidden="true" className="size-3.5" />
          Private login session. No adapter code runs in this window.
        </span>
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Globe aria-hidden="true" className="size-3.5" />
          Can only visit
          {item.navigation.map((origin) => (
            <Value key={origin} mono>
              {hostOf(origin)}
            </Value>
          ))}
        </span>
      </p>
      {item.note !== null ? (
        <p className="m-0 text-fg-subtle">
          From the {item.adapterName} adapter, not checked by Valet:{' '}
          <span data-testid="manifest-note" className="selectable">
            “{capText(item.note, MAX_NOTE)}”
          </span>
        </p>
      ) : null}
    </section>
  )
}
