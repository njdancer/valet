import { Ban, CircleAlert, CircleCheck, Hand, KeyRound, Loader, type LucideIcon, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { type DotTone, StatusDot } from './badge'

export type StepKind = 'ok' | 'blocked' | 'failed' | 'secret' | 'handoff' | 'running' | 'waiting'

const kindIcon: Record<StepKind, { icon: LucideIcon; className: string; word: string }> = {
  ok: { icon: CircleCheck, className: 'text-success-solid', word: 'Done' },
  blocked: { icon: Ban, className: 'text-warning-solid', word: 'Blocked' },
  failed: { icon: CircleAlert, className: 'text-danger-solid', word: 'Failed' },
  secret: { icon: KeyRound, className: 'text-risk-secret-fg', word: 'Filled a login' },
  handoff: { icon: Hand, className: 'text-accent-solid', word: 'Handed to you' },
  running: { icon: Loader, className: 'text-accent-solid animate-spin', word: 'Running' },
  waiting: { icon: Timer, className: 'text-fg-subtle', word: 'Waiting' },
}

export type TimelineItem = {
  id: string
  title: ReactNode
  time?: ReactNode
  detail?: ReactNode
  /** A step of a call: an icon by kind (said in words to a screen reader). */
  kind?: StepKind
  /** Or just a dot. */
  tone?: DotTone
  live?: boolean
}

/**
 * The steps of one call or login, in order, with times. With `onSelect`, each step is a button that
 * shows its detail in the inspector, and Up and Down move between steps.
 */
export function Timeline({
  items,
  selected,
  onSelect,
  label = 'Steps',
  className,
}: {
  items: readonly TimelineItem[]
  selected?: string
  onSelect?: (id: string) => void
  label?: string
  className?: string
}) {
  return (
    <ol
      aria-label={label}
      className={cn('m-0 flex list-none flex-col p-0', className)}
      onKeyDown={(e) => {
        if (!onSelect || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-step]')]
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (at === -1) return
        e.preventDefault()
        const next =
          buttons[e.key === 'ArrowDown' ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1)]
        next?.focus()
        if (next?.dataset['step']) onSelect(next.dataset['step'])
      }}
    >
      {items.map((item, i) => {
        const kind = item.kind ? kindIcon[item.kind] : null
        const marker = kind ? (
          <kind.icon aria-hidden="true" className={cn('size-4', kind.className)} />
        ) : (
          <StatusDot tone={item.tone ?? 'neutral'} pulse={item.live} />
        )
        const body = (
          <>
            <span className="relative z-[1] flex h-5 w-4 shrink-0 items-center justify-center bg-inherit">
              {marker}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-md text-fg">
                  {kind ? <span className="sr-only">{kind.word}: </span> : null}
                  {item.title}
                </span>
                {item.time ? (
                  <span className="tabular shrink-0 text-sm text-fg-subtle">{item.time}</span>
                ) : null}
              </span>
              {item.detail ? <span className="text-sm text-fg-muted">{item.detail}</span> : null}
            </span>
          </>
        )
        const isSelected = selected === item.id
        return (
          <li key={item.id} className="relative flex">
            {i < items.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute top-5 bottom-0 w-px bg-line',
                  onSelect ? 'left-[17.5px]' : 'left-[7.5px]',
                )}
              />
            ) : null}
            {onSelect ? (
              <button
                type="button"
                data-step={item.id}
                aria-current={isSelected ? 'step' : undefined}
                tabIndex={isSelected || (selected === undefined && i === 0) ? 0 : -1}
                onClick={() => onSelect(item.id)}
                className={cn(
                  'flex w-full cursor-pointer gap-3 rounded-sm px-2.5 py-1.5 outline-offset-[-2px] transition-interactive hover:bg-hover',
                  isSelected && 'bg-selected hover:bg-selected',
                )}
              >
                {body}
              </button>
            ) : (
              <div className="flex w-full gap-3 pb-3">{body}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
