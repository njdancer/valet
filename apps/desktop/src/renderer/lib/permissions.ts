// Reading a permission diff: does an update ask for more, and how to summarise what it adds. The
// renderer decides this from the diff itself rather than trusting a flag, so the acknowledgement
// tick can't be skipped by a review that under-reports.

import type { PermissionChange, Purpose, RequestDeclaration } from '@valet/core'
import type {
  LimitsInfo,
  PendingReview,
  PermissionDiff,
  ProbeInfo,
  SecretDiffEntry,
  ToolDiffEntry,
} from '../../shared/api'
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
    after.maxCooldownSeconds < before.maxCooldownSeconds ||
    (after.uploadBytesPerRun ?? 0) > (before.uploadBytesPerRun ?? 0) ||
    (after.writeUploadBytesPerRun ?? 0) > (before.writeUploadBytesPerRun ?? 0)
  )
}

/** Whether two probes check the same thing. Any change to the login check needs a look. */
export function sameProbe(a: ProbeInfo, b: ProbeInfo): boolean {
  if (a.kind === 'cookie') return b.kind === 'cookie' && a.name === b.name
  if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind
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
  if (probe.kind === 'none') return 'no login'
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
    diff.credentials.added.length > 0 ||
    diff.authSteps.added.length > 0 ||
    removedSafeguards(diff) > 0 ||
    diff.messagesSources.added.length > 0 ||
    diff.settings.added.length > 0 ||
    (diff.limits !== null && limitsLoosened(diff.limits.before, diff.limits.after)) ||
    probeChanged(diff) ||
    diff.sandbox.becameUnsandboxed ||
    diff.sandbox.exceptions.some((e) => e.change === 'added') ||
    reachLines(diff).some((c) => c.change === 'added' || c.change === 'widened')
  )
}

/** The kind's own lines (kind, endpoints, private hosts, folders, recipients), as the card says them. */
export function reachLines(diff: PermissionDiff): readonly PermissionChange[] {
  return diff.reach ?? []
}

export function limitsChanged(diff: PermissionDiff): boolean {
  if (diff.limits === null) return false
  const { before, after } = diff.limits
  return (
    before.requestsPerRun !== after.requestsPerRun ||
    before.minGapMs !== after.minGapMs ||
    before.cooldownSeconds !== after.cooldownSeconds ||
    before.maxCooldownSeconds !== after.maxCooldownSeconds ||
    (before.uploadBytesPerRun ?? 0) !== (after.uploadBytesPerRun ?? 0) ||
    (before.writeUploadBytesPerRun ?? 0) !== (after.writeUploadBytesPerRun ?? 0)
  )
}

/** Side effects in order of how much they let a tool do. */
const PURPOSE_RANK: Readonly<Record<Purpose, number>> = { read: 0, write: 1, irreversible: 2 }

/**
 * An added secret, read against the removed one of the same name if there is one: the diff lists a
 * changed secret as one removal plus one addition, and the person needs to see what grew.
 */
export interface SecretChange {
  readonly secret: SecretDiffEntry
  /** Null for a secret the installed version didn't ask for. */
  readonly was: SecretDiffEntry | null
  readonly newFields: readonly SecretDiffEntry['fields'][number][]
  readonly newOrigins: readonly string[]
}

export function secretChanges(diff: PermissionDiff): SecretChange[] {
  return diff.secrets.added.map((secret) => {
    const was = diff.secrets.removed.find((s) => s.name === secret.name) ?? null
    return {
      secret,
      was,
      newFields: was === null ? [] : secret.fields.filter((f) => !was.fields.includes(f)),
      newOrigins: was === null ? [] : secret.origins.filter((o) => !was.origins.includes(o)),
    }
  })
}

/** An added tool, read against the removed one of the same name if there is one. */
export interface ToolChange {
  readonly tool: ToolDiffEntry
  /** The side effect it had before; null for a new tool. */
  readonly was: Purpose | null
  /** Whether its side effect went up (read to write, or anything to irreversible). */
  readonly raised: boolean
  /** An existing tool now advertised to MCP clients as destructive (C9). */
  readonly becameDestructive: boolean
  /**
   * An existing tool no longer advertised as destructive, or newly idempotent: clients may now run
   * or retry it without asking, on the adapter's word.
   */
  readonly hintsRelaxed: boolean
}

export function toolChanges(diff: PermissionDiff): ToolChange[] {
  return diff.tools.added.map((tool) => {
    const before = diff.tools.removed.find((t) => t.name === tool.name) ?? null
    const was = before?.sideEffect ?? null
    return {
      tool,
      was,
      raised: was !== null && PURPOSE_RANK[tool.sideEffect] > PURPOSE_RANK[was],
      becameDestructive: before !== null && !before.destructive && tool.destructive,
      hintsRelaxed:
        before !== null &&
        ((before.destructive && !tool.destructive) || (!before.idempotent && tool.idempotent)),
    }
  })
}

/** Names that are on both sides of a list diff: changed entries, shown once as their new form. */
export function changedNames(diff: {
  readonly added: readonly { readonly name: string }[]
  readonly removed: readonly { readonly name: string }[]
}): Set<string> {
  const added = new Set(diff.added.map((e) => e.name))
  return new Set(diff.removed.filter((e) => added.has(e.name)).map((e) => e.name))
}

/** Request declarations grouped by purpose, riskiest first, empty groups left out. */
export function requestsByPurpose(
  requests: readonly RequestDeclaration[],
): { readonly purpose: Purpose; readonly requests: readonly RequestDeclaration[] }[] {
  return (['irreversible', 'write', 'read'] as const)
    .map((purpose) => ({ purpose, requests: requests.filter((r) => r.purpose === purpose) }))
    .filter((group) => group.requests.length > 0)
}

function badge(count: number, one: string, many: string, tone: Tone): AdditionBadge[] {
  return count > 0 ? [{ label: `+${count} ${count === 1 ? one : many}`, tone }] : []
}

/**
 * Whether the version under review logs in: it asks for a secret, an SMS code, or has login steps,
 * a session check, or session hand-over. Only then does a review speak of logins and cookies; a
 * site with none (a dictionary) just opens pages.
 */
export function diffHasLogin(diff: PermissionDiff): boolean {
  const kept = <T>(list: { readonly added: readonly T[]; readonly unchanged: readonly T[] }) =>
    list.added.length + list.unchanged.length > 0
  return (
    kept(diff.secrets) ||
    kept(diff.secretFills) ||
    kept(diff.authSteps) ||
    kept(diff.messagesSources) ||
    kept(diff.cookieDomains) ||
    kept(diff.storage) ||
    (diff.probe !== null && diff.probe.after.kind !== 'none')
  )
}

/** Whether a review should speak of logins: the main process says, else the diff shows it. */
export function reviewLogsIn(review: Pick<PendingReview, 'diff' | 'logsIn'>): boolean {
  return review.logsIn ?? diffHasLogin(review.diff)
}

/** The "This update asks for more" badges, riskiest first. */
export function additionBadges(diff: PermissionDiff, login = diffHasLogin(diff)): AdditionBadge[] {
  const tools = diff.tools.added
  const requests = diff.requests.added
  const secrets = secretChanges(diff)
  return [
    ...(diff.sandbox.becameUnsandboxed
      ? [{ label: 'runs without the sandbox', tone: 'write' as const }]
      : []),
    ...badge(
      reachLines(diff).filter((c) => c.change === 'added' || c.change === 'widened').length,
      'change to what it reaches',
      'changes to what it reaches',
      'write',
    ),
    ...badge(
      diff.sandbox.exceptions.filter((e) => e.change === 'added').length,
      'access on this Mac',
      'accesses on this Mac',
      'write',
    ),
    ...badge(diff.egress.added.length, 'site it contacts', 'sites it contacts', 'write'),
    ...(login
      ? badge(diff.navigation.added.length, 'login site', 'login sites', 'write')
      : badge(diff.navigation.added.length, 'site it opens', 'sites it opens', 'write')),
    ...badge(diff.frameOrigins.added.length, 'embedded site', 'embedded sites', 'write'),
    ...badge(secrets.filter((s) => s.was === null).length, 'secret', 'secrets', 'secret'),
    ...badge(
      secrets.reduce((n, s) => n + s.newFields.length, 0),
      'secret field',
      'secret fields',
      'secret',
    ),
    ...badge(
      secrets.reduce((n, s) => n + s.newOrigins.length, 0),
      'site a secret is typed on',
      'sites secrets are typed on',
      'secret',
    ),
    ...badge(diff.secretFills.added.length, 'place a secret is typed', 'places secrets are typed', 'secret'),
    ...badge(diff.messagesSources.added.length, 'SMS code source', 'SMS code sources', 'secret'),
    // Every step is listed below; one line here says the login changed, not "+87 login steps".
    ...(diff.authSteps.added.length > 0 ? [{ label: 'login changed', tone: 'write' as const }] : []),
    ...(removedSafeguards(diff) > 0
      ? [{ label: `−${plural(removedSafeguards(diff), 'login safeguard')}`, tone: 'write' as const }]
      : []),
    ...(probeChanged(diff) ? [{ label: 'new login check', tone: 'write' as const }] : []),
    ...badge(
      diff.cookieDomains.added.length,
      'site it stays signed in to',
      'sites it stays signed in to',
      'write',
    ),
    ...badge(diff.storage.added.length, 'kind of saved site data', 'kinds of saved site data', 'write'),
    ...badge(
      tools.filter((t) => t.sideEffect === 'irreversible').length,
      'tool that can’t be undone',
      'tools that can’t be undone',
      'irreversible',
    ),
    ...badge(
      tools.filter((t) => t.sideEffect === 'write').length,
      'tool that changes things',
      'tools that change things',
      'write',
    ),
    ...badge(
      tools.filter((t) => t.sideEffect === 'read').length,
      'read-only tool',
      'read-only tools',
      'read',
    ),
    ...badge(diff.settings.added.length, 'setting', 'settings', 'write'),
    ...badge(
      requests.filter((r) => r.purpose === 'irreversible').length,
      'API call that can’t be undone',
      'API calls that can’t be undone',
      'irreversible',
    ),
    ...badge(
      requests.filter((r) => r.purpose === 'write').length,
      'API call that changes things',
      'API calls that change things',
      'write',
    ),
    ...badge(
      requests.filter((r) => r.purpose === 'read').length,
      'read-only API call',
      'read-only API calls',
      'read',
    ),
    ...(diff.limits !== null && limitsLoosened(diff.limits.before, diff.limits.after)
      ? [{ label: 'looser limits', tone: 'write' as const }]
      : []),
  ]
}
