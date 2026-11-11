import { type ComponentProps, createContext, type ReactNode, useContext, useId } from 'react'
import { cn } from '../lib/cn'
import { Count } from './badge'

/** NavItem renders an <li> only inside a SidebarGroup's list, so a footer link stays valid markup. */
const InList = createContext(false)

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
    <div
      data-slot="app-shell"
      className={cn('flex h-full min-h-0 w-full overflow-hidden bg-canvas text-fg', className)}
    >
      {sidebar}
      <Content className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">{children}</Content>
    </div>
  )
}

/**
 * The sidebar. Its top strip is the window's drag region and, in a frameless macOS window, leaves
 * room for the traffic lights. With `collapsible`, below 1000 px of window it narrows to icons (labels
 * stay for screen readers and show as tooltips).
 */
export function Sidebar({
  className,
  children,
  label = 'Sections',
  collapsible = false,
  ...props
}: ComponentProps<'nav'> & { label?: string; collapsible?: boolean }) {
  return (
    <nav
      aria-label={label}
      data-collapsible={collapsible || undefined}
      className={cn(
        'group/sidebar material-sidebar relative flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line-subtle px-2.5 pb-3',
        'pt-[calc(12px+var(--window-inset-top))]',
        collapsible && 'max-[1000px]:w-14 max-[1000px]:px-2',
        className,
      )}
      {...props}
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[calc(12px+var(--window-inset-top))] [-webkit-app-region:drag]"
      />
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
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-px', className)}>
      {label ? (
        <div
          id={id}
          className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-fg-subtle group-data-[collapsible]/sidebar:max-[1000px]:sr-only"
        >
          {label}
        </div>
      ) : null}
      <InList.Provider value={true}>
        <ul aria-labelledby={label ? id : undefined} className="m-0 flex list-none flex-col gap-px p-0">
          {children}
        </ul>
      </InList.Provider>
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
  const inList = useContext(InList)
  const Item = inList ? 'li' : 'div'
  return (
    <Item className="m-0">
      <a
        aria-current={active ? 'page' : undefined}
        title={typeof children === 'string' ? children : undefined}
        className={cn(
          'group relative flex h-7 w-full items-center gap-2 rounded-sm px-2 text-md text-fg no-underline transition-interactive',
          'group-data-[collapsible]/sidebar:max-[1000px]:justify-center',
          'hover:bg-hover active:bg-pressed',
          // Selection isn't colour alone: a short accent bar marks the current page.
          active &&
            'bg-selected font-medium hover:bg-selected before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent-solid',
          '[&_svg]:size-4 [&_svg]:shrink-0',
          className,
        )}
        {...props}
      >
        {icon ? <span className={cn('flex text-fg-muted', active && 'text-accent-fg')}>{icon}</span> : null}
        <span className="min-w-0 flex-1 truncate group-data-[collapsible]/sidebar:max-[1000px]:sr-only">
          {children}
        </span>
        <span className="contents group-data-[collapsible]/sidebar:max-[1000px]:hidden">{trailing}</span>
        {count !== undefined ? (
          <Count
            value={count}
            attention={attention}
            label={attention ? `, ${count} waiting for you` : `, ${count}`}
          />
        ) : null}
      </a>
    </Item>
  )
}
