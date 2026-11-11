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
  status,
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
  /**
   * The object's state beside the title, outside the h1 so the heading stays the name: a StatusDot
   * with words, a Badge ("Paused", "Update waiting").
   */
  status?: ReactNode
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
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        {leading ? <div className="shrink-0 pt-0.5">{leading}</div> : null}
        <div className="flex min-w-[min(100%,16rem)] flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="m-0 min-w-0 text-2xl break-words font-semibold tracking-tight text-fg">{title}</h1>
            {status ? <div className="flex shrink-0 items-center gap-1.5">{status}</div> : null}
          </div>
          {description ? <p className="m-0 text-md text-fg-muted text-pretty">{description}</p> : null}
        </div>
        {/* At 880 px the actions wrap under the title rather than squeezing it. */}
        {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
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
 * A list beside its detail (Activity, Audit log), with an optional inspector on the right (the
 * selected step of a call). Each pane scrolls on its own. The layout answers to its own width, not
 * the window's (container queries): under 760 px the inspector folds below the detail, and under
 * 880 px only the detail shows when something is selected (the list returns with Back).
 */
export function SplitView({
  list,
  detail,
  inspector,
  listWidth = 320,
  inspectorWidth = 300,
  showDetail = true,
  className,
}: {
  list: ReactNode
  detail: ReactNode
  inspector?: ReactNode
  listWidth?: number
  inspectorWidth?: number
  showDetail?: boolean
  className?: string
}) {
  return (
    <div className={cn('@container flex min-h-0 flex-1', className)}>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            'min-h-0 shrink-0 overflow-y-auto border-r border-line-subtle',
            showDetail && '@max-[880px]:hidden',
          )}
          style={{ width: listWidth }}
        >
          {list}
        </div>
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 @max-[760px]:flex-col',
            !showDetail && '@max-[880px]:hidden',
          )}
        >
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{detail}</div>
          {inspector ? (
            <aside
              aria-label="Inspector"
              className="min-h-0 shrink-0 overflow-y-auto border-l border-line-subtle bg-sunken/40 @max-[760px]:max-h-[45%] @max-[760px]:w-full! @max-[760px]:border-t @max-[760px]:border-l-0"
              style={{ width: inspectorWidth }}
            >
              {inspector}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  )
}
