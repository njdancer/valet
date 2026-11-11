import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * A data table for lists that compare across columns (audit log, calls). It sits in its own scroll
 * region with a sticky header; columns size to content and the first text column takes the rest.
 * Rows that open something use RowLink in their first cell, so the row is clickable but the link
 * is the one focus stop.
 */
export function Table({
  className,
  scroll = 'page',
  ...props
}: ComponentProps<'table'> & {
  /**
   * `page`: the table grows and the page scrolls, the header sticking to the top of the page's
   * scroll area. `self`: the table fills its container and scrolls on its own (a split view pane).
   */
  scroll?: 'page' | 'self'
}) {
  return (
    <div
      data-slot="table"
      className={cn(
        'min-w-0 rounded-lg bg-surface shadow-1 ring-[0.5px] ring-line ring-inset',
        // overflow-x: clip makes no scroll container, so the sticky header follows the page.
        scroll === 'page' ? 'overflow-x-clip' : 'h-full min-h-0 overflow-auto',
      )}
    >
      <table className={cn('w-full border-separate border-spacing-0 text-md', className)} {...props} />
    </div>
  )
}

export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('sticky top-0 z-[1] bg-surface', className)} {...props} />
}

/**
 * Up and Down move between rows (from one RowLink to the next), Home and End to the ends, so a long
 * table isn't a long Tab walk.
 */
export function TBody({ onKeyDown, ...props }: ComponentProps<'tbody'>) {
  return (
    <tbody
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
        const links = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row-link]')]
        const at = links.indexOf(document.activeElement as HTMLElement)
        if (at === -1) return
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? links.length - 1
              : e.key === 'ArrowDown'
                ? Math.min(links.length - 1, at + 1)
                : Math.max(0, at - 1)
        e.preventDefault()
        links[next]?.focus()
      }}
      {...props}
    />
  )
}

export function TR({
  className,
  interactive = false,
  selected = false,
  ...props
}: ComponentProps<'tr'> & { interactive?: boolean; selected?: boolean }) {
  return (
    <tr
      aria-current={selected || undefined}
      className={cn(
        'group [&+&>td]:border-t [&+&>td]:border-line-subtle',
        interactive && 'relative cursor-pointer hover:bg-hover',
        selected &&
          'bg-selected hover:bg-selected [&>td:first-child]:shadow-[inset_2px_0_0_var(--accent-solid)]',
        className,
      )}
      {...props}
    />
  )
}

export function TH({
  className,
  sort,
  onSort,
  align = 'left',
  children,
  ...props
}: ComponentProps<'th'> & { sort?: 'asc' | 'desc' | 'none'; onSort?: () => void; align?: 'left' | 'right' }) {
  const label = (
    <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
      {children}
      {sort === 'asc' ? <ArrowUp className="size-3" aria-hidden="true" /> : null}
      {sort === 'desc' ? <ArrowDown className="size-3" aria-hidden="true" /> : null}
      {sort === 'none' ? (
        <ChevronsUpDown className="size-3 opacity-0 group-hover/th:opacity-60" aria-hidden="true" />
      ) : null}
    </span>
  )
  return (
    <th
      scope="col"
      aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}
      className={cn(
        'group/th h-8 border-b border-line px-3 text-xs font-semibold whitespace-nowrap text-fg-muted',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className="-mx-1 inline-flex h-6 items-center rounded-xs px-1 hover:text-fg"
        >
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  )
}

export function TD({
  className,
  align = 'left',
  ...props
}: ComponentProps<'td'> & { align?: 'left' | 'right' }) {
  return (
    <td
      className={cn(
        'h-9 px-3 align-middle text-fg',
        align === 'right' ? 'text-right tabular' : 'text-left',
        className,
      )}
      {...props}
    />
  )
}

/** A link that makes its whole table row clickable (an ::after covers the row). */
export function RowLink({
  href,
  children,
  className,
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      data-row-link=""
      className={cn(
        'cursor-pointer font-medium text-fg no-underline outline-offset-[-2px] after:absolute after:inset-0 after:content-[""] focus-visible:after:rounded-xs focus-visible:after:outline-2 focus-visible:after:outline-line-focus focus-visible:outline-hidden',
        className,
      )}
    >
      {children}
    </a>
  )
}
