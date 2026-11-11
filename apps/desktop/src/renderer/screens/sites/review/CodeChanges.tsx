// The manifest's own diff, with line numbers, and the files the bundle changes. Every line is a value
// a reviewer may want to copy, so the diff is selectable.
//
// Gap: the IA puts a full code diff on its own page (#/sites/<id>/versions/<hash>/review/diff), but
// neither routes.ts nor the API carries file contents yet (PendingReview.files has counts only), so
// the files are listed here with their counts.

import { Badge, Code, cn, Table, TBody, TD, TR } from '@valet/ui'
import type { FileChange, ManifestDiffLine } from '../../../../shared/api'

const LINE_CLASS: Readonly<Record<ManifestDiffLine['kind'], string>> = {
  add: 'bg-diff-add-bg text-diff-add-fg',
  del: 'bg-diff-del-bg text-diff-del-fg',
  same: 'text-fg-muted',
  hunk: 'bg-inset text-fg-subtle',
}

const LINE_WORD: Readonly<Record<ManifestDiffLine['kind'], string>> = {
  add: 'Added',
  del: 'Removed',
  same: 'Unchanged',
  hunk: 'Section',
}

export function ManifestDiff({ lines }: { readonly lines: readonly ManifestDiffLine[] }) {
  return (
    <section
      aria-label="Manifest changes"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus (WCAG 2.1.1)
      tabIndex={0}
      className="max-h-96 overflow-auto rounded-md bg-code-bg ring-[0.5px] ring-line-subtle ring-inset"
    >
      <ol className="selectable m-0 min-w-max list-none p-0 py-1 font-mono text-sm leading-relaxed">
        {lines.map((line, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
            key={i}
            className={cn('grid grid-cols-[3.5ch_3.5ch_2ch_1fr] gap-x-2 px-3', LINE_CLASS[line.kind])}
          >
            <span aria-hidden="true" className="text-right text-fg-subtle select-none">
              {line.oldLine ?? ''}
            </span>
            <span aria-hidden="true" className="text-right text-fg-subtle select-none">
              {line.newLine ?? ''}
            </span>
            <span aria-hidden="true" className="select-none">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
            </span>
            <span className="whitespace-pre">
              <span className="sr-only">{LINE_WORD[line.kind]}: </span>
              {line.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function addedCount(lines: readonly ManifestDiffLine[]): number {
  return lines.filter((l) => l.kind === 'add').length
}

export function removedCount(lines: readonly ManifestDiffLine[]): number {
  return lines.filter((l) => l.kind === 'del').length
}

const STATUS: Readonly<
  Record<FileChange['status'], { label: string; tone: 'info' | 'neutral' | 'warning' }>
> = {
  added: { label: 'new', tone: 'info' },
  removed: { label: 'removed', tone: 'neutral' },
  modified: { label: 'changed', tone: 'warning' },
}

export function FileList({ files }: { readonly files: readonly FileChange[] }) {
  return (
    <Table aria-label="Files in this version">
      <TBody>
        {files.map((f) => (
          <TR key={f.path}>
            <TD className="w-full">
              <Code>{f.path}</Code>
            </TD>
            <TD>
              <Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge>
            </TD>
            <TD align="right" className="whitespace-nowrap font-mono text-sm">
              {f.added > 0 ? <span className="text-diff-add-fg">+{f.added}</span> : null}
              {f.added > 0 && f.removed > 0 ? ' ' : null}
              {f.removed > 0 ? <span className="text-diff-del-fg">−{f.removed}</span> : null}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}
