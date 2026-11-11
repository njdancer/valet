import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * A data table for lists that compare across columns (audit log, calls). It sits in its own scroll
 * region with a sticky header; columns size to content and the first text column takes the rest.
 * Rows that open something use RowLink in their first cell, so the row is clickable but the link
 * is the one focus stop.
 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="min-w-0 overflow-auto rounded-lg bg-surface shadow-1 ring-[0.5px] ring-line ring-inset">
      <table className={cn('w-full border-separate border-spacing-0 text-md', className)} {...props} />
    </div>
  )
}

export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('sticky top-0 z-[1] bg-surface', className)} {...props} />
}

export function TBody(props: ComponentProps<'tbody'>) {
  return <tbody {...props} />
}

export function TR({
  className,
  interactive = false,
  selected = false,
  ...props
}: ComponentProps<'tr'> & { interactive?: boolean; selected?: boolean }) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cn(
        'group [&+&>td]:border-t [&+&>td]:border-line-subtle',
        interactive && 'relative cursor-pointer hover:bg-hover',
        selected && 'bg-selected hover:bg-selected',
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
        <button type="button" onClick={onSort} className="-mx-1 cursor-pointer rounded-xs px-1 hover:text-fg">
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
      className={cn(
        'cursor-pointer font-medium text-fg no-underline outline-offset-[-2px] after:absolute after:inset-0 after:content-[""] focus-visible:after:rounded-xs focus-visible:after:outline-2 focus-visible:after:outline-line-focus focus-visible:outline-none',
        className,
      )}
    >
      {children}
    </a>
  )
}
