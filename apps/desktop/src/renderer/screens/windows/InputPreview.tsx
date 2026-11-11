// A tool input as the main process redacted it: every secret and session value is already a marker,
// and this only draws the markers. Everything is React text, so an input can't inject markup.

import { Badge, cn } from '@valet/ui'
import type { PreviewPart } from '../../../shared/api'

const LABELS: Readonly<Record<Extract<PreviewPart, { kind: 'redacted' }>['label'], string>> = {
  secret: 'secret',
  'session-cookie': 'session cookie',
  'session-storage': 'session storage',
}

export function redactionLabel(part: Extract<PreviewPart, { kind: 'redacted' }>): string {
  const base = Object.hasOwn(LABELS, part.label) ? LABELS[part.label] : 'redacted'
  return part.ref === null ? base : `${base}: ${part.ref}`
}

export function InputPreview({
  parts,
  label,
  className,
}: {
  readonly parts: readonly PreviewPart[]
  /** What the block is, for a screen reader. */
  readonly label: string
  readonly className?: string
}) {
  return (
    <pre
      title={label}
      className={cn(
        'selectable m-0 max-h-32 overflow-auto rounded-md bg-code-bg p-2.5 font-mono text-sm leading-normal whitespace-pre-wrap break-words text-code-fg ring-[0.5px] ring-line-subtle ring-inset',
        className,
      )}
    >
      {parts.map((part, i) =>
        part.kind === 'redacted' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <Badge key={i} tone="secret" size="sm" className="mx-0.5 align-baseline font-sans">
            {redactionLabel(part)}
          </Badge>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <span key={i}>{part.text}</span>
        ),
      )}
    </pre>
  )
}

/** Cuts text the adapter wrote to `max` characters, so a long note can't push the buttons away. */
export function capText(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}
