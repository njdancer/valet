import { forwardRef, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { ariaShortcut } from '../lib/shortcut'
import { Button, type ButtonProps } from './button'
import { Tooltip } from './tooltip'

export type IconButtonProps = Omit<ButtonProps, 'children' | 'leading' | 'trailing' | 'aria-label'> & {
  /** Required: it is the button's accessible name and its tooltip. */
  label: string
  icon: ReactNode
  /** Written platform-neutral ("mod+K"); shown as ⌘K or Ctrl+K. */
  shortcut?: string
  /** Leave the tooltip off (when a visible label sits right next to it). */
  noTooltip?: boolean
}

/** A square icon-only button. It always has a name, and shows it as a tooltip on hover and focus. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, shortcut, noTooltip = false, variant = 'ghost', size = 'md', className, ...props },
  ref,
) {
  const button = (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      className={cn(size === 'sm' ? 'w-6 px-0' : size === 'lg' ? 'w-9 px-0' : 'w-7 px-0', className)}
      {...props}
    >
      {icon}
    </Button>
  )
  return noTooltip ? (
    button
  ) : (
    <Tooltip content={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  )
})
