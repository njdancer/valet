// What changes between the approved manifest and the one waiting for review, as the review screen
// reads it. Every detail is rendered here from the manifest's structured fields: selectors, URLs,
// conditions and reason codes, never a step's note and never page text.

import {
  type AdapterManifest,
  type AuthStep,
  type Condition,
  canonicalJson,
  messagesSourcesIn,
  type OtpSource,
  toolHints,
  unlockedBy,
} from '@valet/core'
import type {
  AuthStepEntry,
  FileChange,
  LimitsInfo,
  ListDiff,
  ManifestDiffLine,
  PermissionDiff,
  ProbeInfo,
  SecretDiffEntry,
  SecretFillEntry,
  SettingDiffEntry,
  ToolDiffEntry,
} from '../../shared/api'

/**
 * A multiset diff: an entry is unchanged as many times as it appears on both sides, keyed by its
 * canonical JSON, so an entry whose content changed is one removal plus one addition.
 */
export function listDiff<T>(before: readonly T[], after: readonly T[]): ListDiff<T> {
  const remaining = new Map<string, number>()
  for (const item of before) {
    const key = canonicalJson(item)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  const added: T[] = []
  const unchanged: T[] = []
  for (const item of after) {
    const key = canonicalJson(item)
    const count = remaining.get(key) ?? 0
    if (count > 0) {
      remaining.set(key, count - 1)
      unchanged.push(item)
    } else {
      added.push(item)
    }
  }
  const removed: T[] = []
  for (const item of before) {
    const key = canonicalJson(item)
    const count = remaining.get(key) ?? 0
    if (count > 0) {
      remaining.set(key, count - 1)
      removed.push(item)
    }
  }
  return { added, removed, unchanged }
}

export function probeInfo(manifest: AdapterManifest): ProbeInfo {
  const probe = manifest.session.probe
  if (probe.kind === 'cookie') return { kind: 'cookie', name: probe.name }
  return {
    kind: 'fetch',
    path: probe.path,
    expectStatus: probe.expectStatus,
    loggedOutStatuses: [...probe.loggedOutStatuses],
    jsonPath: probe.jsonPath ?? null,
    equals: probe.equals ?? null,
  }
}

export function limitsInfo(manifest: AdapterManifest): LimitsInfo {
  const { requestsPerRun, minGapMs, cooldownSeconds, maxCooldownSeconds } = manifest.limits
  return { requestsPerRun, minGapMs, cooldownSeconds, maxCooldownSeconds }
}

function tools(manifest: AdapterManifest): ToolDiffEntry[] {
  return manifest.tools.map((tool) => {
    // In the entry, so a tool that names one more request to unlock reads as a changed tool.
    const unlocks = unlockedBy(manifest.requests, tool.unlocks).map((r) => `${r.method} ${r.path}`)
    return {
      name: tool.name,
      title: tool.title,
      sideEffect: tool.sideEffect,
      ...toolHints(tool),
      ...(unlocks.length === 0 ? {} : { unlocks }),
    }
  })
}

function secrets(manifest: AdapterManifest): SecretDiffEntry[] {
  return Object.entries(manifest.secrets).map(([name, request]) => ({
    name,
    description: request.description,
    fields: [...request.fields],
    origins: [...request.origins],
  }))
}

function settings(manifest: AdapterManifest): SettingDiffEntry[] {
  return Object.entries(manifest.settings).map(([name, setting]) => ({
    name,
    title: setting.title,
    required: setting.required,
    choicesTool: setting.choices.tool,
    applyTool: setting.apply?.tool ?? null,
  }))
}

function storageKeys(manifest: AdapterManifest): { origin: string; key: string }[] {
  return manifest.session.storage.flatMap(({ origin, keys }) => keys.map((key) => ({ origin, key })))
}

/** A condition in words built from its fields. Text conditions are quoted manifest text. */
export function conditionText(condition: Condition): string {
  if ('visible' in condition) return `visible(${JSON.stringify(condition.visible)})`
  if ('urlContains' in condition) return `url contains ${JSON.stringify(condition.urlContains)}`
  if ('urlRegex' in condition) return `url matches /${condition.urlRegex}/`
  if ('textPresent' in condition) return `text ${JSON.stringify(condition.textPresent)} present`
  if ('not' in condition) return `not ${conditionText(condition.not)}`
  if ('any' in condition) return `any of (${condition.any.map(conditionText).join(', ')})`
  return `all of (${condition.all.map(conditionText).join(', ')})`
}

function otpText(source: OtpSource): string {
  if ('secret' in source) return `one-time code of secret ${source.secret} from 1Password`
  const { sender, pattern, maxAgeSeconds } = source.messages
  return `code from Messages sender ${JSON.stringify(sender)} matching /${pattern}/, at most ${maxAgeSeconds} s old`
}

/** Fills of secrets, in manifest order, nested steps included. */
function secretFills(steps: readonly AuthStep[]): SecretFillEntry[] {
  const fills: SecretFillEntry[] = []
  walk(steps, 0, (step) => {
    if (step.op === 'fill' && 'secret' in step.value) {
      fills.push({ selector: step.selector, secret: step.value.secret, field: step.value.field })
    }
  })
  return fills
}

/**
 * Every other step, flattened in manifest order after its parent, with its depth as a prefix so a
 * step moved into or out of a branch reads as changed. needsUser and fail show their code only.
 */
export function authStepEntries(steps: readonly AuthStep[]): AuthStepEntry[] {
  const entries: AuthStepEntry[] = []
  walk(steps, 0, (step, depth, branch) => {
    if (step.op === 'fill' && 'secret' in step.value) return
    const prefix = `${'› '.repeat(depth)}${branch === 'otherwise' ? 'otherwise: ' : ''}`
    entries.push({ op: step.op, detail: `${prefix}${stepDetail(step)}` })
  })
  return entries
}

function stepDetail(step: AuthStep): string {
  switch (step.op) {
    case 'goto':
      return `go to ${step.url}`
    case 'waitFor':
      return `wait up to ${step.timeoutMs} ms for ${conditionText(step.condition)}`
    case 'click':
      return `click ${JSON.stringify(step.selector)}`
    case 'fill':
      // A literal fill (a secret fill is in secretFills). The text is the manifest's, shown by length.
      return `type ${'literal' in step.value ? step.value.literal.length : 0} characters of fixed text into ${JSON.stringify(step.selector)}`
    case 'otp':
      return `type the ${otpText(step.source)} into ${JSON.stringify(step.selector)}`
    case 'pause':
      return `pause ${step.ms} ms`
    case 'when':
      return `when ${conditionText(step.condition)}`
    case 'retry':
      return `retry up to ${step.times} times`
    case 'assertLoggedIn':
      return 'check the login probe'
    case 'needsUser':
      return `hand the window to the person (${step.reason})`
    case 'fail':
      return `stop the login (${step.errorClass})`
  }
}

function walk(
  steps: readonly AuthStep[],
  depth: number,
  visit: (step: AuthStep, depth: number, branch: 'steps' | 'otherwise') => void,
  branch: 'steps' | 'otherwise' = 'steps',
): void {
  for (const step of steps) {
    visit(step, depth, branch)
    if (step.op === 'when') {
      walk(step.steps, depth + 1, visit)
      if (step.otherwise !== undefined) walk(step.otherwise, depth + 1, visit, 'otherwise')
    }
    if (step.op === 'retry') walk(step.steps, depth + 1, visit)
  }
}

function senders(manifest: AdapterManifest): { sender: string }[] {
  const seen = new Set<string>()
  const list: { sender: string }[] = []
  for (const { sender } of messagesSourcesIn(manifest.auth.steps)) {
    if (seen.has(sender)) continue
    seen.add(sender)
    list.push({ sender })
  }
  return list
}

/** The permission diff from `before` (null for a first install) to `after`. */
export function permissionDiff(before: AdapterManifest | null, after: AdapterManifest): PermissionDiff {
  const pick = <T>(read: (m: AdapterManifest) => readonly T[]): ListDiff<T> =>
    listDiff(before === null ? [] : read(before), read(after))
  return {
    navigation: pick((m) => m.navigation),
    frameOrigins: pick((m) => m.auth.frameOrigins),
    egress: pick((m) => m.egress),
    cookieDomains: pick((m) => m.session.cookieDomains),
    storage: pick(storageKeys),
    requests: pick((m) => m.requests.map(({ method, path, purpose }) => ({ method, path, purpose }))),
    tools: pick(tools),
    secrets: pick(secrets),
    secretFills: pick((m) => secretFills(m.auth.steps)),
    authSteps: pick((m) => authStepEntries(m.auth.steps)),
    messagesSources: pick(senders),
    settings: pick(settings),
    limits: before === null ? null : { before: limitsInfo(before), after: limitsInfo(after) },
    probe: before === null ? null : { before: probeInfo(before), after: probeInfo(after) },
  }
}

/**
 * Whether approving would let the adapter do anything it couldn't before: any added entry, looser
 * limits, or a changed probe. A first install adds everything.
 */
export function addsPermissions(diff: PermissionDiff): boolean {
  const lists = [
    diff.navigation,
    diff.frameOrigins,
    diff.egress,
    diff.cookieDomains,
    diff.storage,
    diff.requests,
    diff.tools,
    diff.secrets,
    diff.secretFills,
    diff.authSteps,
    diff.messagesSources,
    // A new setting runs a tool on the person's behalf before each call; a changed one runs another.
    diff.settings,
  ]
  if (lists.some((list) => list.added.length > 0)) return true
  // A removed needsUser, fail or assertLoggedIn takes a stop out of the login.
  if (diff.authSteps.removed.some((s) => ['needsUser', 'fail', 'assertLoggedIn'].includes(s.op))) return true
  if (diff.limits !== null) {
    const { before, after } = diff.limits
    if (
      after.requestsPerRun > before.requestsPerRun ||
      after.minGapMs < before.minGapMs ||
      after.cooldownSeconds < before.cooldownSeconds ||
      after.maxCooldownSeconds < before.maxCooldownSeconds
    )
      return true
  }
  return diff.probe !== null && canonicalJson(diff.probe.before) !== canonicalJson(diff.probe.after)
}

/** The manifest as the review screen's text diff shows it: canonical keys, two-space JSON. */
export function manifestText(manifest: AdapterManifest): string[] {
  return JSON.stringify(JSON.parse(canonicalJson(manifest)), null, 2).split('\n')
}

/** A line diff (longest common subsequence), as one hunk. */
export function lineDiff(before: readonly string[], after: readonly string[]): ManifestDiffLine[] {
  const n = before.length
  const m = after.length
  // lengths[i][j]: LCS of before[i..] and after[j..].
  const lengths: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = lengths[i] as number[]
    const next = lengths[i + 1] as number[]
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number)
    }
  }
  const lines: ManifestDiffLine[] = [
    { kind: 'hunk', oldLine: null, newLine: null, text: `@@ -1,${n} +1,${m} @@` },
  ]
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      lines.push({ kind: 'same', oldLine: i + 1, newLine: j + 1, text: before[i] as string })
      i++
      j++
    } else if (j < m && (i === n || (lengths[i]?.[j + 1] ?? 0) >= (lengths[i + 1]?.[j] ?? 0))) {
      lines.push({ kind: 'add', oldLine: null, newLine: j + 1, text: after[j] as string })
      j++
    } else {
      lines.push({ kind: 'del', oldLine: i + 1, newLine: null, text: before[i] as string })
      i++
    }
  }
  return lines
}

/** Which source files changed, with added and removed line counts. */
export function fileChanges(
  before: Readonly<Record<string, string>> | null,
  after: Readonly<Record<string, string>>,
): FileChange[] {
  const old = before ?? {}
  const paths = [...new Set([...Object.keys(old), ...Object.keys(after)])].sort()
  const changes: FileChange[] = []
  for (const path of paths) {
    const a = Object.hasOwn(old, path) ? old[path] : undefined
    const b = Object.hasOwn(after, path) ? after[path] : undefined
    if (a === b) continue
    if (a === undefined) {
      changes.push({ path, status: 'added', added: lineCount(b ?? ''), removed: 0 })
    } else if (b === undefined) {
      changes.push({ path, status: 'removed', added: 0, removed: lineCount(a) })
    } else {
      const diff = lineDiff(a.split('\n'), b.split('\n'))
      changes.push({
        path,
        status: 'modified',
        added: diff.filter((l) => l.kind === 'add').length,
        removed: diff.filter((l) => l.kind === 'del').length,
      })
    }
  }
  return changes
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}
