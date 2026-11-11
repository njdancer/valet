import { CircleCheck, CircleMinus, CircleX, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Spinner } from './spinner'

export type CheckState = 'pass' | 'fail' | 'pending' | 'info' | 'skipped'

const words: Record<CheckState, string> = {
  pass: 'Passed',
  fail: 'Failed',
  pending: 'Checking',
  info: 'Note',
  skipped: 'Skipped',
}

/**
 * A list of checks and their outcomes: setup's "Valet checked" steps, the confirmation's "What
 * Valet checked", the live test run on a site. Each state has its own icon and a word for screen
 * readers, so pass and fail never differ by colour alone. With `live`, results are announced as
 * they land.
 */
export function CheckList({
  label,
  live = false,
  children,
  className,
}: {
  /** Names the list ("What Valet checked"). */
  label: string
  live?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <ul
      aria-label={label}
      aria-live={live ? 'polite' : undefined}
      className={cn('m-0 flex list-none flex-col gap-2 p-0', className)}
    >
      {children}
    </ul>
  )
}

export function CheckItem({
  state,
  title,
  detail,
  action,
  className,
}: {
  state: CheckState
  title: ReactNode
  /** What was found, or why it failed and how to fix it. */
  detail?: ReactNode
  /** The fix, for a failed check ("Open 1Password"). */
  action?: ReactNode
  className?: string
}) {
  return (
    <li data-state={state} className={cn('m-0 flex items-start gap-2.5', className)}>
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-4">
        {state === 'pass' ? <CircleCheck className="text-success-solid" /> : null}
        {state === 'fail' ? <CircleX className="text-danger-solid" /> : null}
        {state === 'pending' ? <Spinner size={14} /> : null}
        {state === 'info' ? <Info className="text-fg-muted" /> : null}
        {state === 'skipped' ? <CircleMinus className="text-fg-subtle" /> : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-px">
        <span className={cn('text-md text-fg break-words', state === 'skipped' && 'text-fg-muted')}>
          <span className="sr-only">{words[state]}: </span>
          {title}
        </span>
        {detail ? (
          <span className={cn('text-sm break-words', state === 'fail' ? 'text-danger-fg' : 'text-fg-muted')}>
            {detail}
          </span>
        ) : null}
        {action ? <div className="flex flex-wrap items-center gap-2 pt-1">{action}</div> : null}
      </div>
    </li>
  )
}
