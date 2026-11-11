import { Clock } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { cn } from '../lib/cn'
import { useRowNavigation } from '../lib/use-row-navigation'
import { type DotTone, StatusDot } from './badge'

function remaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
  if (s >= 120) return `${Math.ceil(s / 60)} min`
  if (s >= 60) return `1 min ${s % 60 ? `${s % 60} s` : ''}`.trim()
  return `${s} s`
}

/** "9:52 pm", as every other time in the app reads (the system locale would say "9:52 PM"). */
export function clockTime(at: number, locale = 'en-AU'): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: true }).format(at)
}

/** The announcement thresholds, in ms left: a screen reader hears these, not every second. */
const ANNOUNCE_AT = [120_000, 60_000, 30_000] as const

function announcementFor(left: number): string | null {
  if (left <= 0) return 'Time is up'
  for (const t of [...ANNOUNCE_AT].reverse()) if (left <= t) return `${remaining(t)} left`
  return null
}

/**
 * When something waiting must be answered by: a confirmation, a code, a login. The clock time is
 * always shown ("until 9:52 pm"); under 2 minutes the countdown comes first, under 30 s it turns
 * urgent, and at zero it reads Missed. A screen reader hears it only at 2 min, 1 min and 30 s.
 */
export function DeadlineChip({
  until,
  expired = 'Missed',
  className,
  now: nowProp,
  locale,
  subject,
  urgentAt = 30_000,
  size = 'md',
  format = 'countdown',
}: {
  until: number
  /** What the deadline is for ("Woolworths code"), so an announcement makes sense on its own. */
  subject?: string
  /** When it turns red, in ms left. 30 s by default; the login window uses 60 s. */
  urgentAt?: number
  /** `lg` in the confirmation and login windows. */
  size?: 'md' | 'lg'
  /**
   * `countdown`: the countdown and clock time. `clock`: just "until 9:52 pm" (for things that resume
   * or end at a time, where a ticking countdown would only distract).
   */
  format?: 'countdown' | 'clock'
  expired?: string
  className?: string
  /** Freeze the clock (tests, stories). */
  now?: number
  locale?: string
}) {
  const [now, setNow] = useState(() => nowProp ?? Date.now())
  useEffect(() => {
    if (nowProp !== undefined) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [nowProp])
  const t = nowProp ?? now
  const left = until - t
  const ended = left <= 0
  const soon = left < 120_000
  const urgent = left < urgentAt
  const clock = clockTime(until, locale)
  const shown =
    format === 'clock'
      ? ended
        ? `${expired} · ${clock}`
        : `until ${clock}`
      : ended
        ? `${expired} · ${clock}`
        : soon
          ? `${remaining(left)} · until ${clock}`
          : `until ${clock} · ${remaining(left)}`
  return (
    <span
      className={cn(
        'tabular inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap',
        size === 'lg' ? 'h-7 px-3 text-md [&_svg]:size-4' : 'h-5 px-2 text-xs [&_svg]:size-3',
        ended
          ? 'bg-inset text-fg-muted'
          : urgent
            ? 'bg-danger-soft text-danger-fg'
            : soon
              ? 'bg-warning-soft text-warning-fg'
              : 'bg-inset text-fg-muted',
        className,
      )}
    >
      <Clock aria-hidden="true" />
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{ended ? `${expired} at ${clock}` : `Open until ${clock}`}</span>
      <span className="sr-only" aria-live="polite">
        {format === 'clock'
          ? null
          : announcementFor(left) && subject
            ? `${subject}: ${announcementFor(left)}`
            : announcementFor(left)}
      </span>
    </span>
  )
}

/**
 * When something was last checked, with a way to check now: "checked 9:46 pm · Check Woolworths
 * now". While `pending` it says "checking…"; the result is announced by the caller's own status.
 */
export function CheckedAt({
  at,
  subject,
  onCheck,
  pending = false,
  locale,
  className,
}: {
  at: number
  /** What gets checked, for the button's name ("Woolworths"). */
  subject: string
  onCheck: () => void
  pending?: boolean
  locale?: string
  className?: string
}) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-1.5 text-sm text-fg-muted', className)}>
      <span aria-live="polite">{pending ? 'checking…' : `checked ${clockTime(at, locale)}`}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={onCheck}
        disabled={pending}
        aria-label={`Check ${subject} now`}
        className="rounded-xs font-medium text-fg-link underline decoration-current/30 underline-offset-2 hover:decoration-current disabled:opacity-50"
      >
        Check now
      </button>
    </span>
  )
}

/**
 * One line of health for a site or service ("Signed in · last call 2 min ago"), with the one action
 * that fixes it inline when it isn't healthy ("Signed out — Sign in").
 */
export function HealthLine({
  tone,
  children,
  action,
  live = false,
  className,
}: {
  tone: DotTone
  children: ReactNode
  /** The fix, inline. Several are fine ("Open 1Password", "Choose another item"). */
  action?: ReactNode
  live?: boolean
  className?: string
}) {
  return (
    // Wraps instead of truncating: a failure reason is the one line that must be read in full.
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-md', className)}>
      <StatusDot tone={tone} pulse={live} />
      <span className="min-w-[min(100%,12rem)] flex-1 break-words text-fg-muted">{children}</span>
      {action ? <span className="flex flex-wrap items-center gap-2">{action}</span> : null}
    </div>
  )
}

/**
 * An item waiting on the person (an update to review, a code to enter, a confirmation), with its
 * primary action right on the item. The inbox on the home page and the tray are lists of these.
 */
export function InboxItem({
  icon,
  title,
  description,
  meta,
  action,
  href,
  tone = 'accent',
  missed = false,
  appear = false,
  copyValue,
  className,
}: {
  /** What mod+C copies while the item has focus in an InboxList (the call's ref). */
  copyValue?: string
  /** It just arrived while the page was open: it rises in. Items present on load don't animate. */
  appear?: boolean
  /** The item ran out of time: it stays for 24 h, muted, with a follow-up action. */
  missed?: boolean
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
  /** The primary action (a Button). Required: an inbox item is always actionable. */
  action: ReactNode
  /** Opens the full context (the review page). */
  href?: string
  tone?: 'accent' | 'warning' | 'danger'
  className?: string
}) {
  return (
    <li
      data-row=""
      data-copy-value={copyValue}
      className={cn(
        'outline-offset-2',
        // Wraps to two rows in a narrow column (the tray, 880 px) so the action never squeezes the title.
        '@container relative m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface py-3 pr-3 pl-4 shadow-1 ring-[0.5px] ring-line ring-inset',
        'before:absolute before:top-3 before:bottom-3 before:left-0 before:w-[3px] before:rounded-r-full',
        tone === 'accent' && 'before:bg-accent-solid',
        tone === 'warning' && 'before:bg-warning-solid',
        tone === 'danger' && 'before:bg-danger-solid',
        missed && 'bg-canvas shadow-none before:bg-fg-subtle',
        appear && 'animate-rise-in',
        className,
      )}
    >
      {icon ? <span className="flex shrink-0">{icon}</span> : null}
      <div className="flex min-w-[min(100%,16rem)] flex-1 flex-col gap-0.5">
        {href ? (
          <a
            href={href}
            className="cursor-pointer line-clamp-2 text-md font-semibold break-words text-fg no-underline hover:underline"
          >
            {title}
            {missed ? (
              <span className="sr-only"> (missed)</span>
            ) : tone === 'danger' ? (
              <span className="sr-only"> (urgent)</span>
            ) : null}
          </a>
        ) : (
          <span className="line-clamp-2 text-md font-semibold break-words text-fg">
            {title}
            {missed ? (
              <span className="sr-only"> (missed)</span>
            ) : tone === 'danger' ? (
              <span className="sr-only"> (urgent)</span>
            ) : null}
          </span>
        )}
        {description ? <span className="line-clamp-2 text-sm text-fg-muted">{description}</span> : null}
      </div>
      {meta ? <span className="flex shrink-0 items-center gap-1.5">{meta}</span> : null}
      <span data-row-action="" className="ml-auto flex shrink-0 items-center gap-2">
        {action}
      </span>
    </li>
  )
}

/**
 * The list of Needs you items, with roving row focus: Up and Down between items, Return runs the
 * item's main action (its first button), Tab into its buttons, mod+C copies its `copyValue`, Delete
 * calls `onDismiss` (for missed items). `autoFocus` puts focus on the first item on open.
 */
export function InboxList({
  label,
  children,
  onDismiss,
  onCopy,
  autoFocus,
  className,
}: {
  label: string
  children: ReactNode
  onDismiss?: (index: number, row: HTMLElement) => void
  onCopy?: (value: string, index: number) => void
  autoFocus?: boolean
  className?: string
}) {
  const nav = useRowNavigation<HTMLUListElement>({ onDismiss, onCopy, autoFocus })
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: arrow keys move between the items
    <ul
      ref={nav.ref}
      aria-label={label}
      aria-keyshortcuts={nav['aria-keyshortcuts']}
      onKeyDown={nav.onKeyDown}
      onFocus={nav.onFocus}
      className={cn('m-0 flex list-none flex-col gap-3 p-0', className)}
    >
      {children}
    </ul>
  )
}

/** The IA's name for an inbox item: a thing in Needs you. */
export const NeedsYouItem = InboxItem
