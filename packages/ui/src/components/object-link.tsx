import { HoverCard as HoverCardPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { CopyButton } from './copy-button'

/**
 * A reference to another object in the app (a site, a call, a client, a credential, an audit entry),
 * wherever it's mentioned. It is always a link to that object, and on hover or focus shows a small
 * card with what it is, so a name in a sentence is never a dead end.
 *
 *   <ObjectLink href="#/adapters/woolworths" icon={<SiteAvatar … size="xs" />} card={…}>Woolworths</ObjectLink>
 */
export function ObjectLink({
  href,
  icon,
  card,
  children,
  className,
  mono = false,
}: {
  href: string
  icon?: ReactNode
  /** Content for the hover card. Leave it off for a plain object link. */
  card?: ReactNode
  children: ReactNode
  className?: string
  mono?: boolean
}) {
  const link = (
    <a
      href={href}
      className={cn(
        'inline-flex max-w-full cursor-pointer items-center gap-1 rounded-xs align-baseline font-medium text-fg no-underline',
        'decoration-current/30 underline-offset-2 hover:underline [&_svg]:size-3.5 [&_svg]:text-fg-muted',
        mono && 'font-mono text-[0.92em] font-regular',
        className,
      )}
    >
      {icon ? <span className="inline-flex shrink-0 self-center">{icon}</span> : null}
      <span className="truncate">{children}</span>
    </a>
  )
  if (!card) return link
  return (
    <HoverCardPrimitive.Root openDelay={450} closeDelay={120}>
      <HoverCardPrimitive.Trigger asChild>{link}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          sideOffset={6}
          className={cn(
            'material-floating z-[var(--v-z-popover)] w-72 rounded-lg p-3 text-md text-fg',
            'origin-(--radix-hover-card-content-transform-origin) data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
          )}
        >
          {card}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  )
}

/**
 * A hash or ID shown short ("a1b2c3d4…"), monospace and selectable, with the full value on hover
 * and a copy button. With `href` the short form links to where that hash is recorded.
 */
export function HashChip({
  value,
  href,
  short = 8,
  label = 'hash',
  className,
}: {
  value: string
  href?: string
  short?: number
  label?: string
  className?: string
}) {
  const shown = value.length > short + 1 ? `${value.slice(0, short)}…` : value
  const chip = cn(
    'inline-flex h-5 items-center rounded-xs bg-code-bg px-1.5 font-mono text-xs text-code-fg no-underline',
    href && 'cursor-pointer hover:bg-hover hover:underline',
  )
  return (
    <span className={cn('inline-flex items-center gap-0.5 align-middle', className)}>
      {href ? (
        <a href={href} title={value} className={chip} aria-label={`${label} ${value}`}>
          {shown}
        </a>
      ) : (
        <span title={value} className={cn(chip, 'selectable')}>
          {shown}
          <span className="sr-only">{value.slice(short)}</span>
        </span>
      )}
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  )
}

/** A filter bar over a list: search, segmented filters and active-filter chips, one row. */
export function FilterBar({ className, ...props }: ComponentProps<'search'>) {
  return (
    <search
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-2 border-b border-line-subtle px-6 py-2.5',
        className,
      )}
      {...props}
    />
  )
}
