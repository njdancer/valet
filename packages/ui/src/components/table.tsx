import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { type RowNavigation, useRowNavigation } from '../lib/use-row-navigation'

/** Columns that drop out as the table narrows: 3 goes first (under 720 px), then 2 (under 560). */
export type ColumnPriority = 1 | 2 | 3
const priorityClass = (p?: ColumnPriority) =>
  p === 3 ? 'hidden @[720px]/table:table-cell' : p === 2 ? 'hidden @[560px]/table:table-cell' : undefined

/**
 * A data table for lists that compare across columns (audit log, calls). It sits in its own scroll
 * region with a sticky header; columns size to content and the first text column takes the rest.
 * Rows that open something use RowLink in their first cell, so the row is clickable but the link
 * is the one focus stop.
 */
export function Table({
  className,
  scroll = 'page',
  density = 'regular',
  bare = false,
  ...props
}: ComponentProps<'table'> & {
  /** `compact` for dense logs (Audit): 28 px rows, small text. */
  density?: 'regular' | 'compact'
  /** No surface, ring or radius, for a table inside a `Card flush`. */
  bare?: boolean
  /**
   * `page`: the table grows and the page scrolls, the header sticking to the top of the page's
   * scroll area. `self`: the table fills its container and scrolls on its own (a split view pane).
   */
  scroll?: 'page' | 'self'
}) {
  return (
    <div
      data-slot="table"
      data-density={density}
      className={cn(
        '@container/table min-w-0',
        !bare && 'rounded-lg bg-surface shadow-1 ring-[0.5px] ring-line ring-inset',
        // overflow-x: clip makes no scroll container, so the sticky header follows the page.
        scroll === 'page' ? 'overflow-x-clip' : 'h-full min-h-0 overflow-auto',
      )}
    >
      <table
        className={cn(
          'w-full border-separate border-spacing-0',
          density === 'compact' ? 'text-sm' : 'text-md',
          className,
        )}
        {...props}
      />
    </div>
  )
}

export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('sticky top-0 z-[1] bg-surface', className)} {...props} />
}

/**
 * Up and Down move between rows (from one RowLink to the next), Home and End to the ends, so a long
 * table isn't a long Tab walk. Return follows the row's link; mod+C copies a row's `copyValue`;
 * `onDismissRow` handles Delete. With `onActiveRowChange` the selection follows focus (a split
 * view's inspector shows the focused row).
 */
export function TBody({
  onKeyDown,
  onFocus,
  onActiveRowChange,
  onOpenRow,
  onCopyRow,
  onDismissRow,
  autoFocus,
  ...props
}: Omit<ComponentProps<'tbody'>, 'ref'> & {
  onActiveRowChange?: RowNavigation['onActiveChange']
  onOpenRow?: RowNavigation['onOpen']
  onCopyRow?: RowNavigation['onCopy']
  onDismissRow?: RowNavigation['onDismiss']
  autoFocus?: boolean
}) {
  const nav = useRowNavigation<HTMLTableSectionElement>({
    rowSelector: 'tr[data-row]',
    linkedOnly: true,
    onActiveChange: onActiveRowChange,
    onOpen: onOpenRow,
    onCopy: onCopyRow,
    onDismiss: onDismissRow,
    autoFocus,
  })
  return (
    <tbody
      ref={nav.ref}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        nav.onKeyDown(e)
      }}
      onFocus={(e) => {
        onFocus?.(e)
        nav.onFocus(e)
      }}
      {...props}
    />
  )
}

export function TR({
  className,
  interactive = false,
  selected = false,
  copyValue,
  focusable = false,
  ...props
}: ComponentProps<'tr'> & {
  interactive?: boolean
  selected?: boolean
  /** What mod+C copies while the row has focus (the call's ref). */
  copyValue?: string
  /** A row with no RowLink that still takes focus and Return (calls `onOpenRow`). */
  focusable?: boolean
}) {
  return (
    <tr
      data-row=""
      data-copy-value={copyValue}
      data-focusable={focusable || undefined}
      aria-current={selected || undefined}
      className={cn(
        'group [&+&>td]:border-t [&+&>td]:border-line-subtle',
        focusable && 'outline-offset-[-2px] focus-visible:bg-hover',
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
  priority,
  children,
  ...props
}: ComponentProps<'th'> & {
  sort?: 'asc' | 'desc' | 'none'
  onSort?: () => void
  align?: 'left' | 'right'
  /** Hide this column in a narrow table. Give the column's TDs the same priority. */
  priority?: ColumnPriority
}) {
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
        'group/th h-8 border-b border-line px-3 text-xs font-semibold whitespace-nowrap text-fg-muted in-data-[density=compact]:h-7 in-data-[density=compact]:px-2.5',
        align === 'right' ? 'text-right' : 'text-left',
        priorityClass(priority),
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
  priority,
  ...props
}: ComponentProps<'td'> & { align?: 'left' | 'right'; priority?: ColumnPriority }) {
  return (
    <td
      className={cn(
        // Links, buttons and switches in a cell sit above the row's RowLink overlay (index.css).
        'h-9 px-3 align-middle text-fg in-data-[density=compact]:h-7 in-data-[density=compact]:px-2.5',
        align === 'right' ? 'text-right tabular' : 'text-left',
        priorityClass(priority),
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
