import { ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { DropdownMenu as MenuPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button, type ButtonProps, buttonVariants } from './button'
import { IconButton } from './icon-button'
import { DropdownMenuContent } from './menu'
import { Kbd } from './text'

/**
 * The window's title bar: back and forward, the page title, the search field that opens the command
 * palette, and the kill switches. It doubles as the drag region of a frameless window; its controls
 * opt out of dragging. On macOS leave `insetStart` for the traffic lights.
 */
export function TitleBar({
  title,
  onBack,
  onForward,
  canGoBack = true,
  canGoForward = true,
  onSearch,
  actions,
  insetStart = false,
  className,
}: {
  title?: ReactNode
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  /** Opens the command palette. */
  onSearch?: () => void
  actions?: ReactNode
  /** Leave room for macOS window buttons (traffic lights). */
  insetStart?: boolean
  className?: string
}) {
  return (
    <div
      data-slot="titlebar"
      className={cn(
        'flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle bg-canvas px-3 [-webkit-app-region:drag]',
        '[&_button]:[-webkit-app-region:no-drag] [&_a]:[-webkit-app-region:no-drag]',
        insetStart && 'pl-20',
        className,
      )}
    >
      {onBack || onForward ? (
        <div className="flex items-center">
          <IconButton
            size="sm"
            variant="quiet"
            label="Back"
            shortcut="⌘["
            icon={<ChevronLeft />}
            disabled={!canGoBack}
            onClick={onBack}
          />
          <IconButton
            size="sm"
            variant="quiet"
            label="Forward"
            shortcut="⌘]"
            icon={<ChevronRight />}
            disabled={!canGoForward}
            onClick={onForward}
          />
        </div>
      ) : null}
      {title ? <div className="min-w-0 truncate text-md font-semibold text-fg">{title}</div> : null}
      <div className="flex-1" />
      {onSearch ? (
        <button
          type="button"
          onClick={onSearch}
          className="flex h-7 w-56 cursor-pointer items-center gap-2 rounded-sm bg-inset px-2 text-md text-fg-subtle transition-interactive hover:bg-hover max-compact:w-7 max-compact:justify-center max-compact:px-0"
        >
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="flex-1 truncate text-left max-compact:sr-only">Search Valet</span>
          <span className="inline-flex gap-0.5 max-compact:hidden" aria-hidden="true">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      ) : null}
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** A row of controls over a list or pane (filter, sort, bulk actions). */
export function Toolbar({ className, label, ...props }: ComponentProps<'div'> & { label: string }) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn('flex min-w-0 items-center gap-2', className)}
      {...props}
    />
  )
}

/**
 * A button with a menu of related actions beside it: "Pause Valet | ▾ Lock down". The main part does
 * the common thing; the menu holds the stronger or rarer ones.
 */
export function SplitButton({
  children,
  onClick,
  menu,
  menuLabel,
  variant = 'secondary',
  size = 'md',
  leading,
  className,
}: {
  children: ReactNode
  onClick: () => void
  /** DropdownMenuItem elements. */
  menu: ReactNode
  /** Names the menu button ("More ways to pause"). */
  menuLabel: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  leading?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('inline-flex items-stretch', className)}>
      <Button variant={variant} size={size} leading={leading} onClick={onClick} className="rounded-r-none">
        {children}
      </Button>
      <MenuPrimitive.Root>
        <MenuPrimitive.Trigger
          aria-label={menuLabel}
          className={cn(
            buttonVariants({ variant, size }),
            'rounded-l-none border-l border-l-[color-mix(in_oklab,currentColor_18%,transparent)] px-1.5',
          )}
        >
          <ChevronDown aria-hidden="true" />
        </MenuPrimitive.Trigger>
        <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
      </MenuPrimitive.Root>
    </div>
  )
}
