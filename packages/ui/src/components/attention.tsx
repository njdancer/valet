import { Clock } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { cn } from '../lib/cn'
import { type DotTone, StatusDot } from './badge'

function remaining(until: number, now: number): string {
  const s = Math.max(0, Math.round((until - now) / 1000))
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
  if (s >= 60) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim()
  return `${s} s`
}

/**
 * Time left to act ("Expires in 4 min 10 s"): a code to enter, a confirmation waiting. Turns to
 * warning under a minute. Updates every second, but announces only on the minute.
 */
export function DeadlineChip({
  until,
  prefix = 'Expires in',
  expired = 'Expired',
  className,
  now: nowProp,
}: {
  until: number
  prefix?: string
  expired?: string
  className?: string
  /** For tests and stories: freeze the clock. */
  now?: number
}) {
  const [now, setNow] = useState(() => nowProp ?? Date.now())
  useEffect(() => {
    if (nowProp !== undefined) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [nowProp])
  const t = nowProp ?? now
  const left = until - t
  const urgent = left < 60_000
  return (
    <span
      className={cn(
        'tabular inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-semibold [&_svg]:size-3',
        left <= 0
          ? 'bg-inset text-fg-muted'
          : urgent
            ? 'bg-warning-soft text-warning-fg'
            : 'bg-inset text-fg-muted',
        className,
      )}
    >
      <Clock aria-hidden="true" />
      {left <= 0 ? expired : `${prefix} ${remaining(until, t)}`}
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
  action?: ReactNode
  live?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2 text-md', className)}>
      <StatusDot tone={tone} pulse={live} />
      <span className="min-w-0 flex-1 truncate text-fg-muted">{children}</span>
      {action}
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
  className,
}: {
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
      className={cn(
        'relative m-0 flex min-w-0 animate-rise-in items-center gap-3 rounded-lg bg-surface py-3 pr-3 pl-4 shadow-1 ring-[0.5px] ring-line ring-inset',
        'before:absolute before:top-3 before:bottom-3 before:left-0 before:w-[3px] before:rounded-r-full',
        tone === 'accent' && 'before:bg-accent-solid',
        tone === 'warning' && 'before:bg-warning-solid',
        tone === 'danger' && 'before:bg-danger-solid',
        className,
      )}
    >
      {icon ? <span className="flex shrink-0">{icon}</span> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {href ? (
          <a
            href={href}
            className="cursor-pointer truncate text-md font-semibold text-fg no-underline hover:underline"
          >
            {title}
          </a>
        ) : (
          <span className="truncate text-md font-semibold text-fg">{title}</span>
        )}
        {description ? <span className="line-clamp-2 text-sm text-fg-muted">{description}</span> : null}
      </div>
      {meta ? <span className="flex shrink-0 items-center gap-1.5">{meta}</span> : null}
      <span className="flex shrink-0 items-center gap-2">{action}</span>
    </li>
  )
}
