import { cva, type VariantProps } from 'class-variance-authority'
import { Eye, KeyRound, OctagonAlert, PencilLine } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

export const badgeVariants = cva(
  'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-semibold [&_svg]:size-3',
  {
    variants: {
      tone: {
        neutral: 'bg-inset text-fg-muted',
        accent: 'bg-accent-soft text-accent-fg',
        success: 'bg-success-soft text-success-fg',
        warning: 'bg-warning-soft text-warning-fg',
        danger: 'bg-danger-soft text-danger-fg',
        info: 'bg-info-soft text-info-fg',
        brass: 'bg-brass-soft text-brass-fg',
        read: 'bg-risk-read-soft text-risk-read-fg',
        write: 'bg-risk-write-soft text-risk-write-fg',
        irreversible: 'bg-risk-irreversible-soft text-risk-irreversible-fg',
        secret: 'bg-risk-secret-soft text-risk-secret-fg',
      },
      variant: {
        soft: '',
        outline: 'bg-transparent ring-[0.5px] ring-current ring-inset',
      },
      size: { sm: 'h-4 px-1.5 text-2xs', md: '' },
    },
    defaultVariants: { tone: 'neutral', variant: 'soft', size: 'md' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

/**
 * A label for a state or a kind. A badge is never the only way to reach the thing it describes:
 * when it names an object, put it inside that object's link or row.
 */
export function Badge({ className, tone, variant, size, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone, variant, size }), className)} {...props} />
  )
}

export type Purpose = 'read' | 'write' | 'irreversible'

const purposeWords: Record<Purpose, string> = {
  read: 'Reads',
  write: 'Changes',
  irreversible: 'Can’t be undone',
}

/**
 * What a tool does to the outside world, in words, an icon and colour (never colour alone). Risk
 * badges are square-cornered and outlined, so they never read as a status pill (Running, Paused),
 * which is round and soft.
 */
export function RiskBadge({
  purpose,
  children,
  className,
  ...props
}: { purpose: Purpose; children?: ReactNode } & Omit<BadgeProps, 'tone'>) {
  return (
    <Badge
      tone={purpose}
      data-risk={purpose}
      className={cn('rounded-xs ring-1 ring-current/35 ring-inset', className)}
      {...props}
    >
      <RiskGlyph purpose={purpose} />
      {children ?? purposeWords[purpose]}
    </Badge>
  )
}

/** An icon per risk level, so the levels differ without colour: an eye, a pencil, a stop sign. */
export function RiskGlyph({ purpose, className }: { purpose: Purpose; className?: string }) {
  const Icon = purpose === 'read' ? Eye : purpose === 'write' ? PencilLine : OctagonAlert
  return <Icon aria-hidden="true" strokeWidth={2.25} className={cn('size-3', className)} />
}

/** A credential a tool or step uses. */
export function SecretBadge({ name, ...props }: { name: ReactNode } & Omit<BadgeProps, 'tone'>) {
  return (
    <Badge tone="secret" {...props}>
      <KeyRound aria-hidden="true" />
      {name}
    </Badge>
  )
}

export type DotTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'brass'

const dotTone: Record<DotTone, string> = {
  neutral: 'text-fg-subtle',
  success: 'text-success-solid',
  warning: 'text-warning-solid',
  danger: 'text-danger-solid',
  accent: 'text-accent-solid',
  brass: 'text-brass-solid',
}

/**
 * A status dot. It always comes with a text label (visible, or `label` for screen readers);
 * `pulse` marks something live or waiting on the person.
 */
export function StatusDot({
  tone = 'neutral',
  pulse = false,
  label,
  className,
}: {
  tone?: DotTone
  pulse?: boolean
  label?: string
  className?: string
}) {
  const cls = cn(
    'inline-block size-2 shrink-0 rounded-full bg-current',
    dotTone[tone],
    pulse && 'animate-pulse-ring',
    className,
  )
  return label ? (
    <span role="img" aria-label={label} className={cls} />
  ) : (
    <span aria-hidden="true" className={cls} />
  )
}

/** A count beside a nav item or tab. `attention` makes it the accent, for things waiting on the person. */
export function Count({
  value,
  attention = false,
  max = 99,
  label,
  className,
}: {
  value: number
  attention?: boolean
  max?: number
  /** What a screen reader hears instead of the bare number ("2 waiting for you"). */
  label?: string
  className?: string
}) {
  if (value <= 0) return null
  return (
    <>
      <span
        aria-hidden={label ? true : undefined}
        className={cn(
          'tabular inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold',
          attention ? 'bg-accent-solid text-fg-on-accent' : 'bg-inset text-fg-muted',
          className,
        )}
      >
        {value > max ? `${max}+` : value}
      </span>
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  )
}
