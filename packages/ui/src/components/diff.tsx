import { Minus, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../lib/cn'
import { CopyButton } from './copy-button'

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
          {line.note ? <span className="shrink-0 text-sm">{line.note}</span> : null}
        </li>
      ))}
    </ul>
  )
}

export type ChangeImpact = 'widens' | 'adds' | 'removes' | 'same'
export type Change = {
  impact: ChangeImpact
  content: ReactNode
  /** Overrides the impact's own badge ("Widens access", "New", "Removed", "Same"). */
  badge?: ReactNode
  note?: ReactNode
}
const impactBadge: Record<ChangeImpact, string> = {
  widens: 'Widens access',
  adds: 'New',
  removes: 'Removed',
  same: 'Same',
}

/**
 * The changes in an update or a restore, one row each, tinted by what they do to access: one that
 * widens it is amber, one that adds something is blue, a removal or no change is neutral. The badge
 * says it in words, so colour is never the only signal.
 */
export function ChangeList({
  changes,
  label,
  className,
}: {
  changes: readonly Change[]
  label: string
  className?: string
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        'm-0 flex list-none flex-col overflow-hidden rounded-md bg-surface p-0 ring-[0.5px] ring-line ring-inset',
        className,
      )}
    >
      {changes.map((c, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          key={i}
          data-impact={c.impact}
          className={cn(
            'relative flex flex-wrap items-start gap-x-3 gap-y-1 py-2 pr-3 pl-4 text-md',
            'before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r-full',
            c.impact === 'widens' && 'bg-warning-soft/60 before:bg-warning-solid',
            c.impact === 'adds' && 'bg-info-soft/60 before:bg-info-solid',
            c.impact === 'removes' && 'text-fg-muted before:bg-fg-subtle',
            c.impact === 'same' && 'text-fg-muted',
            i > 0 && 'border-t border-line-subtle',
          )}
        >
          <span
            className={cn(
              'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium',
              c.impact === 'widens' && 'bg-warning-soft text-warning-fg',
              c.impact === 'adds' && 'bg-info-soft text-info-fg',
              (c.impact === 'removes' || c.impact === 'same') && 'bg-inset text-fg-muted',
            )}
          >
            {c.badge ?? impactBadge[c.impact]}
          </span>
          <span
            className={cn(
              'selectable min-w-[min(100%,12rem)] flex-1 break-words',
              c.impact === 'removes' && 'line-through decoration-current/40',
            )}
          >
            {c.content}
          </span>
          {c.note ? <span className="shrink-0 text-sm text-fg-muted">{c.note}</span> : null}
        </li>
      ))}
    </ul>
  )
}

export type CodeLine = { kind: 'add' | 'del' | 'same'; text: string; old?: number; new?: number }
export type CodeHunk = { header: string; lines: readonly CodeLine[] }
export type CodeFile = { path: string; hunks: readonly CodeHunk[] }

const sign = { add: '+', del: '−', same: ' ' } as const
const said = { add: 'Added', del: 'Removed', same: 'Unchanged' } as const

/**
 * An adapter update's code, file by file: hunks with their headers, old and new line numbers,
 * monospace and selectable. Unified by default; `split` puts old and new side by side (wide pages
 * only). Each file has its own copy button, which copies the new version of the shown lines.
 */
export function CodeDiff({
  files,
  label = 'Code changes',
  mode = 'unified',
  className,
}: {
  files: readonly CodeFile[]
  label?: string
  mode?: 'unified' | 'split'
  className?: string
}) {
  const [at, setAt] = useState(0)
  const file = files[Math.min(at, files.length - 1)]
  if (!file) return null
  const newText = file.hunks
    .flatMap((h) => h.lines.filter((l) => l.kind !== 'del').map((l) => l.text))
    .join('\n')
  return (
    <section
      aria-label={label}
      className={cn(
        'flex min-w-0 overflow-hidden rounded-md bg-code-bg ring-[0.5px] ring-line-subtle ring-inset',
        className,
      )}
    >
      {files.length > 1 ? (
        <nav
          aria-label="Files"
          className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-line-subtle p-1.5"
        >
          {files.map((f, i) => (
            <button
              key={f.path}
              type="button"
              aria-current={i === at || undefined}
              onClick={() => setAt(i)}
              className={cn(
                'flex h-7 cursor-pointer items-center truncate rounded-xs px-2 text-left font-mono text-xs text-fg-muted transition-interactive hover:bg-hover',
                i === at && 'bg-selected text-fg',
              )}
              title={f.path}
            >
              {f.path.split('/').pop()}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line-subtle px-3 py-1.5">
          <span className="selectable min-w-0 flex-1 truncate font-mono text-xs text-fg">{file.path}</span>
          <CopyButton value={newText} label={`Copy ${file.path}`} />
        </div>
        <section
          aria-label={file.path}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus
          tabIndex={0}
          className="max-h-[32rem] overflow-auto outline-offset-[-2px]"
        >
          {file.hunks.map((h) => (
            <table
              key={h.header}
              className="selectable w-full border-collapse font-mono text-xs leading-5 text-code-fg"
            >
              <caption className="bg-inset px-3 py-0.5 text-left text-fg-subtle">{h.header}</caption>
              <tbody>
                {mode === 'unified'
                  ? h.lines.map((l, li) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: positional
                      <tr key={li} className={lineTone(l.kind)}>
                        <td className="w-10 pr-2 text-right text-fg-subtle select-none">{l.old ?? ''}</td>
                        <td className="w-10 pr-2 text-right text-fg-subtle select-none">{l.new ?? ''}</td>
                        <td className="w-4 select-none" aria-hidden="true">
                          {sign[l.kind]}
                        </td>
                        <td className="pr-3 whitespace-pre">
                          <span className="sr-only">{said[l.kind]}: </span>
                          {l.text}
                        </td>
                      </tr>
                    ))
                  : splitRows(h.lines).map(([o, n], li) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: positional
                      <tr key={li}>
                        <td
                          className={cn(
                            'w-10 pr-2 text-right text-fg-subtle select-none',
                            o && lineTone(o.kind),
                          )}
                        >
                          {o?.old ?? ''}
                        </td>
                        <td className={cn('w-1/2 pr-3 whitespace-pre', o && lineTone(o.kind))}>
                          {o ? <span className="sr-only">{said[o.kind]}: </span> : null}
                          {o?.text}
                        </td>
                        <td
                          className={cn(
                            'w-10 pr-2 text-right text-fg-subtle select-none',
                            n && lineTone(n.kind),
                          )}
                        >
                          {n?.new ?? ''}
                        </td>
                        <td className={cn('w-1/2 pr-3 whitespace-pre', n && lineTone(n.kind))}>
                          {n && n.kind !== 'same' ? <span className="sr-only">{said[n.kind]}: </span> : null}
                          {n?.text}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          ))}
        </section>
      </div>
    </section>
  )
}

const lineTone = (kind: CodeLine['kind']) =>
  kind === 'add' ? 'bg-diff-add-bg text-diff-add-fg' : kind === 'del' ? 'bg-diff-del-bg text-diff-del-fg' : ''

/** Pairs removed and added runs side by side; unchanged lines sit on both sides. */
function splitRows(lines: readonly CodeLine[]): [CodeLine | undefined, CodeLine | undefined][] {
  const rows: [CodeLine | undefined, CodeLine | undefined][] = []
  let dels: CodeLine[] = []
  let adds: CodeLine[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push([dels[i], adds[i]])
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (l.kind === 'del') dels.push(l)
    else if (l.kind === 'add') adds.push(l)
    else {
      flush()
      rows.push([l, l])
    }
  }
  flush()
  return rows
}
