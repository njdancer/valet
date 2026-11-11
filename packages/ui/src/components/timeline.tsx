import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { type DotTone, StatusDot } from './badge'

/**
 * The steps of one call or login, in order, with times: "Queued 4 s · Logged in · Added 3 items".
 * The last running step pulses.
 */
export function Timeline({
  items,
  className,
}: {
  items: readonly {
    id: string
    title: ReactNode
    time?: ReactNode
    detail?: ReactNode
    tone?: DotTone
    live?: boolean
  }[]
  className?: string
}) {
  return (
    <ol className={cn('m-0 flex list-none flex-col p-0', className)}>
      {items.map((item, i) => (
        <li key={item.id} className="relative flex gap-3 pb-3 last:pb-0">
          {i < items.length - 1 ? (
            <span aria-hidden="true" className="absolute top-3.5 bottom-0 left-[3.5px] w-px bg-line" />
          ) : null}
          <span className="flex h-5 items-center">
            <StatusDot tone={item.tone ?? 'neutral'} pulse={item.live} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 text-md text-fg">{item.title}</span>
              {item.time ? (
                <span className="tabular shrink-0 text-sm text-fg-subtle">{item.time}</span>
              ) : null}
            </div>
            {item.detail ? <div className="text-sm text-fg-muted">{item.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  )
}
