// The Calls list's logic, without React: which calls a filter keeps, and how retries fold.

import type { RunSummary } from '../../../shared/api'
import type { CallFilters, CallOutcomeFilter } from '../../lib/routes'
import { askedToRetry } from '../../lib/wording'

/** The outcome filter's words, in the order the menu lists them. */
export const OUTCOME_LABELS: Readonly<Record<CallOutcomeFilter, string>> = {
  ok: 'Worked',
  failed: 'Failed',
  blocked: 'Blocked by the site',
  'needs-you': 'Needed you',
  declined: 'Declined',
  running: 'Running',
}

export function matchesOutcome(run: RunSummary, outcome: CallOutcomeFilter): boolean {
  switch (outcome) {
    case 'ok':
      return run.outcome === 'ok'
    case 'failed':
      return run.outcome === 'failed' && !askedToRetry(run)
    case 'blocked':
      return run.outcome === 'blocked'
    case 'needs-you':
      return run.outcome === 'needsUser'
    case 'declined':
      return run.outcome === 'declined'
    case 'running':
      return run.outcome === 'running'
  }
}

/**
 * Whether a call passes the filters. `loginCalls` is the set of calls that used the filtered login
 * (from the audit log's login-use records), or null while it loads or when no login filter is set.
 */
export function matchesFilters(
  run: RunSummary,
  filters: CallFilters,
  loginCalls: ReadonlySet<string> | null,
): boolean {
  if (filters.site !== null && run.adapterId !== filters.site) return false
  if (filters.tool !== null && run.tool !== filters.tool) return false
  if (filters.client !== null && run.client !== filters.client) return false
  if (filters.outcome !== null && !matchesOutcome(run, filters.outcome)) return false
  if (filters.login !== null && (loginCalls === null || !loginCalls.has(run.callId))) return false
  return true
}

/** `<site>/<secret>` → its parts, or null for a malformed value. */
export function parseLogin(login: string): { readonly site: string; readonly secret: string } | null {
  const at = login.indexOf('/')
  if (at <= 0 || at === login.length - 1) return null
  return { site: login.slice(0, at), secret: login.slice(at + 1) }
}

/** How soon after a retry answer a call counts as its retry. */
const RETRY_WINDOW_MS = 5 * 60_000

export interface ListedRun {
  readonly run: RunSummary
  /** Earlier calls from the same client to the same tool that were asked to retry, folded in. */
  readonly retries: number
  /** The first of those folded calls, so the list can still open it (it may hold the login). */
  readonly firstRetry: string | null
}

/**
 * F12: a call answered "call again" (a login was already running, or the adapter was busy) is
 * folded into the next call from the same client to the same tool within a few minutes, so the list
 * shows one line for what the agent did. A retry with no such follow-up stays as its own line.
 */
export function foldRetries(newestFirst: readonly RunSummary[]): ListedRun[] {
  const folded = new Map<string, { readonly count: number; readonly first: string }>()
  const hidden = new Set<string>()
  // Oldest first, so a chain of retry answers carries its count forward to the call that ended it.
  for (let index = newestFirst.length - 1; index >= 0; index--) {
    const run = newestFirst[index] as RunSummary
    if (!askedToRetry(run)) continue
    const started = Date.parse(run.startedAt)
    for (let i = index - 1; i >= 0; i--) {
      const later = newestFirst[i] as RunSummary
      if (Date.parse(later.startedAt) - started > RETRY_WINDOW_MS) break
      if (later.adapterId !== run.adapterId || later.tool !== run.tool || later.client !== run.client)
        continue
      const earlier = folded.get(run.callId)
      folded.set(later.callId, {
        count: (folded.get(later.callId)?.count ?? 0) + 1 + (earlier?.count ?? 0),
        first: earlier?.first ?? run.callId,
      })
      folded.delete(run.callId)
      hidden.add(run.callId)
      break
    }
  }
  return newestFirst
    .filter((run) => !hidden.has(run.callId))
    .map((run) => {
      const f = folded.get(run.callId)
      return { run, retries: f?.count ?? 0, firstRetry: f?.first ?? null }
    })
}

/** The filters said as a phrase, for an empty result: "failed Woolworths calls". */
export function describeFilters(filters: CallFilters, siteName: (id: string) => string): string {
  const parts: string[] = []
  if (filters.outcome !== null) parts.push(OUTCOME_LABELS[filters.outcome].toLowerCase())
  if (filters.site !== null) parts.push(siteName(filters.site))
  parts.push(filters.tool === null ? 'calls' : `${filters.tool} calls`)
  return parts.join(' ')
}
