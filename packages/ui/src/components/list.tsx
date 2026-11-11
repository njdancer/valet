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
        <span
          title={typeof title === 'string' ? title : undefined}
          className="line-clamp-2 text-md font-medium break-words text-fg"
        >
          {title}
        </span>
        {description ? <span className="line-clamp-2 text-sm text-fg-muted">{description}</span> : null}
      </span>
      {meta ? <span className="flex shrink-0 items-center gap-1.5">{meta}</span> : null}
    </>
  )
  const interactive =
    'flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-2.5 text-inherit no-underline outline-offset-[-2px] transition-interactive active:bg-pressed'
  const clickable = href !== undefined || onSelect !== undefined
  return (
    // The hover is on the whole row, trailing actions included, so the row reads as one thing.
    <li
      className={cn(
        'relative m-0 flex min-w-0 items-center transition-interactive',
        clickable && 'hover:bg-hover',
        selected &&
          'bg-selected hover:bg-selected before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent-solid',
        className,
      )}
    >
      {href !== undefined ? (
        <a href={href} aria-current={selected ? 'page' : undefined} className={interactive}>
          {body}
          {trailing ? null : <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />}
        </a>
      ) : onSelect !== undefined ? (
        <button type="button" onClick={onSelect} aria-current={selected || undefined} className={interactive}>
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
    // One grid for the whole list, so every value starts at the same x, set by the longest term.
    <dl
      className={cn(
        'm-0 grid items-baseline gap-x-4 gap-y-2.5',
        columns === 2
          ? 'grid-cols-[fit-content(40%)_minmax(0,1fr)_fit-content(40%)_minmax(0,1fr)] max-compact:grid-cols-[fit-content(40%)_minmax(0,1fr)]'
          : 'grid-cols-[fit-content(40%)_minmax(0,1fr)]',
        className,
      )}
    >
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional
        <div key={i} className="contents">
          <dt className="text-sm text-fg-muted">{item.term}</dt>
          <dd className="selectable m-0 min-w-0 text-md break-words text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
