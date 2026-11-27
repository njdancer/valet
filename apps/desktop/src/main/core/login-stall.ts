// Where a login stopped short, for the call trace (valet_get_call's loginStall): the page's
// address, title and accessibility snapshot at the moment the login ended in needsUser, failed or
// blocked. Without it, a login that met a page its manifest didn't know left nothing to debug from:
// the auth window is closed or handed to the person, and the audit log keeps only the reason.
//
// It is the site's text, so it is data, never instructions, for whoever reads it. Before it is kept:
// - the URL loses its query and fragment (Auth0's `state` and the like belong to the login);
// - every form field's value is dropped, whatever it holds;
// - any line that holds a secret this login typed, in any form the runtime's redaction knows, is
//   replaced whole.
// Kept in RunMemory only, like a call's input and output: never written to disk.

import type { AuthPageView } from '@valet/core'
import type { LoginStall, LoginStallOutcome } from '../../shared/api'

/** The most of a stall page's snapshot kept, in characters, cut at a line. */
export const STALL_SNAPSHOT_CHARS = 16_000

/** What replaces a snapshot line that held a secret. */
export const STALL_REDACTED_LINE = '[redacted: held a login secret]'

/** Roles whose snapshot line ends in the field's value: `- textbox "Email" [ref=e3]: value`. */
const FIELD_LINE = /^(\s*-\s+(?:textbox|searchbox|combobox|spinbutton|slider)\b[^:]*?)(?::\s.*)?$/

/** The URL without its query and fragment, or '' if it isn't one. */
export function stallUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

/** The snapshot with field values dropped and secret-bearing lines replaced, cut to size. */
export function cleanStallSnapshot(
  yaml: string,
  holdsSecret: (text: string) => boolean,
): { readonly snapshot: string; readonly cut: boolean } {
  const lines = yaml.split('\n').map((line) => {
    const field = FIELD_LINE.exec(line)
    const kept = field?.[1] ?? line
    if (!holdsSecret(kept)) return kept
    const indent = /^\s*/.exec(kept)?.[0] ?? ''
    return `${indent}- ${STALL_REDACTED_LINE}`
  })
  let snapshot = lines.join('\n')
  const cut = snapshot.length > STALL_SNAPSHOT_CHARS
  if (cut) {
    const end = snapshot.lastIndexOf('\n', STALL_SNAPSHOT_CHARS)
    snapshot = snapshot.slice(0, end > 0 ? end : STALL_SNAPSHOT_CHARS)
  }
  return { snapshot, cut }
}

export function loginStall(
  at: Date,
  outcome: LoginStallOutcome,
  reason: string,
  view: AuthPageView | null,
  holdsSecret: (text: string) => boolean,
): LoginStall {
  if (view === null) return { at: at.toISOString(), outcome, reason, page: null }
  const url = stallUrl(view.url)
  const title = view.title.replace(/\s+/g, ' ').trim().slice(0, 200)
  const { snapshot, cut } = cleanStallSnapshot(view.snapshot, holdsSecret)
  return {
    at: at.toISOString(),
    outcome,
    reason,
    page: {
      url: holdsSecret(url) ? '' : url,
      title: holdsSecret(title) ? STALL_REDACTED_LINE : title,
      snapshot,
      cut,
    },
  }
}
