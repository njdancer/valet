import { ChevronRight } from 'lucide-react'
import { type ComponentProps, type ReactNode, useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { ariaShortcut, formatShortcut } from '../lib/shortcut'
import { clockTime } from './attention'

/**
 * The menu bar popover. Glass on macOS (with native vibrancy behind it, set by the main process),
 * frost elsewhere. Up and Down move between its rows; focus starts on the first Needs you row.
 */
export function TrayPanel({
  className,
  children,
  autoFocus = false,
  ...props
}: ComponentProps<'div'> & {
  /** Focus the first Needs you row (an `urgent` or `attention` row) on open, else the first row. */
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!autoFocus || !ref.current) return
    const first =
      ref.current.querySelector<HTMLElement>('[data-tray-row][data-attention]') ??
      ref.current.querySelector<HTMLElement>('[data-tray-row]')
    first?.focus()
  }, [autoFocus])
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the rows inside
    <div
      ref={ref}
      data-glass="refract"
      className={cn(
        'material-floating flex w-[400px] max-w-full flex-col overflow-hidden rounded-xl text-fg',
        className,
      )}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tray-row]')]
        const at = rows.indexOf(document.activeElement as HTMLElement)
        if (at === -1) return
        e.preventDefault()
        const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)
        rows[next]?.focus()
        rows[next]?.scrollIntoView?.({ block: 'nearest' })
      }}
      {...props}
    >
      {children}
    </div>
  )
}

export function TrayHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex items-center gap-2 px-4 pt-3.5 pb-2', className)}>{children}</div>
}

export function TraySection({
  label,
  children,
  more,
  className,
}: {
  label: ReactNode
  children: ReactNode
  /** Rows left out to keep the popover short: a "+N more in Valet" link to the full list. */
  more?: { count: number; href: string }
  className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-0.5 px-2 pb-2', className)}>
      <h2 className="m-0 px-2 pt-1.5 pb-1 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
        {label}
      </h2>
      {children}
      {more && more.count > 0 ? (
        <a
          href={more.href}
          data-tray-row=""
          className="flex min-h-7 cursor-pointer items-center rounded-sm px-2 text-sm text-fg-link no-underline outline-offset-[-2px] transition-interactive hover:bg-hover"
        >
          +{more.count} more in Valet
        </a>
      ) : null}
    </section>
  )
}

/** The popover's scrolling middle, between header and footer, for when rows outgrow the height. */
export function TrayBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)} {...props} />
}

/**
 * A row in the popover: a link that opens its object in the window. One line by default; with a
 * `description` it is two (title, then the sentence), and it wraps at large text sizes. A row with a
 * `deadline` shows the clock time and its name says "until 9:46 pm"; `urgent` colours it. `verb`
 * names what Return does ("Answer"), and `place` adds a chevron for rows that go somewhere.
 */
export function TrayRow({
  href,
  leading,
  children,
  description,
  trailing,
  deadline,
  verb,
  urgent = false,
  attention,
  place = false,
  locale,
  className,
}: {
  href: string
  leading?: ReactNode
  children: ReactNode
  /** The second line: "Valet will remove 2 items from your Woolworths trolley." */
  description?: ReactNode
  trailing?: ReactNode
  /** When it runs out (ms since epoch). Shown as a clock time; announced as "until …". */
  deadline?: number
  /** The main action, shown on hover and focus and added to the name: "Answer". */
  verb?: string
  /** Under 30 s left, or otherwise pressing. */
  urgent?: boolean
  /** A Needs you row, where `autoFocus` starts. Defaults to true when there is a deadline or verb. */
  attention?: boolean
  /** Goes to a place in the window rather than an item: shows a chevron. */
  place?: boolean
  locale?: string
  className?: string
}) {
  const clock = deadline !== undefined ? clockTime(deadline, locale) : undefined
  const two = description !== undefined
  const needsYou = attention ?? (deadline !== undefined || verb !== undefined)
  return (
    <a
      href={href}
      data-tray-row=""
      data-attention={needsYou || undefined}
      data-urgent={urgent || undefined}
      className={cn(
        'group/row flex min-h-8 cursor-pointer gap-2.5 rounded-sm px-2 py-1 text-md text-fg no-underline outline-offset-[-2px] transition-interactive hover:bg-hover',
        two ? 'items-start py-1.5' : 'items-center',
        urgent && 'bg-danger-soft hover:bg-danger-soft',
        className,
      )}
    >
      {leading ? <span className={cn('flex shrink-0', two && 'pt-0.5')}>{leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('min-w-0', two ? 'font-medium break-words' : 'truncate')}>
          {children}
          {clock ? <span className="sr-only">, until {clock}</span> : null}
          {verb ? <span className="sr-only">. {verb}</span> : null}
        </span>
        {two ? <span className="text-sm text-fg-muted text-pretty break-words">{description}</span> : null}
      </span>
      {verb ? (
        <span
          aria-hidden="true"
          className="shrink-0 self-center text-sm font-medium text-accent-fg opacity-0 transition-interactive group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
        >
          {verb}
        </span>
      ) : null}
      {clock ? (
        <span
          aria-hidden="true"
          className={cn(
            'shrink-0 text-sm tabular',
            two && 'pt-0.5',
            urgent ? 'font-medium text-danger-fg' : 'text-fg-subtle',
          )}
        >
          {clock}
        </span>
      ) : null}
      {trailing ? (
        <span className={cn('shrink-0 text-sm text-fg-subtle', two && 'pt-0.5')}>{trailing}</span>
      ) : null}
      {place ? (
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 self-center text-fg-subtle" />
      ) : null}
    </a>
  )
}

/**
 * A command in the popover (Pause Valet, Lock down…, Open Valet, Quit). A button in the same
 * arrow-key loop as the rows, with its shortcut written the way this OS writes it.
 */
export function TrayMenuItem({
  icon,
  children,
  shortcut,
  destructive = false,
  onSelect,
  disabled,
  className,
}: {
  icon?: ReactNode
  children: ReactNode
  /** Platform-neutral: "mod+shift+P". */
  shortcut?: string
  destructive?: boolean
  onSelect: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      data-tray-row=""
      onClick={onSelect}
      disabled={disabled}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      className={cn(
        'flex min-h-7 w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1 text-left text-md text-fg outline-offset-[-2px] transition-interactive hover:bg-hover disabled:cursor-default disabled:opacity-40',
        '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted',
        destructive && 'text-danger-fg [&_svg]:text-danger-fg',
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {shortcut ? (
        <span aria-hidden="true" className="shrink-0 pl-4 text-sm tracking-wide text-fg-subtle">
          {formatShortcut(shortcut)}
        </span>
      ) : null}
    </button>
  )
}

export function TrayFooter({
  children,
  className,
  stacked = false,
}: {
  children: ReactNode
  className?: string
  /** A column of TrayMenuItems instead of a row of buttons. */
  stacked?: boolean
}) {
  return (
    <div
      className={cn(
        'flex gap-1 border-t border-line-subtle px-2 py-1.5',
        stacked ? 'flex-col' : 'items-center',
        className,
      )}
    >
      {children}
    </div>
  )
}
