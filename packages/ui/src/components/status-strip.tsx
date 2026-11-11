import { Lock, Pause } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * A full-width strip under the title bar while the whole app is in a special state: paused, locked
 * down. It is the one place that says so on every page, with the way back.
 */
export function ShellStatus({
  state,
  children,
  action,
  className,
}: {
  state: 'paused' | 'locked'
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex h-9 shrink-0 animate-rise-in items-center gap-2 px-4 text-md font-medium [&>svg]:size-4',
        state === 'paused' && 'bg-warning-soft text-warning-fg',
        state === 'locked' && 'bg-danger-soft text-danger-fg',
        className,
      )}
    >
      {state === 'paused' ? <Pause aria-hidden="true" /> : <Lock aria-hidden="true" />}
      <span className="flex-1 truncate">{children}</span>
      {action}
    </div>
  )
}
