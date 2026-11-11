import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { IconButton } from './icon-button'

export type BannerTone = 'info' | 'success' | 'warning' | 'danger' | 'attention'

const toneClass: Record<BannerTone, string> = {
  info: 'bg-info-soft text-info-fg ring-info-border',
  success: 'bg-success-soft text-success-fg ring-success-border',
  warning: 'bg-warning-soft text-warning-fg ring-warning-border',
  danger: 'bg-danger-soft text-danger-fg ring-danger-border',
  attention: 'bg-accent-soft text-accent-fg ring-info-border',
}

const toneIcon: Record<BannerTone, ReactNode> = {
  info: <Info />,
  success: <CircleCheck />,
  warning: <TriangleAlert />,
  danger: <CircleAlert />,
  attention: <Info />,
}

/**
 * A message about this page, at the top of its body: "Woolworths has an update waiting for review".
 * When the message is about something the person can act on, it carries that action (a Review
 * button), so the fix is one click from the problem.
 */
export function Banner({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
  icon,
  live = false,
  className,
}: {
  tone?: BannerTone
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  onDismiss?: () => void
  icon?: ReactNode
  /**
   * The banner arrived after the page loaded (a call just failed, an update just landed): it is
   * announced (danger interrupts, the rest wait) and rises in. A banner that is part of the page
   * from the start is neither, so it isn't read out on every visit.
   */
  live?: boolean
  className?: string
}) {
  return (
    <div
      role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}
      data-tone={tone}
      className={cn(
        live && 'animate-rise-in',
        'flex items-start gap-2.5 rounded-md px-3.5 py-2.5 ring-[0.5px] ring-inset [&>svg]:mt-px [&>svg]:size-4 [&>svg]:shrink-0',
        toneClass[tone],
        className,
      )}
    >
      {icon ?? toneIcon[tone]}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="m-0 text-md font-semibold">{title}</p>
        {children ? <div className="text-sm text-fg text-pretty">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 self-center">{action}</div> : null}
      {onDismiss ? (
        <IconButton
          label="Dismiss"
          icon={<X />}
          size="sm"
          variant="quiet"
          onClick={onDismiss}
          className="-mr-1"
        />
      ) : null}
    </div>
  )
}

/** An empty list or page: what would be here, why it isn't, and the action that fills it. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {icon ? (
        <div className="flex size-11 items-center justify-center rounded-xl bg-inset text-fg-muted [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="m-0 text-lg font-semibold text-fg">{title}</p>
        {children ? <div className="text-md text-fg-muted text-pretty">{children}</div> : null}
      </div>
      {action ? <div className="flex items-center gap-2 pt-1">{action}</div> : null}
    </div>
  )
}
