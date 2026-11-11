import { Check, ChevronRight } from 'lucide-react'
import { ContextMenu as ContextPrimitive, DropdownMenu as MenuPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { formatShortcut } from '../lib/shortcut'

// Dropdown and context menus share one look. Every row that names an object in the app should also
// be reachable from a context menu on that object (Open, Copy ID, Reveal in Audit log), so actions
// are where a person reaches for them.

const content = cn(
  'material-floating z-[var(--v-z-popover)] min-w-44 overflow-hidden rounded-lg p-1 text-fg outline-hidden',
  'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
)
const item = cn(
  'group relative flex h-7 items-center gap-2 rounded-xs px-2 text-md outline-hidden',
  'data-[highlighted]:bg-selected-strong data-[highlighted]:text-fg-on-selected',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
  '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted data-[highlighted]:[&_svg]:text-fg-on-selected',
)
const danger = 'text-danger-fg data-[highlighted]:bg-danger-solid [&_svg]:text-danger-fg'

function Shortcut({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto pl-4 text-sm tracking-wide text-fg-subtle group-data-[highlighted]:text-fg-on-selected/80">
      {typeof children === 'string' ? formatShortcut(children) : children}
    </span>
  )
}

export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuSub = MenuPrimitive.Sub
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(content, 'origin-(--radix-dropdown-menu-content-transform-origin)', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  icon,
  shortcut,
  destructive = false,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.Item> & {
  icon?: ReactNode
  shortcut?: ReactNode
  destructive?: boolean
}) {
  return (
    <MenuPrimitive.Item className={cn(item, destructive && danger, className)} {...props}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? <Shortcut>{shortcut}</Shortcut> : null}
    </MenuPrimitive.Item>
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(item, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check strokeWidth={2.5} />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(item, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <span className="block size-1.5 rounded-full bg-current" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn('px-2 pt-1.5 pb-1 text-xs font-semibold text-fg-subtle', className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('mx-1 my-1 h-px bg-line-subtle', className)} {...props} />
}

export function DropdownMenuSubTrigger({
  className,
  children,
  icon,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubTrigger> & { icon?: ReactNode }) {
  return (
    <MenuPrimitive.SubTrigger className={cn(item, 'data-[state=open]:bg-hover', className)} {...props}>
      {icon}
      <span className="flex-1">{children}</span>
      <ChevronRight className="ml-auto" />
    </MenuPrimitive.SubTrigger>
  )
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent className={cn(content, className)} {...props} />
    </MenuPrimitive.Portal>
  )
}

export const ContextMenu = ContextPrimitive.Root
export const ContextMenuTrigger = ContextPrimitive.Trigger

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof ContextPrimitive.Content>) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.Content
        className={cn(content, 'origin-(--radix-context-menu-content-transform-origin)', className)}
        {...props}
      />
    </ContextPrimitive.Portal>
  )
}

export function ContextMenuItem({
  className,
  icon,
  shortcut,
  destructive = false,
  children,
  ...props
}: ComponentProps<typeof ContextPrimitive.Item> & {
  icon?: ReactNode
  shortcut?: ReactNode
  destructive?: boolean
}) {
  return (
    <ContextPrimitive.Item className={cn(item, destructive && danger, className)} {...props}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? <Shortcut>{shortcut}</Shortcut> : null}
    </ContextPrimitive.Item>
  )
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof ContextPrimitive.Separator>) {
  return <ContextPrimitive.Separator className={cn('mx-1 my-1 h-px bg-line-subtle', className)} {...props} />
}
