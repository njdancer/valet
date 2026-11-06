// Recent calls' input and output, for the run trace and the confirmation panel. Kept in memory only
// and for a bounded number of calls: nothing here is ever written to disk. Output is what the
// runtime returned, already redacted; its "[redacted]" markers become redaction parts.

import { REDACTED } from '@siteadapter/runtime'
import type { PreviewPart } from '../../shared/api'
import { RUN_MEMORY } from './constants'

/** Longest preview kept, in characters. A preview is for reading, not for a copy of the data. */
export const MAX_PREVIEW = 20_000

export interface RememberedRun {
  readonly tool: string
  readonly client: string
  readonly input: readonly PreviewPart[]
  readonly output: readonly PreviewPart[] | null
  readonly outputBytes: number | null
  readonly redactions: number
}

/** JSON text split into text and redaction markers. Unserialisable values preview as a fixed note. */
export function previewParts(value: unknown): { parts: PreviewPart[]; bytes: number; redactions: number } {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? 'null'
  } catch {
    return { parts: [{ kind: 'text', text: '(not shown)' }], bytes: 0, redactions: 0 }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  const clipped = text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n…` : text
  const marker = JSON.stringify(REDACTED)
  const pieces = clipped.split(marker)
  const parts: PreviewPart[] = []
  pieces.forEach((piece, index) => {
    if (index > 0) parts.push({ kind: 'redacted', label: 'secret', ref: null })
    if (piece.length > 0) parts.push({ kind: 'text', text: piece })
  })
  return { parts, bytes, redactions: pieces.length - 1 }
}

export class RunMemory {
  private readonly runs = new Map<string, RememberedRun>()

  started(callId: string, tool: string, client: string, input: unknown): void {
    this.runs.set(callId, {
      tool,
      client,
      input: previewParts(input).parts,
      output: null,
      outputBytes: null,
      redactions: 0,
    })
    while (this.runs.size > RUN_MEMORY) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined) break
      this.runs.delete(oldest)
    }
  }

  finished(callId: string, output: unknown | undefined): void {
    const run = this.runs.get(callId)
    if (run === undefined || output === undefined) return
    const preview = previewParts(output)
    this.runs.set(callId, {
      ...run,
      output: preview.parts,
      outputBytes: preview.bytes,
      redactions: preview.redactions,
    })
  }

  get(callId: string): RememberedRun | undefined {
    return this.runs.get(callId)
  }
}
