import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import { type ComponentProps, forwardRef, type MouseEvent, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Spinner } from './spinner'
import { Tooltip } from './tooltip'

export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium',
    'transition-interactive press select-none outline-offset-2',
    'disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-accent-solid text-fg-on-accent shadow-1 hover:bg-accent-solid-hover [box-shadow:inset_0_1px_0_oklch(1_0_0/0.18),var(--elevation-1)]',
        secondary:
          'bg-raised text-fg shadow-1 ring-[0.5px] ring-line-control ring-inset hover:bg-[color-mix(in_oklab,var(--bg-raised),var(--fg-default)_4%)]',
        ghost: 'text-fg hover:bg-hover active:bg-pressed',
        quiet: 'text-fg-muted hover:bg-hover hover:text-fg active:bg-pressed',
        danger:
          'bg-danger-solid text-fg-on-accent shadow-1 hover:bg-danger-solid-hover [box-shadow:inset_0_1px_0_oklch(1_0_0/0.16),var(--elevation-1)]',
        'danger-soft':
          'bg-danger-soft text-danger-fg hover:bg-[color-mix(in_oklab,var(--danger-soft),var(--danger-solid)_10%)]',
        link: 'h-auto px-0 text-fg-link underline-offset-2 hover:underline',
      },
      size: {
        sm: 'h-6 px-2 text-sm [&_svg]:size-3.5',
        md: 'h-7 px-3 text-md [&_svg]:size-4',
        lg: 'h-9 px-4 text-lg [&_svg]:size-4',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (a link, say) with button styling instead of a <button>. */
    asChild?: boolean
    /** Shows a spinner and blocks clicks while keeping the button's width and its focus. */
    loading?: boolean
    leading?: ReactNode
    trailing?: ReactNode
    /**
     * Why the button can't be used yet ("Available in 3 s", "Choose a store first"). With `disabled`,
     * the button stays focusable, shows this as a tooltip and reads it as its description, instead
     * of vanishing from the tab order unexplained.
     */
    disabledReason?: string
  }

/**
 * The one button. Primary is for the single action a screen exists for; secondary for everything
 * else; ghost and quiet in toolbars and rows; danger only for the irreversible.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    asChild = false,
    loading = false,
    leading,
    trailing,
    children,
    disabled,
    disabledReason,
    onClick,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button'
  const explained = Boolean(disabled && disabledReason)
  const softDisabled = asChild || explained
  const blocked = loading || (softDisabled && disabled)
  const button = (
    <Comp
      ref={ref}
      data-slot="button"
      type={asChild ? undefined : (props.type ?? 'button')}
      className={cn(
        buttonVariants({ variant, size }),
        explained && 'aria-disabled:pointer-events-auto aria-disabled:cursor-not-allowed',
        className,
      )}
      disabled={softDisabled ? undefined : disabled}
      aria-disabled={softDisabled && disabled ? true : undefined}
      aria-description={explained ? disabledReason : undefined}
      aria-busy={loading || undefined}
      onClick={blocked ? (e: MouseEvent<HTMLButtonElement>) => e.preventDefault() : onClick}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Spinner className="absolute" /> : null}
          <span className={cn('inline-flex items-center gap-[inherit]', loading && 'opacity-0')}>
            {leading}
            {children}
            {trailing}
          </span>
        </>
      )}
    </Comp>
  )
  return explained ? <Tooltip content={disabledReason}>{button}</Tooltip> : button
})
