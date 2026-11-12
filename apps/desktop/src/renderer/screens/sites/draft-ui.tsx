// What a draft shows, on Sites and on its own page (wireframes `mac-sites-drafts`, `mac-draft-page`):
// only checks Valet ran and what it recorded, never what the agent says about its own work.

import { Badge } from '@valet/ui'
import type { DraftOverview } from '../../../shared/api'
import { plural } from '../../lib/format'

const STATUS: Readonly<
  Record<
    DraftOverview['status'],
    { readonly label: string; readonly tone: 'neutral' | 'warning' | 'success' | 'danger' }
  >
> = {
  editing: { label: 'Being written', tone: 'neutral' },
  waiting: { label: 'Waiting for you', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  declined: { label: 'Declined', tone: 'danger' },
  expired: { label: 'Request expired', tone: 'neutral' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
}

export function DraftStatus({ status }: { readonly status: DraftOverview['status'] }) {
  const s = STATUS[status]
  return <Badge tone={s.tone}>{s.label}</Badge>
}

/** One line: Valet's last check of these files and the live trials, as Sites lists them. */
export function checksSummary(draft: DraftOverview): string {
  const parts: string[] = []
  const check = draft.check
  if (check === null) parts.push('not checked since the last edit')
  else if (!check.ok) parts.push('checks fail')
  else parts.push(`checks pass · ${plural(check.passed, 'agent test')} pass`)
  if (draft.trials.length > 0) {
    const failed = draft.trials.filter((t) => !t.ok).length
    parts.push(failed === 0 ? 'live trial ok' : `live trial failed for ${plural(failed, 'tool')}`)
  }
  return parts.join(' · ')
}

export function draftTitle(draft: Pick<DraftOverview, 'name' | 'version'>): string {
  return draft.version === null ? draft.name : `${draft.name} ${draft.version}`
}
