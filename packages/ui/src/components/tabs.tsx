import { Tabs as TabsPrimitive } from 'radix-ui'
import { type ComponentProps, type ReactNode, useRef } from 'react'
import { cn } from '../lib/cn'
import { useIndicator } from '../lib/use-indicator'
import { Count } from './badge'

export const Tabs = TabsPrimitive.Root

/**
 * Page tabs, under a PageHeader. An accent underline slides to the selected tab. For tabs that are
 * addresses (each has a URL), use the router's links with NavTabs instead, so Back works.
 */
export function TabsList({ className, children, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  const ref = useRef<HTMLDivElement>(null)
  const bar = useIndicator(ref, '[data-state="active"]')
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('relative -mb-px flex items-end gap-4', className)}
      {...props}
    >
      {children}
      {bar ? (
        <span
          aria-hidden="true"
          data-travel=""
          className="absolute bottom-0 h-0.5 rounded-full bg-accent-solid transition-[left,width] duration-(--v-duration-slow) ease-spring"
          style={{ left: bar.left, width: bar.width }}
        />
      ) : null}
    </TabsPrimitive.List>
  )
}

export function TabsTrigger({
  className,
  children,
  count,
  attention,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger> & { count?: number; attention?: boolean }) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent text-md font-medium text-fg-muted transition-interactive',
        'hover:text-fg data-[state=active]:text-fg disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined ? (
        <Count
          value={count}
          attention={attention}
          label={attention ? `, ${count} waiting for you` : `, ${count}`}
        />
      ) : null}
    </TabsPrimitive.Trigger>
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('outline-hidden data-[state=active]:animate-fade-in', className)}
      {...props}
    />
  )
}

/** Tabs that are links (each tab is an address). */
export function NavTabs({
  items,
  label,
  className,
}: {
  items: readonly { href: string; label: ReactNode; active: boolean; count?: number; attention?: boolean }[]
  label: string
  className?: string
}) {
  return (
    <nav aria-label={label} className={cn('-mb-px flex items-end gap-4', className)}>
      {items.map((t) => (
        <a
          key={t.href}
          href={t.href}
          aria-current={t.active ? 'page' : undefined}
          className={cn(
            'inline-flex h-9 cursor-pointer items-center gap-1.5 border-b-2 text-md font-medium no-underline transition-interactive',
            t.active ? 'border-accent-solid text-fg' : 'border-transparent text-fg-muted hover:text-fg',
          )}
        >
          {t.label}
          {t.count !== undefined ? (
            <Count
              value={t.count}
              attention={t.attention}
              label={t.attention ? `, ${t.count} waiting for you` : `, ${t.count}`}
            />
          ) : null}
        </a>
      ))}
    </nav>
  )
}
