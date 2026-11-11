import { Check } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { cn } from '../lib/cn'
import { DeadlineChip } from './attention'
import { type Purpose, RiskBadge } from './badge'
import { Button } from './button'

export type ConfirmationState = 'arming' | 'ready' | 'expired' | 'answered'

/**
 * The confirmation window's content: a step a tool wants to take that needs the person, answered on
 * this computer. It is named by Valet's own title ("Remove 2 items from your trolley?"), then one
 * plain sentence; the site's own words sit apart under "From the site". The buttons are verbs.
 *
 * - Decline has focus first, so Return and Escape both decline. Tab runs details, Decline, Allow.
 * - The header and Allow follow what the step does: a change that can be put back (`write`) gets
 *   a primary Allow; only an `irreversible` step says "Can't be undone" and gets a danger Allow.
 * - While `arming`, Allow is disabled and the reason is shown under the buttons, so a click meant
 *   for something else can't land on it. Under 30 s an urgent strip runs along the top.
 * - `answered` shows what happened, with the next waiting item and Close; `expired` (missed) says
 *   nothing was done and offers follow-ups.
 */
export function ConfirmationPanel({
  site,
  title,
  sentence,
  fromSite,
  details,
  purpose = 'irreversible',
  allowLabel,
  declineLabel = 'Decline',
  state,
  armingReason = 'Available in a moment',
  until,
  now,
  queue,
  result,
  next,
  missedActions,
  onAllow,
  onDecline,
  onClose,
  className,
}: {
  /** The site's avatar and name. */
  site: ReactNode
  /** Valet's title for the step, the window's heading and name: "Remove 2 items from your trolley?" */
  title?: ReactNode
  /** "Valet will remove 2 items from your Woolworths trolley." */
  sentence: ReactNode
  /** The adapter's own description of the step, quoted and marked as the site's. */
  fromSite?: ReactNode
  /** What Valet checked, and the request in full. Usually a Disclosure and a CheckList. */
  details?: ReactNode
  /** What the step does to the outside world. Sets the header and the Allow button. */
  purpose?: Exclude<Purpose, 'read'>
  /** The verb: "Remove from trolley", "Place order". */
  allowLabel: string
  declineLabel?: string
  state: ConfirmationState
  armingReason?: string
  until?: number
  now?: number
  /** Where this one sits among those waiting: { position: 1, total: 4 }. */
  queue?: { position: number; total: number }
  /** When answered: what happened ("Removed. Claude was told."). */
  result?: ReactNode
  /** When answered: a button to the next waiting item. */
  next?: ReactNode
  /** When missed: follow-ups ("Ask Claude to try again"). */
  missedActions?: ReactNode
  onAllow: () => void
  onDecline: () => void
  /** When answered or missed: closes the window. */
  onClose?: () => void
  className?: string
}) {
  const decline = useRef<HTMLButtonElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const reasonId = useId()
  const expired = state === 'expired'
  const answered = state === 'answered'
  const done = expired || answered
  useEffect(() => {
    if (done) close.current?.focus()
    else decline.current?.focus()
  }, [done])
  const urgent = !done && until !== undefined && until - (now ?? Date.now()) < 30_000
  return (
    <section
      aria-labelledby={headingId}
      data-purpose={purpose}
      data-state={state}
      className={cn('relative flex h-full flex-col bg-raised text-fg', className)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        if (done) onClose?.()
        else onDecline()
      }}
    >
      {urgent ? (
        <div
          aria-hidden="true"
          data-slot="urgent-strip"
          className="absolute inset-x-0 top-0 h-1 bg-danger-solid"
        />
      ) : null}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-2">
          {purpose === 'irreversible' ? (
            <RiskBadge purpose="irreversible" />
          ) : (
            <RiskBadge purpose="write">Changes your account</RiskBadge>
          )}
          {queue && queue.total > 1 ? (
            <span className="text-sm text-fg-muted">
              {queue.position} of {queue.total} waiting
            </span>
          ) : null}
          <span className="flex-1" />
          {until !== undefined && !answered ? (
            <DeadlineChip until={until} now={now} subject="This confirmation" />
          ) : null}
        </div>
        <div className="flex items-start gap-3">
          {site}
          <div className="flex min-w-0 flex-col gap-1">
            <h1 id={headingId} className="m-0 text-xl font-semibold tracking-snug text-balance">
              {title ?? sentence}
            </h1>
            {title ? <p className="m-0 text-md text-fg-muted text-pretty">{sentence}</p> : null}
          </div>
        </div>
        {fromSite ? (
          <figure className="m-0 flex flex-col gap-1 rounded-md bg-sunken p-3 ring-[0.5px] ring-line-subtle ring-inset">
            <figcaption className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
              From the site
            </figcaption>
            <blockquote className="selectable m-0 text-md text-fg-muted italic">{fromSite}</blockquote>
          </figure>
        ) : null}
        {answered && result ? (
          <p role="status" className="m-0 flex items-center gap-2 text-md font-medium text-success-fg">
            <Check aria-hidden="true" className="size-4 shrink-0" />
            {result}
          </p>
        ) : null}
        {details}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-line-subtle px-5 py-3">
        {done ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {expired ? (
              <span role="status" className="mr-auto text-sm text-fg-muted">
                Missed. Nothing was done; Claude was told.
              </span>
            ) : null}
            {expired ? missedActions : next}
            <Button ref={close} size="lg" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button ref={decline} size="lg" onClick={onDecline}>
                {declineLabel}
              </Button>
              <Button
                size="lg"
                variant={purpose === 'irreversible' ? 'danger' : 'primary'}
                onClick={onAllow}
                disabled={state !== 'ready'}
                disabledReason={state === 'arming' ? armingReason : undefined}
                aria-describedby={state === 'arming' ? reasonId : undefined}
              >
                {allowLabel}
              </Button>
            </div>
            {state === 'arming' ? (
              <p id={reasonId} className="m-0 text-right text-sm text-fg-muted">
                {armingReason}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
