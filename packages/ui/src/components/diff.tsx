import { Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export type DiffLine = { kind: 'add' | 'del' | 'same'; text: ReactNode; note?: ReactNode }

/**
 * What changed, line by line (an adapter update's permissions, origins, tools). Added and removed
 * lines differ by sign and colour, and say so to a screen reader.
 */
export function Diff({
  lines,
  label,
  className,
}: {
  lines: readonly DiffLine[]
  label: string
  className?: string
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        'm-0 flex list-none flex-col overflow-hidden rounded-md p-0 ring-[0.5px] ring-line ring-inset',
        className,
      )}
    >
      {lines.map((line, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          key={i}
          className={cn(
            'flex items-start gap-2 px-3 py-1.5 text-md',
            line.kind === 'add' && 'bg-diff-add-bg text-diff-add-fg',
            line.kind === 'del' && 'bg-diff-del-bg text-diff-del-fg',
            line.kind === 'same' && 'bg-surface text-fg-muted',
            i > 0 && 'border-t border-line-subtle',
          )}
        >
          <span aria-hidden="true" className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
            {line.kind === 'add' ? <Plus className="size-3.5" strokeWidth={2.5} /> : null}
            {line.kind === 'del' ? <Minus className="size-3.5" strokeWidth={2.5} /> : null}
          </span>
          <span className="sr-only">
            {line.kind === 'add' ? 'Added: ' : line.kind === 'del' ? 'Removed: ' : 'Unchanged: '}
          </span>
          <span
            className={cn(
              'selectable min-w-0 flex-1 break-words',
              line.kind === 'del' && 'line-through decoration-current/40',
            )}
          >
            {line.text}
          </span>
          {line.note ? <span className="shrink-0 text-sm opacity-80">{line.note}</span> : null}
        </li>
      ))}
    </ul>
  )
}
