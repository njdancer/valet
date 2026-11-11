// The menu bar popover (IA section 4, wireframes 70-menubar): what Valet is doing in one line with
// Pause beside it, then Needs you (the same titles and order as the window, three rows and a link
// to the rest), one row per site with its health line, today's numbers, and the app menu. Every
// row, number and site opens something; arrow keys move between rows and focus starts on the
// first waiting item. The panel is as tall as its content, so there is no empty band under it.

import {
  ariaShortcut,
  Badge,
  Banner,
  Button,
  Count,
  DeadlineChip,
  formatShortcut,
  SiteAvatar,
  StatusDot,
  TrayHeader,
  TrayPanel,
  TrayRow,
  TraySection,
  ValetMark,
} from '@valet/ui'
import {
  ArrowRightLeft,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  KeyRound,
  Lock,
  LogIn,
  Pause,
  Play,
  Power,
  RotateCw,
  ShieldCheck,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { AdapterSummary, AttentionItem, HashRoute } from '../../shared/api'
import { isLockedDown } from '../control/shell-state'
import { LockDownDialog, setLockedDown } from '../control/TitleArea'
import { useAction, useApi, useLoad, useNow } from '../lib/api-context'
import { formatClock, plural } from '../lib/format'
import { type NeedsYouView, needsYouOrder, needsYouView } from '../lib/needs-you'
import { linksOpenInValet, needsYouHref } from '../lib/open-in-valet'
import { href } from '../lib/routes'
import { healthFor, siteStatus } from '../lib/site-status'
import { clientClaim } from '../lib/wording'
import { stepsDone as doneOf, stepsLeft, useSetupFacts } from '../screens/setup/setup-logic'

/** Needs you rows shown in full; the rest are one link to the window. */
export const TRAY_NEEDS_YOU_ROWS = 3

export function TrayPopover() {
  const api = useApi()
  const now = useNow(1000)
  const app = useLoad((a) => a.app.status(), [], ['app-changed'])
  const endpoint = useLoad((a) => a.endpoint.status(), [], ['endpoint-changed'])
  const attention = useLoad((a) => a.attention.list(), [], ['attention-changed'])
  const adapters = useLoad((a) => a.adapters.list(), [], ['adapters-changed', 'approvals-changed'])
  const health = useLoad((a) => a.health.sites(), [], ['health-changed'])
  const stats = useLoad((a) => a.runs.statsToday(), [], ['runs-changed'])
  const runs = useLoad((a) => a.runs.list({ limit: 200 }), [], ['runs-changed'])
  const setup = useLoad((a) => a.setup.status(), [], ['settings-changed'])
  const facts = useSetupFacts()
  const action = useAction()
  const [opened, setOpened] = useState<boolean | null>(null)
  const [lockOpen, setLockOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  const status = app.status === 'ready' ? app.data : null
  const paused = status?.paused === true
  const lockedDown = status !== null && isLockedDown(status)
  const canLockDown = typeof (api.app as { setLockedDown?: unknown }).setLockedDown === 'function'
  const sites = adapters.status === 'ready' ? adapters.data : []
  const anyApproved = sites.some((a) => a.approval === 'approved')
  const firstInstall = (id: string) => sites.find((a) => a.id === id)?.approval !== 'approved'
  const items = attention.status === 'ready' ? attention.data : []
  const views = needsYouOrder(items.map((i) => needsYouView(i, firstInstall)))
  const waiting = views.filter((v) => !v.missed)
  const missed = views.filter((v) => v.missed)
  const setupOpen = setup.status === 'ready' && setup.data.completedAt === null
  const left = facts.status === 'ready' ? stepsLeft(doneOf(facts.data)) : null
  const finishSetup = setupOpen && left !== null && left > 0
  const shown = waiting.slice(0, finishSetup ? TRAY_NEEDS_YOU_ROWS - 1 : TRAY_NEEDS_YOU_ROWS)
  const more = waiting.slice(shown.length)
  const total = waiting.length + (finishSetup ? 1 : 0)
  const soonest = waiting.find((v) => v.deadline !== null)
  const ready = attention.status === 'ready' && app.status === 'ready'

  // Focus starts on the first waiting row, or on Resume while paused, each time the popover opens
  // (the window is hidden and shown again, so "opens" is the window taking focus).
  useEffect(() => {
    if (!ready) return
    const focusFirst = () => {
      const root = panel.current
      if (root === null) return
      const first =
        root.querySelector<HTMLElement>('[data-tray-focus]') ??
        root.querySelector<HTMLElement>('[data-needs-you] [data-tray-row]') ??
        root.querySelector<HTMLElement>('[data-tray-row]')
      first?.focus({ preventScroll: true })
    }
    focusFirst()
    window.addEventListener('focus', focusFirst)
    return () => window.removeEventListener('focus', focusFirst)
  }, [ready])

  const run = (what: () => Promise<unknown>) => {
    setOpened(null)
    void action.run(what)
  }

  // The menu's shortcuts, while the popover has focus: Open Valet, Pause or Resume.
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'o' && !event.shiftKey) {
        event.preventDefault()
        runRef.current(() => api.app.openControlPanel())
      } else if (key === 'p' && event.shiftKey && anyApproved && !lockedDown) {
        event.preventDefault()
        runRef.current(() => api.app.setPaused(!paused))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api, anyApproved, lockedDown, paused])

  let tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent' = 'success'
  let line = 'Ready'
  if (lockedDown) {
    tone = 'danger'
    line = 'Locked down · every call is refused'
  } else if (paused) {
    tone = 'warning'
    line = 'Paused · calls are refused'
  } else if (adapters.status === 'ready' && !anyApproved) {
    tone = 'neutral'
    line = 'Not set up yet · Claude can’t use any site'
  } else if (waiting.length > 0) {
    tone = 'warning'
    line = `${waiting.length} waiting${
      soonest?.deadline != null ? ` · next ends ${formatClock(soonest.deadline)}` : ''
    }`
  } else if (endpoint.status === 'ready' && !endpoint.data.listening) {
    tone = 'neutral'
    line = 'Endpoint off · apps can’t reach Valet'
  } else if (endpoint.status === 'ready') {
    const n = endpoint.data.connectedClients
    line = `Ready · ${n === 0 ? 'no apps' : plural(n, 'app')} connected`
  }

  const killSwitch = lockedDown ? (
    <Button
      size="sm"
      leading={<Lock />}
      data-tray-focus=""
      onClick={() => run(() => setLockedDown(api, false))}
    >
      Unlock
    </Button>
  ) : paused ? (
    <Button
      size="sm"
      variant="primary"
      leading={<Play />}
      data-tray-focus=""
      onClick={() => run(() => api.app.setPaused(false))}
    >
      Resume Valet
    </Button>
  ) : anyApproved ? (
    <Button size="sm" leading={<Pause />} onClick={() => run(() => api.app.setPaused(true))}>
      Pause Valet
    </Button>
  ) : null

  return (
    <div className="flex max-h-full justify-center">
      <TrayPanel
        ref={panel}
        role="dialog"
        aria-label="Valet"
        className="max-h-full"
        onClick={linksOpenInValet(api, (ok) => setOpened(ok))}
      >
        <TrayHeader className="gap-2.5 border-b border-line-subtle pb-3">
          <ValetMark size={28} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1.5 text-md font-semibold">
              Valet
              {status?.demo ? (
                <Badge tone="warning" size="sm" title="A local fake Woolworths and a test account">
                  Demo
                </Badge>
              ) : null}
            </span>
            <a
              href={href.needsYou()}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-xs text-sm text-fg-muted no-underline hover:text-fg"
            >
              <StatusDot tone={tone} />
              <span className="truncate">{line}</span>
              <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
            </a>
          </div>
          {killSwitch}
        </TrayHeader>

        <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain pt-1.5">
          {paused && !lockedDown ? (
            <Banner tone="warning" title="Valet is paused." className="mx-3 mb-2">
              Claude is told “Valet is paused, nothing was sent” and to ask you to resume.
            </Banner>
          ) : null}

          <div data-needs-you="">
            <TraySection
              label={
                <span className="flex items-center gap-1.5">
                  Needs you
                  <Count value={total} attention label={`${total} waiting`} />
                </span>
              }
            >
              {attention.status === 'error' ? (
                <p className="m-0 px-2 py-1 text-sm text-fg-muted">
                  Valet couldn’t load what’s waiting. Open Valet to see it.
                </p>
              ) : attention.status === 'loading' ? null : total === 0 ? (
                <NothingWaiting paused={paused || lockedDown} />
              ) : (
                <>
                  {finishSetup ? (
                    <NeedsYouRow
                      to={href.setup()}
                      icon={<RotateCw />}
                      title={`Finish setup (${plural(left ?? 0, 'step')} left)`}
                      description="About 5 minutes · Claude can use Woolworths once it’s done"
                      verb="Continue setup"
                    />
                  ) : null}
                  {shown.map((view) => (
                    <NeedsYouRow
                      key={view.id}
                      to={needsYouHref(view)}
                      icon={kindIcon(view.kind)}
                      title={view.title}
                      description={subLine(view, items)}
                      deadline={view.deadline}
                      now={now}
                      verb={view.actionLabel.replace(/…$/, '')}
                    />
                  ))}
                  {more.length > 0 ? (
                    <TrayRow
                      href={href.needsYou()}
                      className="text-sm"
                      trailing={<ChevronRight aria-hidden="true" className="size-3.5" />}
                    >
                      <span className="text-fg-muted">+{more.length} more:</span>{' '}
                      <span className="text-fg-link">
                        {more.length === 1 ? more[0]?.title : 'open Needs you in Valet'}
                      </span>
                    </TrayRow>
                  ) : null}
                </>
              )}
              {missed.length > 0 ? (
                <TrayRow href={href.needsYou()} className="text-sm text-fg-muted">
                  Missed ({missed.length}) · {missed[0]?.title}
                </TrayRow>
              ) : null}
            </TraySection>
          </div>

          {sites.length > 0 ? (
            <TraySection label="Sites">
              {sites.map((adapter) => (
                <SiteRow
                  key={adapter.id}
                  adapter={adapter}
                  line={
                    lockedDown
                      ? 'Stopped by Lock down'
                      : paused && adapter.approval === 'approved'
                        ? 'Paused with Valet'
                        : null
                  }
                  health={health.status === 'ready' ? healthFor(adapter, health.data) : null}
                />
              ))}
            </TraySection>
          ) : null}

          <TraySection label="Today">
            <Today
              calls={stats.status === 'ready' ? stats.data.toolCalls : null}
              blocked={stats.status === 'ready' ? stats.data.blockedRequests : null}
              failed={runs.status === 'ready' ? failedToday(runs.data, now) : null}
            />
          </TraySection>

          {anyApproved || lockedDown ? (
            <div className="flex flex-col gap-0.5 border-t border-line-subtle px-2 py-1.5">
              {!lockedDown ? (
                <MenuRow
                  icon={paused ? <Play /> : <Pause />}
                  shortcut="mod+shift+P"
                  hint={paused ? 'Calls go through again' : 'Refuses every call until you resume'}
                  onClick={() => run(() => api.app.setPaused(!paused))}
                >
                  {paused ? 'Resume Valet' : 'Pause Valet'}
                </MenuRow>
              ) : null}
              {canLockDown && !lockedDown ? (
                <MenuRow
                  icon={<Lock />}
                  shortcut="mod+alt+shift+L"
                  hint="If something looks wrong: stops calls and cuts off cloud agents"
                  onClick={() => setLockOpen(true)}
                >
                  Lock down…
                </MenuRow>
              ) : null}
              {lockedDown ? (
                <MenuRow icon={<Lock />} onClick={() => run(() => setLockedDown(api, false))}>
                  Unlock Valet
                </MenuRow>
              ) : null}
            </div>
          ) : null}

          {adapters.status === 'ready' && !anyApproved ? (
            <Banner tone="success" title="Valet never pays." className="mx-3 mb-2">
              Checkout is always you, on the site itself.
            </Banner>
          ) : null}
        </div>

        <div className="flex flex-col gap-0.5 border-t border-line-subtle px-2 py-1.5">
          {/* D-checkout: Valet never places the order; the person checks out on the site. */}
          {sites
            .filter((a) => a.cartUrl !== null)
            .map((a) => (
              <MenuRow
                key={a.id}
                icon={<ExternalLink />}
                onClick={() => run(() => api.adapters.openCart(a.id))}
              >
                Open my trolley on {a.site}…
              </MenuRow>
            ))}
          <MenuRow
            icon={<ValetMark size={14} />}
            shortcut="mod+O"
            onClick={() => run(() => api.app.openControlPanel())}
          >
            Open Valet
          </MenuRow>
          <MenuRow icon={<Power />} shortcut="mod+Q" onClick={() => run(() => api.app.quit())}>
            Quit Valet
          </MenuRow>
          {action.failed || opened === false ? (
            <p role="alert" className="m-0 px-2 py-1 text-sm font-medium text-danger-fg">
              Couldn’t do that. Try again.
            </p>
          ) : null}
        </div>
      </TrayPanel>
      {canLockDown ? (
        <LockDownDialog
          open={lockOpen}
          onOpenChange={setLockOpen}
          onConfirm={() => run(() => setLockedDown(api, true))}
        />
      ) : null}
    </div>
  )
}

function kindIcon(kind: AttentionItem['kind']): ReactNode {
  switch (kind) {
    case 'confirmation':
      return <CircleHelp />
    case 'needs-user':
      return <LogIn />
    case 'review':
      return <ShieldCheck />
    default:
      // Newer kinds (a connection to approve, a missing login) still get an icon.
      return (kind as string) === 'remote-consent' ? <ArrowRightLeft /> : <KeyRound />
  }
}

/** The second line of a waiting row: who asked, and when. Never adapter-supplied text. */
export function subLine(view: NeedsYouView, items: readonly AttentionItem[]): string | null {
  const item = items.find((i) => i.id === view.id)
  if (item === undefined) return view.description
  switch (item.kind) {
    case 'confirmation':
      return `Asked by ${clientClaim(item.client, 'inline')} at ${formatClock(item.requestedAt)}`
    case 'needs-user': {
      const where = item.windowOpen ? 'Login window is open' : 'Login window is closed'
      return item.client === null ? where : `${where} · for ${clientClaim(item.client, 'inline')}`
    }
    case 'review':
      return item.addsPermissions ? 'Asks for more · calls use the approved version' : 'Asks for nothing new'
    default:
      return view.description
  }
}

function NeedsYouRow({
  to,
  icon,
  title,
  description,
  deadline = null,
  now,
  verb,
}: {
  readonly to: HashRoute
  readonly icon: ReactNode
  readonly title: string
  readonly description: string | null
  readonly deadline?: number | null
  readonly now?: number
  readonly verb: string
}) {
  const urgent = deadline !== null && now !== undefined && deadline - now < 30_000
  return (
    <TrayRow
      href={to}
      className={urgent ? 'shadow-[inset_3px_0_0_var(--danger-solid)]' : undefined}
      leading={
        <span className="flex size-6 items-center justify-center rounded-sm bg-inset text-fg-muted [&_svg]:size-3.5">
          {icon}
        </span>
      }
      trailing={
        <span className="flex items-center gap-0.5 self-start pt-0.5 text-sm font-semibold text-fg-link">
          {verb}
          <ChevronRight aria-hidden="true" className="size-3" />
        </span>
      }
    >
      <span className="flex flex-col items-start gap-0.5 py-0.5 whitespace-normal">
        <span className="line-clamp-2 font-medium">{title}</span>
        {description ? <span className="line-clamp-2 text-sm text-fg-muted">{description}</span> : null}
        {deadline !== null ? <DeadlineChip until={deadline} now={now} subject={title} /> : null}
      </span>
    </TrayRow>
  )
}

function NothingWaiting({ paused }: { readonly paused: boolean }) {
  return (
    <div className="flex items-start gap-2 px-2 py-1">
      <StatusDot tone={paused ? 'neutral' : 'success'} className="mt-1.5" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-md font-medium">Nothing needs you</span>
        <span className="text-sm text-fg-muted">
          {paused
            ? 'New requests can’t arrive while Valet is stopped.'
            : 'You’ll get a notification and a count on this icon when something does.'}
        </span>
      </div>
      {paused ? null : (
        <Button size="sm" variant="ghost" asChild>
          <a href={href.settings('notifications')}>Notifications…</a>
        </Button>
      )}
    </div>
  )
}

function SiteRow({
  adapter,
  health,
  line,
}: {
  readonly adapter: AdapterSummary
  readonly health: Parameters<typeof siteStatus>[1]
  /** Overrides the health line while all of Valet is stopped. */
  readonly line: string | null
}) {
  const status = siteStatus(adapter, health)
  return (
    <TrayRow
      href={href.site(adapter.id)}
      leading={<SiteAvatar id={adapter.id} name={adapter.name} size="sm" />}
      trailing={<ChevronRight aria-hidden="true" className="size-3.5" />}
    >
      <span className="flex flex-col py-0.5">
        <span className="truncate font-medium">{adapter.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
          <StatusDot tone={line !== null ? 'neutral' : status.tone} />
          <span className="truncate">{line ?? status.text}</span>
        </span>
      </span>
    </TrayRow>
  )
}

/** Calls that failed since midnight, from the recent calls the main process keeps. */
export function failedToday(
  runs: readonly { readonly outcome: string; readonly startedAt: string }[],
  now: number,
): number {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return runs.filter((r) => r.outcome === 'failed' && Date.parse(r.startedAt) >= midnight.getTime()).length
}

function Today({
  calls,
  failed,
  blocked,
}: {
  readonly calls: number | null
  readonly failed: number | null
  readonly blocked: number | null
}) {
  if (calls === null) return <p className="m-0 px-2 py-1 text-sm text-fg-muted">Loading today’s calls…</p>
  if (calls === 0)
    return (
      <p className="m-0 px-2 py-1 text-sm text-fg-muted">
        No calls yet. When Claude uses a site, its calls show up here.
      </p>
    )
  const link = 'cursor-pointer rounded-xs text-fg-link no-underline hover:underline'
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 px-2 py-1 text-md">
      <a href={href.calls()} className={link}>
        {plural(calls, 'call')}
      </a>
      {failed !== null ? (
        <>
          <span aria-hidden="true" className="text-fg-subtle">
            ·
          </span>
          <a href={href.calls({ outcome: 'failed' })} className={link}>
            {failed} failed
          </a>
        </>
      ) : null}
      {blocked !== null ? (
        <>
          <span aria-hidden="true" className="text-fg-subtle">
            ·
          </span>
          <a href={href.audit({ category: 'blocked' })} className={link}>
            {plural(blocked, 'request')} blocked
          </a>
        </>
      ) : null}
    </p>
  )
}

/** A menu item in the popover: a button row the arrow keys reach, with its shortcut. */
function MenuRow({
  icon,
  shortcut,
  hint,
  onClick,
  children,
}: {
  readonly icon: ReactNode
  readonly shortcut?: string
  readonly hint?: string
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      data-tray-row=""
      onClick={onClick}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      className="flex min-h-7 w-full items-center gap-2.5 rounded-sm px-2 py-1 text-left text-md text-fg outline-offset-[-2px] transition-interactive hover:bg-hover [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg-muted"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {hint ? <span className="truncate text-sm text-fg-muted">{hint}</span> : null}
      </span>
      {shortcut ? (
        <span aria-hidden="true" className="shrink-0 text-sm text-fg-subtle">
          {formatShortcut(shortcut)}
        </span>
      ) : null}
    </button>
  )
}
