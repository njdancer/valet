import { Progress as ProgressPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

/** Determinate progress. Pass value null for indeterminate (a sweeping bar). */
export function Progress({
  value,
  label,
  className,
  tone = 'accent',
}: {
  value: number | null
  label: string
  className?: string
  tone?: 'accent' | 'success' | 'warning'
}) {
  return (
    <ProgressPrimitive.Root
      aria-label={label}
      value={value}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-inset', className)}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full rounded-full transition-[width] duration-(--v-duration-slow) ease-standard',
          tone === 'accent' && 'bg-accent-solid',
          tone === 'success' && 'bg-success-solid',
          tone === 'warning' && 'bg-warning-solid',
          value === null &&
            'w-1/3 animate-shimmer bg-[length:300%_100%] [background-image:linear-gradient(90deg,transparent,var(--accent-solid),transparent)] bg-transparent',
        )}
        style={value === null ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </ProgressPrimitive.Root>
  )
}

/** A placeholder while something loads. Shimmers, except under reduced motion. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-shimmer rounded-sm bg-inset bg-[length:200%_100%]',
        '[background-image:linear-gradient(90deg,transparent_25%,color-mix(in_oklab,var(--fg-default)_6%,transparent)_50%,transparent_75%)]',
        className,
      )}
      {...props}
    />
  )
}
