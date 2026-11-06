// Reading a permission diff: does an update ask for more, and how to summarise what it adds. The
// renderer decides this from the diff itself rather than trusting a flag, so the acknowledgement
// tick can't be skipped by a review that under-reports.

import type { LimitsInfo, PermissionDiff, ProbeInfo } from '../../shared/api'
import { plural } from './format'

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

/** Whether two probes check the same thing. Any change to the login check needs a look. */
export function sameProbe(a: ProbeInfo, b: ProbeInfo): boolean {
  if (a.kind === 'cookie') return b.kind === 'cookie' && a.name === b.name
  if (b.kind === 'cookie') return false
  return (
    a.path === b.path &&
    a.expectStatus === b.expectStatus &&
    a.loggedOutStatuses.length === b.loggedOutStatuses.length &&
    a.loggedOutStatuses.every((status, i) => b.loggedOutStatuses[i] === status) &&
    a.jsonPath === b.jsonPath &&
    a.equals === b.equals
  )
}

/** Login steps whose removal means the login stops checking or asking where it used to. */
const SAFEGUARD_OPS: ReadonlySet<string> = new Set(['needsUser', 'fail', 'assertLoggedIn'])

export function removedSafeguards(diff: PermissionDiff): number {
  return diff.authSteps.removed.filter((s) => SAFEGUARD_OPS.has(s.op)).length
}

/** The login check in words, from its fields. */
export function probeText(probe: ProbeInfo): string {
  if (probe.kind === 'cookie') return `cookie ${probe.name} present`
  const check =
    probe.jsonPath === null
      ? ''
      : probe.equals === null
        ? ` · ${probe.jsonPath} truthy`
        : ` · ${probe.jsonPath} = ${JSON.stringify(probe.equals)}`
  return `GET ${probe.path} → ${probe.expectStatus}${check} · logged out on ${probe.loggedOutStatuses.join(', ')}`
}

export function probeChanged(diff: PermissionDiff): boolean {
  return diff.probe !== null && !sameProbe(diff.probe.before, diff.probe.after)
}

/**
 * True when the update grants anything the installed version didn't have, or changes how it logs in:
 * a new login step (a click can accept terms) or a different login check both need the tick.
 */
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
    diff.authSteps.added.length > 0 ||
    removedSafeguards(diff) > 0 ||
    diff.messagesSources.added.length > 0 ||
    (diff.limits !== null && limitsLoosened(diff.limits.before, diff.limits.after)) ||
    probeChanged(diff)
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
    ...badge(diff.authSteps.added.length, 'login step', 'login steps', 'write'),
    ...(removedSafeguards(diff) > 0
      ? [{ label: `−${plural(removedSafeguards(diff), 'login safeguard')}`, tone: 'write' as const }]
      : []),
    ...(probeChanged(diff) ? [{ label: 'new login check', tone: 'write' as const }] : []),
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
