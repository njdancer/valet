import { cn } from '../lib/cn'

/**
 * A small bar chart of counts (calls per hour). Decorative beside a number that says the same; give
 * it a `label` when it stands alone.
 */
export function Sparkline({
  values,
  tone = 'accent',
  label,
  className,
}: {
  values: readonly number[]
  tone?: 'accent' | 'danger' | 'neutral'
  label?: string
  className?: string
}) {
  const max = Math.max(1, ...values)
  return (
    <div
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cn('flex h-6 items-end gap-px', className)}
    >
      {values.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          key={i}
          className={cn(
            'min-h-px flex-1 origin-bottom animate-rise-in rounded-t-[1px]',
            tone === 'accent' && 'bg-accent-solid/70',
            tone === 'danger' && 'bg-danger-solid/80',
            tone === 'neutral' && 'bg-fg-subtle/50',
          )}
          style={{ height: `${Math.round((v / max) * 100)}%`, animationDelay: `${i * 12}ms` }}
        />
      ))}
    </div>
  )
}
