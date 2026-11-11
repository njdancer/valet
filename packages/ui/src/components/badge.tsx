import { cva, type VariantProps } from 'class-variance-authority'
import { KeyRound } from 'lucide-react'
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

/** What a tool does to the outside world, in words and colour (never colour alone). */
export function RiskBadge({
  purpose,
  children,
  ...props
}: { purpose: Purpose; children?: ReactNode } & Omit<BadgeProps, 'tone'>) {
  return (
    <Badge tone={purpose} {...props}>
      <RiskGlyph purpose={purpose} />
      {children ?? purposeWords[purpose]}
    </Badge>
  )
}

/** A shape per risk level, so the levels differ without colour: circle, triangle, octagon. */
export function RiskGlyph({ purpose }: { purpose: Purpose }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="size-2.5 fill-current">
      {purpose === 'read' ? <circle cx="6" cy="6" r="4" /> : null}
      {purpose === 'write' ? <path d="M6 1.5 10.8 10H1.2Z" /> : null}
      {purpose === 'irreversible' ? <path d="M4 1h4l3 3v4l-3 3H4L1 8V4Z" /> : null}
    </svg>
  )
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
