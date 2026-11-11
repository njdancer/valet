import { Tooltip as TooltipPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { formatShortcut } from '../lib/shortcut'

/** Wrap the app once. Tooltips open after 500 ms, then instantly while moving between them. */
export function TooltipProvider({
  delayDuration = 500,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={300} {...props} />
}

export const TooltipRoot = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  shortcut,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content> & { shortcut?: string }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip"
        sideOffset={sideOffset}
        className={cn(
          'z-[var(--v-z-tooltip)] max-w-72 rounded-sm px-2 py-1 text-sm text-fg material-floating',
          'origin-(--radix-tooltip-content-transform-origin) data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-fade-in data-[state=closed]:animate-fade-out',
          className,
        )}
        {...props}
      >
        <span className="inline-flex items-center gap-2">
          {children}
          {shortcut ? (
            <kbd className="font-sans text-xs text-fg-subtle">{formatShortcut(shortcut)}</kbd>
          ) : null}
        </span>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/** The short form: <Tooltip content="Copy">{trigger}</Tooltip>. */
export function Tooltip({
  content,
  children,
  side,
  shortcut,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  shortcut?: string
}) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} shortcut={shortcut}>
        {content}
      </TooltipContent>
    </TooltipRoot>
  )
}
