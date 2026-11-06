// Reading a permission diff: does an update ask for more, and how to summarise what it adds. The
// renderer decides this from the diff itself rather than trusting a flag, so the acknowledgement
// tick can't be skipped by a review that under-reports.

import type { LimitsInfo, PermissionDiff } from '../../shared/api'

export type Tone = 'read' | 'write' | 'irreversible' | 'secret'

export interface AdditionBadge {
  readonly label: string
  readonly tone: Tone
}

/** Limits where a bigger number is more permissive. Cool-downs are the other way round. */
export function limitsLoosened(before: LimitsInfo, after: LimitsInfo): boolean {
  return (
    after.requestsPerRun > before.requestsPerRun ||
    after.minGapMs < before.minGapMs ||
    after.cooldownSeconds < before.cooldownSeconds ||
    after.maxCooldownSeconds < before.maxCooldownSeconds
  )
}

/** True when the update grants anything the installed version didn't have. */
export function addsPermissions(diff: PermissionDiff): boolean {
  return (
    diff.navigation.added.length > 0 ||
    diff.frameOrigins.added.length > 0 ||
    diff.egress.added.length > 0 ||
    diff.cookieDomains.added.length > 0 ||
    diff.storage.added.length > 0 ||
    diff.requests.added.length > 0 ||
    diff.tools.added.length > 0 ||
    diff.secrets.added.length > 0 ||
    diff.secretFills.added.length > 0 ||
    diff.messagesSources.added.length > 0 ||
    (diff.limits !== null && limitsLoosened(diff.limits.before, diff.limits.after))
  )
}

export function limitsChanged(diff: PermissionDiff): boolean {
  if (diff.limits === null) return false
  const { before, after } = diff.limits
  return (
    before.requestsPerRun !== after.requestsPerRun ||
    before.minGapMs !== after.minGapMs ||
    before.cooldownSeconds !== after.cooldownSeconds ||
    before.maxCooldownSeconds !== after.maxCooldownSeconds
  )
}

function badge(count: number, one: string, many: string, tone: Tone): AdditionBadge[] {
  return count > 0 ? [{ label: `+${count} ${count === 1 ? one : many}`, tone }] : []
}

/** The "This update asks for more" badges, riskiest first. */
export function additionBadges(diff: PermissionDiff): AdditionBadge[] {
  const tools = diff.tools.added
  const requests = diff.requests.added
  return [
    ...badge(diff.egress.added.length, 'host', 'hosts', 'write'),
    ...badge(diff.navigation.added.length, 'login origin', 'login origins', 'write'),
    ...badge(diff.frameOrigins.added.length, 'frame origin', 'frame origins', 'write'),
    ...badge(diff.secrets.added.length, 'secret', 'secrets', 'secret'),
    ...badge(diff.secretFills.added.length, 'secret fill', 'secret fills', 'secret'),
    ...badge(diff.messagesSources.added.length, 'SMS code source', 'SMS code sources', 'secret'),
    ...badge(diff.cookieDomains.added.length, 'hand-over domain', 'hand-over domains', 'write'),
    ...badge(diff.storage.added.length, 'storage key', 'storage keys', 'write'),
    ...badge(
      tools.filter((t) => t.sideEffect === 'irreversible').length,
      'irreversible tool',
      'irreversible tools',
      'irreversible',
    ),
    ...badge(tools.filter((t) => t.sideEffect === 'write').length, 'write tool', 'write tools', 'write'),
    ...badge(tools.filter((t) => t.sideEffect === 'read').length, 'read tool', 'read tools', 'read'),
    ...badge(
      requests.filter((r) => r.purpose === 'irreversible').length,
      'irreversible path',
      'irreversible paths',
      'irreversible',
    ),
    ...badge(requests.filter((r) => r.purpose === 'write').length, 'write path', 'write paths', 'write'),
    ...badge(requests.filter((r) => r.purpose === 'read').length, 'read path', 'read paths', 'read'),
    ...(diff.limits !== null && limitsLoosened(diff.limits.before, diff.limits.after)
      ? [{ label: 'looser limits', tone: 'write' as const }]
      : []),
  ]
}
