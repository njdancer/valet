import { Slot } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * Layout primitives. The rhythm (docs/design-system.md, Layout): 4 px grid; 6 between sections,
 * 3 inside a section, 2 inside a group, 1.5 between a label and its control. Use these gaps, not
 * margins, so nothing leaves a stray gap when an item is missing.
 */
export type Gap = 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 | 8 | 10

const gapClass: Record<Gap, string> = {
  0: 'gap-0',
  0.5: 'gap-0.5',
  1: 'gap-1',
  1.5: 'gap-1.5',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  5: 'gap-5',
  6: 'gap-6',
  8: 'gap-8',
  10: 'gap-10',
}

type FlexProps = ComponentProps<'div'> & {
  gap?: Gap
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline'
  justify?: 'start' | 'center' | 'end' | 'between'
  asChild?: boolean
}

const alignClass = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
  baseline: 'items-baseline',
}
const justifyClass = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
}

/** A vertical stack with a token gap. */
export function Stack({
  gap = 3,
  align = 'stretch',
  justify = 'start',
  asChild,
  className,
  ...props
}: FlexProps) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      className={cn(
        'flex min-w-0 flex-col',
        gapClass[gap],
        alignClass[align],
        justifyClass[justify],
        className,
      )}
      {...props}
    />
  )
}

/** A horizontal row that wraps, with a token gap. */
export function Inline({
  gap = 2,
  align = 'center',
  justify = 'start',
  wrap = true,
  asChild,
  className,
  ...props
}: FlexProps & { wrap?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      className={cn(
        'flex min-w-0',
        wrap && 'flex-wrap',
        gapClass[gap],
        alignClass[align],
        justifyClass[justify],
        className,
      )}
      {...props}
    />
  )
}

/** Fills the space between items in an Inline. */
export function Spacer() {
  return <span aria-hidden="true" className="flex-1" />
}

/**
 * A page in the main column: header on top, one scroll region, optional footer. The body is the
 * ONLY thing that scrolls, so the title and the page's actions are always in view and a primary
 * button can never fall below the window's edge.
 */
export function Page({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="page"
      className={cn('flex h-full min-h-0 min-w-0 flex-1 flex-col', className)}
      {...props}
    />
  )
}

export function PageHeader({
  title,
  description,
  leading,
  actions,
  breadcrumb,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  /** An avatar or icon before the title. */
  leading?: ReactNode
  /** The page's own actions, right-aligned. One primary at most. */
  actions?: ReactNode
  breadcrumb?: ReactNode
  /** Below the title row: tabs, a filter bar. */
  children?: ReactNode
  className?: string
}) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        'flex shrink-0 flex-col gap-3 border-b border-line-subtle bg-canvas px-6 pt-5 pb-0',
        !children && 'pb-4',
        className,
      )}
    >
      {breadcrumb}
      <div className="flex min-w-0 items-start gap-3">
        {leading ? <div className="shrink-0 pt-0.5">{leading}</div> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="m-0 truncate text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {description ? <p className="m-0 text-md text-fg-muted text-pretty">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  )
}

/** The page's scroll region. `width` caps reading width; tables use "full". */
export function PageBody({
  className,
  width = 'full',
  children,
  ...props
}: ComponentProps<'div'> & { width?: 'prose' | 'form' | 'full' }) {
  return (
    <div
      data-slot="page-body"
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
      {...props}
    >
      <div
        className={cn(
          'flex flex-col gap-6 px-6 py-5',
          width === 'prose' && 'max-w-[640px]',
          width === 'form' && 'max-w-[760px]',
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** A bar pinned to the bottom of a page or sheet for its actions: secondary left of primary. */
export function ActionBar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="action-bar"
      className={cn(
        'flex shrink-0 items-center justify-end gap-2 border-t border-line-subtle bg-canvas px-6 py-3',
        className,
      )}
      {...props}
    />
  )
}

/** A titled section of a page. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      id={id}
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      {title || actions ? (
        <div className="flex min-w-0 items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title ? (
              <h2 id={headingId} className="m-0 text-lg font-semibold tracking-snug text-fg">
                {title}
              </h2>
            ) : null}
            {description ? <p className="m-0 text-sm text-fg-muted text-pretty">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/**
 * A list beside its detail (Activity, Audit log): the list scrolls on its own, the detail on its own.
 * Below the compact breakpoint the detail takes the whole width and the list hides.
 */
export function SplitView({
  list,
  detail,
  listWidth = 320,
  showDetail = true,
  className,
}: {
  list: ReactNode
  detail: ReactNode
  listWidth?: number
  showDetail?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex min-h-0 flex-1', className)}>
      <div
        className={cn(
          'min-h-0 shrink-0 overflow-y-auto border-r border-line-subtle',
          showDetail && 'max-compact:hidden',
        )}
        style={{ width: listWidth }}
      >
        {list}
      </div>
      <div className={cn('min-h-0 min-w-0 flex-1 overflow-y-auto', !showDetail && 'max-compact:hidden')}>
        {detail}
      </div>
    </div>
  )
}
