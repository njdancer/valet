// Renders a redacted JSON preview from the main process. The main process has already replaced
// every secret and session value with a marker; this only draws the markers and colours the JSON.
// Everything is React text, so a tool's output can't inject markup.

import type { ReactNode } from 'react'
import type { PreviewPart } from '../../shared/api'

const TOKEN = /("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)|(…[^\n]*)/g

export function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index
    if (index > last) out.push(text.slice(last, index))
    const [whole, str, colon, literal, ellipsis] = match
    if (str !== undefined) {
      out.push(
        <span key={index} className={colon === undefined ? 's' : 'k'}>
          {str}
        </span>,
      )
      if (colon !== undefined) out.push(colon)
    } else if (literal !== undefined) {
      out.push(
        <span key={index} className="n">
          {literal}
        </span>,
      )
    } else if (ellipsis !== undefined) {
      out.push(
        <span key={index} className="c">
          {ellipsis}
        </span>,
      )
    }
    last = index + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const LABELS: Readonly<Record<Extract<PreviewPart, { kind: 'redacted' }>['label'], string>> = {
  secret: 'secret',
  'session-cookie': 'session cookie',
  'session-storage': 'session storage',
}

export function redactionLabel(part: Extract<PreviewPart, { kind: 'redacted' }>): string {
  const base = Object.hasOwn(LABELS, part.label) ? LABELS[part.label] : 'redacted'
  return part.ref === null ? `[${base}]` : `[${base}:${part.ref}]`
}

export function Preview({
  parts,
  className = 'code',
}: {
  readonly parts: readonly PreviewPart[]
  readonly className?: string
}) {
  return (
    <pre className={className}>
      {parts.map((part, i) =>
        part.kind === 'redacted' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <span key={i} className="redacted">
            {redactionLabel(part)}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <span key={i}>{highlight(part.text)}</span>
        ),
      )}
    </pre>
  )
}
