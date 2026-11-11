import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Kbd } from './text'

/**
 * The command palette (⌘K / Ctrl+K): jump to any page, adapter, call or setting, or run an action
 * ("Review Woolworths update", "Pause all tools"). It is the answer to "where is that screen?":
 * everything reachable in the app is reachable from here, by name.
 */
export function CommandPalette({
  open,
  onOpenChange,
  children,
  placeholder = 'Search Valet or run a command…',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  placeholder?: string
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--v-z-overlay)] bg-backdrop/40 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-glass="refract"
          className={cn(
            'material-floating fixed top-[14vh] left-1/2 z-[var(--v-z-modal)] w-[min(600px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-xl text-fg outline-none',
            'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <CommandPrimitive loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-line-subtle px-4">
              <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              <CommandPrimitive.Input
                placeholder={placeholder}
                className="h-12 flex-1 bg-transparent text-lg outline-none placeholder:text-fg-subtle"
              />
              <Kbd>Esc</Kbd>
            </div>
            <CommandPrimitive.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
              <CommandPrimitive.Empty className="px-3 py-8 text-center text-md text-fg-muted">
                Nothing matches. Try a site name, a tool or a page.
              </CommandPrimitive.Empty>
              {children}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-fg-subtle',
        className,
      )}
      {...props}
    />
  )
}

export function CommandItem({
  className,
  icon,
  shortcut,
  hint,
  children,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item> & {
  icon?: ReactNode
  shortcut?: ReactNode
  hint?: ReactNode
}) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'group flex h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-md outline-none',
        'data-[selected=true]:bg-selected-strong data-[selected=true]:text-fg-on-selected data-[disabled=true]:opacity-40',
        '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted data-[selected=true]:[&_svg]:text-fg-on-selected',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {hint ? (
        <span className="text-sm text-fg-subtle group-data-[selected=true]:text-fg-on-selected/80">
          {hint}
        </span>
      ) : null}
      {shortcut ? (
        <span className="text-sm text-fg-subtle group-data-[selected=true]:text-fg-on-selected/80">
          {shortcut}
        </span>
      ) : null}
    </CommandPrimitive.Item>
  )
}

export const CommandSeparator = ({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Separator>) => (
  <CommandPrimitive.Separator className={cn('mx-1 my-1 h-px bg-line-subtle', className)} {...props} />
)
