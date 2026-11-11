import { ChevronRight } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

/** A grouped list on a surface, rows divided by hairlines (settings lists, adapters, clients). */
export function List({ className, label, ...props }: ComponentProps<'ul'> & { label?: string }) {
  return (
    <ul
      aria-label={label}
      className={cn(
        'm-0 flex list-none flex-col overflow-hidden rounded-lg bg-surface p-0 shadow-1 ring-[0.5px] ring-line ring-inset',
        '[&>li+li]:border-t [&>li+li]:border-line-subtle',
        className,
      )}
      {...props}
    />
  )
}

type RowContent = {
  leading?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Badges or a status, between the text and the trailing slot. */
  meta?: ReactNode
  /** Actions (buttons, a switch, a menu). When the row is a link, these must stop propagation. */
  trailing?: ReactNode
}

/**
 * One row. Three kinds:
 * - `href`: the row opens something (an adapter, a call). The whole row is the link, with a chevron.
 * - `onSelect`: the row does something in place. The whole row is a button.
 * - neither: a static row whose controls live in `trailing` (a setting with a switch).
 * Anything in a row that names another object is itself a link: a row is never a dead end.
 */
export function ListRow({
  leading,
  title,
  description,
  meta,
  trailing,
  href,
  onSelect,
  selected = false,
  className,
}: RowContent & { href?: string; onSelect?: () => void; selected?: boolean; className?: string }) {
  const body = (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="truncate text-md font-medium text-fg">{title}</span>
        {description ? <span className="line-clamp-2 text-sm text-fg-muted">{description}</span> : null}
      </span>
      {meta ? <span className="flex shrink-0 items-center gap-1.5">{meta}</span> : null}
    </>
  )
  const interactive = cn(
    'flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-2.5 text-inherit no-underline outline-offset-[-2px] transition-interactive',
    'hover:bg-hover active:bg-pressed',
    selected && 'bg-selected hover:bg-selected',
  )
  return (
    <li className={cn('m-0 flex min-w-0 items-center', className)}>
      {href !== undefined ? (
        <a href={href} aria-current={selected ? 'page' : undefined} className={interactive}>
          {body}
          {trailing ? null : <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />}
        </a>
      ) : onSelect !== undefined ? (
        <button type="button" onClick={onSelect} aria-pressed={selected || undefined} className={interactive}>
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5">{body}</div>
      )}
      {trailing ? <span className="flex shrink-0 items-center gap-1 pr-3">{trailing}</span> : null}
    </li>
  )
}

/** Key-value pairs (details of a call, an adapter's facts). Values are selectable. */
export function DescriptionList({
  items,
  className,
  columns = 1,
}: {
  items: readonly { term: ReactNode; value: ReactNode }[]
  className?: string
  columns?: 1 | 2
}) {
  return (
    <dl
      className={cn('m-0 grid gap-x-6 gap-y-2.5', columns === 2 ? 'grid-cols-2' : 'grid-cols-1', className)}
    >
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional
        <div key={i} className="grid min-w-0 grid-cols-[minmax(96px,34%)_1fr] items-baseline gap-3">
          <dt className="text-sm text-fg-muted">{item.term}</dt>
          <dd className="selectable m-0 min-w-0 text-md break-words text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
