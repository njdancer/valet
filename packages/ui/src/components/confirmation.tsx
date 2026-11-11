import { ShieldAlert } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { DeadlineChip } from './attention'
import { Button } from './button'

export type ConfirmationState = 'arming' | 'ready' | 'expired' | 'answered'

/**
 * The confirmation window's content: an irreversible step a tool wants to take, answered on this
 * computer. It leads with one plain sentence; the site's own words sit apart under "From the site";
 * the buttons are verbs. Decline has focus first. While `arming`, Allow is disabled with its reason
 * (so a click meant for something else can't land on it); after the deadline it says Missed.
 */
export function ConfirmationPanel({
  site,
  sentence,
  fromSite,
  details,
  allowLabel,
  declineLabel = 'Decline',
  state,
  armingReason = 'Available in a moment',
  until,
  now,
  onAllow,
  onDecline,
  className,
}: {
  /** The site's avatar and name. */
  site: ReactNode
  /** "Valet will remove 2 items from your Woolworths trolley." */
  sentence: ReactNode
  /** The adapter's own description of the step, quoted and marked as the site's. */
  fromSite?: ReactNode
  details?: ReactNode
  /** The verb: "Remove from trolley", "Place order". */
  allowLabel: string
  declineLabel?: string
  state: ConfirmationState
  armingReason?: string
  until?: number
  now?: number
  onAllow: () => void
  onDecline: () => void
  className?: string
}) {
  const decline = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    decline.current?.focus()
  }, [])
  const expired = state === 'expired'
  return (
    <div className={cn('flex h-full flex-col bg-raised text-fg', className)}>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
        <div className="flex items-center gap-2">
          <ShieldAlert aria-hidden="true" className="size-4 text-danger-solid" />
          <span className="text-sm font-semibold text-danger-fg">Can't be undone</span>
          <span className="flex-1" />
          {until !== undefined ? <DeadlineChip until={until} now={now} /> : null}
        </div>
        <div className="flex items-start gap-3">
          {site}
          <h1 className="m-0 text-xl font-semibold tracking-snug text-balance">{sentence}</h1>
        </div>
        {fromSite ? (
          <figure className="m-0 flex flex-col gap-1 rounded-md bg-sunken p-3 ring-[0.5px] ring-line-subtle ring-inset">
            <figcaption className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
              From the site
            </figcaption>
            <blockquote className="selectable m-0 text-md text-fg-muted italic">{fromSite}</blockquote>
          </figure>
        ) : null}
        {details}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line-subtle px-5 py-3">
        {expired ? (
          <span className="mr-auto text-sm text-fg-muted">Missed. Nothing was done; Claude was told.</span>
        ) : null}
        <Button ref={decline} onClick={onDecline} disabled={expired || state === 'answered'}>
          {declineLabel}
        </Button>
        <Button
          variant="danger"
          onClick={onAllow}
          disabled={state !== 'ready'}
          disabledReason={
            state === 'arming' ? armingReason : expired ? 'The time to answer has passed' : undefined
          }
        >
          {allowLabel}
        </Button>
      </div>
    </div>
  )
}
