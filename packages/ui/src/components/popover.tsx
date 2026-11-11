import { Popover as PopoverPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export const PopoverClose = PopoverPrimitive.Close

/** A floating panel anchored to its trigger. Glass on macOS, frosted elsewhere. */
export function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  refract = false,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content> & { refract?: boolean }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        data-glass={refract ? 'refract' : undefined}
        className={cn(
          'material-floating z-[var(--v-z-popover)] w-72 rounded-lg p-3 text-fg outline-hidden',
          'origin-(--radix-popover-content-transform-origin) data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
