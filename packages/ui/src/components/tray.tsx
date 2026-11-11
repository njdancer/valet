import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * The menu bar popover. Glass on macOS (with native vibrancy behind it, set by the main process),
 * frost elsewhere. Up and Down move between its rows; focus starts on the first Needs you row.
 */
export function TrayPanel({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the rows inside
    <div
      data-glass="refract"
      className={cn(
        'material-floating flex w-[360px] flex-col overflow-hidden rounded-xl text-fg',
        className,
      )}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tray-row]')]
        const at = rows.indexOf(document.activeElement as HTMLElement)
        if (at === -1) return
        e.preventDefault()
        rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)]?.focus()
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
  className,
}: {
  label: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-0.5 px-2 pb-2', className)}>
      <h2 className="m-0 px-2 pt-1.5 pb-1 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
        {label}
      </h2>
      {children}
    </section>
  )
}

/** A row in the popover: a link that opens its object in the window. */
export function TrayRow({
  href,
  leading,
  children,
  trailing,
  className,
}: {
  href: string
  leading?: ReactNode
  children: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      data-tray-row=""
      className={cn(
        'flex min-h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1 text-md text-fg no-underline outline-offset-[-2px] transition-interactive hover:bg-hover',
        className,
      )}
    >
      {leading ? <span className="flex shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing ? <span className="shrink-0 text-sm text-fg-subtle">{trailing}</span> : null}
    </a>
  )
}

export function TrayFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-1 border-t border-line-subtle px-2 py-1.5', className)}>
      {children}
    </div>
  )
}
