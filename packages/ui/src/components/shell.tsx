import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Count } from './badge'

/** The control panel window: sidebar and main column. The window itself never scrolls. */
export function AppShell({
  sidebar,
  children,
  className,
  embedded = false,
}: {
  sidebar: ReactNode
  children: ReactNode
  className?: string
  /** Inside another page (the gallery): the content isn't a second <main> landmark. */
  embedded?: boolean
}) {
  const Content = embedded ? 'div' : 'main'
  return (
    <div className={cn('flex h-full min-h-0 w-full overflow-hidden bg-canvas text-fg', className)}>
      {sidebar}
      <Content className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</Content>
    </div>
  )
}

export function Sidebar({
  className,
  children,
  label = 'Sections',
  ...props
}: ComponentProps<'nav'> & { label?: string }) {
  return (
    <nav
      aria-label={label}
      className={cn(
        'material-sidebar flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line-subtle px-2.5 py-3',
        className,
      )}
      {...props}
    >
      {children}
    </nav>
  )
}

export function SidebarGroup({
  label,
  children,
  className,
}: {
  label?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-px', className)}>
      {label ? (
        <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{label}</div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-px p-0">{children}</ul>
    </div>
  )
}

export function SidebarFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('mt-auto flex flex-col gap-1 border-t border-line-subtle pt-3', className)}
      {...props}
    />
  )
}

/**
 * A sidebar link: a real <a>, so it opens with Enter, shows its address and works with the router.
 * `count` with `attention` is for things waiting on the person (accent); without, a quiet tally.
 */
export function NavItem({
  icon,
  active = false,
  count,
  attention = false,
  trailing,
  children,
  className,
  ...props
}: ComponentProps<'a'> & {
  icon?: ReactNode
  active?: boolean
  count?: number
  attention?: boolean
  trailing?: ReactNode
}) {
  return (
    <li className="m-0">
      <a
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-md text-fg no-underline transition-interactive',
          'hover:bg-hover active:bg-pressed',
          active && 'bg-selected font-medium hover:bg-selected',
          '[&_svg]:size-4 [&_svg]:shrink-0',
          className,
        )}
        {...props}
      >
        {icon ? <span className={cn('flex text-fg-muted', active && 'text-accent-fg')}>{icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {trailing}
        {count !== undefined ? (
          <Count
            value={count}
            attention={attention}
            label={attention ? `, ${count} waiting for you` : `, ${count}`}
          />
        ) : null}
      </a>
    </li>
  )
}
