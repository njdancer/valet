import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

/**
 * A grouped surface. Cards sit on the canvas; never nest a card in a card (use a Section or a
 * divider inside instead). With `interactive` the whole card is one target: pass a link as the
 * child with `asChild`.
 */
export function Card({
  className,
  interactive = false,
  flush = false,
  asChild = false,
  ...props
}: ComponentProps<'div'> & {
  interactive?: boolean
  /** No inner padding and clipped corners, for a table or list that fills the card. */
  flush?: boolean
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="card"
      className={cn(
        'flex flex-col rounded-lg bg-surface shadow-1 ring-[0.5px] ring-line ring-inset',
        flush && 'overflow-hidden',
        interactive &&
          'cursor-pointer transition-interactive hover:shadow-2 hover:ring-line-strong active:shadow-1 press text-inherit no-underline',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-start gap-3 px-4 pt-4 pb-2', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('m-0 text-md font-semibold text-fg', className)} {...props} />
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('m-0 text-sm text-fg-muted text-pretty', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  // The last block in a card gets the same bottom padding as a header's top, so cards never end tight.
  return <div className={cn('px-4 py-2 last:pb-4 first:pt-4', className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mt-auto flex items-center justify-end gap-2 border-t border-line-subtle px-4 py-3',
        className,
      )}
      {...props}
    />
  )
}
