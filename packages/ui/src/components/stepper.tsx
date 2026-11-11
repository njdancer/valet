import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export type StepState = 'done' | 'current' | 'upcoming' | 'skipped' | 'blocked'

/**
 * Progress through a multi-step flow (first-run setup). Done steps are links back, so a person can
 * revisit a choice; the current step is marked for screen readers with aria-current="step".
 */
export function Stepper({
  steps,
  orientation = 'vertical',
  className,
}: {
  steps: readonly { id: string; label: ReactNode; state: StepState; href?: string; hint?: ReactNode }[]
  orientation?: 'vertical' | 'horizontal'
  className?: string
}) {
  return (
    <ol
      className={cn(
        'm-0 flex list-none p-0',
        orientation === 'vertical' ? 'flex-col gap-1' : 'items-center gap-2',
        className,
      )}
    >
      {steps.map((step, i) => {
        const body = (
          <>
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold transition-interactive',
                step.state === 'done' && 'bg-accent-solid text-fg-on-accent',
                step.state === 'current' && 'bg-surface text-accent-fg ring-2 ring-accent-solid ring-inset',
                step.state === 'upcoming' && 'bg-inset text-fg-muted',
                step.state === 'skipped' && 'bg-inset text-fg-subtle',
                step.state === 'blocked' &&
                  'bg-warning-soft text-warning-fg ring-1 ring-warning-solid ring-inset',
              )}
            >
              {step.state === 'blocked' ? (
                '!'
              ) : step.state === 'done' ? (
                <Check className="size-3 animate-pop-in" strokeWidth={3} aria-hidden="true" />
              ) : (
                i + 1
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span
                className={cn(
                  'text-md break-words',
                  step.state === 'current' ? 'font-semibold text-fg' : 'text-fg-muted',
                )}
              >
                {step.label}
                {step.state === 'done' ? <span className="sr-only"> (done)</span> : null}
                {step.state === 'skipped' ? <span className="sr-only"> (skipped)</span> : null}
                {step.state === 'blocked' ? <span className="sr-only"> (waiting on you)</span> : null}
              </span>
              {step.hint && orientation === 'vertical' ? (
                <span
                  className={cn(
                    'text-sm break-words',
                    step.state === 'blocked' ? 'text-warning-fg' : 'text-fg-subtle',
                  )}
                >
                  {step.hint}
                </span>
              ) : null}
            </span>
          </>
        )
        const rowClass = 'flex min-w-0 items-center gap-2.5 rounded-sm px-2 py-1.5 no-underline'
        return (
          <li
            key={step.id}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className="flex min-w-0 items-center gap-2"
          >
            {step.href && step.state !== 'current' ? (
              <a href={step.href} className={cn(rowClass, 'cursor-pointer hover:bg-hover')}>
                {body}
              </a>
            ) : (
              <div className={rowClass}>{body}</div>
            )}
            {orientation === 'horizontal' && i < steps.length - 1 ? (
              <span aria-hidden="true" className="h-px w-6 bg-line" />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
