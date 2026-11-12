// The signed subject of an adapter install, update or rollback (`adapter-install`, B's contract),
// built only from what the Mac knows: the two manifests, the hashes, where the package came from.
// The permission lines are the Mac's own diff in B's areas and risks, so a card on any device and
// the Touch ID prompt show what changes, never what an agent says changes.

import {
  type AdapterManifest,
  type ApprovalSubject,
  bundleHash,
  isDisplayText,
  type PermissionChange,
  type Risk,
} from '@valet/core'
import type { ListDiff } from '../../../shared/api'
import { permissionDiff } from '../permission-diff'

type Area = PermissionChange['area']

const MAX_LINES = 200
const MAX_ITEMS = 50

/** One line's items, as display text: cut to 200 characters, anything unprintable dropped. */
function items(values: readonly string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    const cut = [...value.replace(/\s+/g, ' ').trim()].slice(0, 200).join('')
    if (cut !== '' && isDisplayText(cut)) out.push(cut)
    if (out.length === MAX_ITEMS) break
  }
  return out
}

/**
 * The Mac's permission diff from `before` (null for a first install) to `after`, as B's lines.
 * Additions carry the area's risk; removals are low. `unsandboxed` adds the critical
 * sandbox-mode line, which makes the request Mac only (approvableOn).
 */
export function permissionChanges(
  before: AdapterManifest | null,
  after: AdapterManifest,
  unsandboxed: boolean,
): PermissionChange[] {
  const diff = permissionDiff(before, after)
  const lines: PermissionChange[] = []
  const push = (area: Area, change: PermissionChange['change'], values: readonly string[], risk: Risk) => {
    const kept = items(values)
    if (kept.length > 0 && lines.length < MAX_LINES) lines.push({ area, change, items: kept, risk })
  }
  const list = <T>(area: Area, d: ListDiff<T>, show: (t: T) => string, risk: Risk | ((t: T) => Risk)) => {
    const riskOf = typeof risk === 'function' ? risk : () => risk
    for (const level of ['critical', 'high', 'medium', 'low'] as const) {
      push(area, 'added', d.added.filter((t) => riskOf(t) === level).map(show), level)
    }
    push(area, 'removed', d.removed.map(show), 'low')
  }
  if (unsandboxed)
    push('sandbox-mode', 'added', ['Runs without the sandbox: it can do anything you can'], 'critical')
  list('navigation', diff.navigation, (o) => o, 'medium')
  list('egress', diff.egress, (o) => o, 'medium')
  list('auth-frames', diff.frameOrigins, (o) => o, 'high')
  list('session-cookies', diff.cookieDomains, (d) => d, 'high')
  list('session-storage', diff.storage, (s) => `${s.origin} ${s.key}`, 'high')
  list(
    'requests',
    diff.requests,
    (r) => `${r.method} ${r.path} (${r.purpose})`,
    (r) => (r.purpose === 'irreversible' ? 'high' : r.purpose === 'write' ? 'medium' : 'low'),
  )
  list(
    'tool',
    diff.tools,
    (t) => `${t.name} (${t.sideEffect})`,
    (t) => (t.sideEffect === 'irreversible' ? 'high' : t.sideEffect === 'write' ? 'medium' : 'low'),
  )
  list('secret', diff.secrets, (s) => `${s.name}: ${s.fields.join(', ')}`, 'high')
  list('secret-origins', diff.secretFills, (f) => `${f.secret} ${f.field} into ${f.selector}`, 'high')
  list('messages-sender', diff.messagesSources, (m) => m.sender, 'high')
  list('setting', diff.settings, (s) => s.name, 'medium')
  if (diff.limits !== null) {
    const { before: was, after: now } = diff.limits
    const looser: string[] = []
    if (now.requestsPerRun > was.requestsPerRun)
      looser.push(`requests per run ${was.requestsPerRun} → ${now.requestsPerRun}`)
    if (now.minGapMs < was.minGapMs)
      looser.push(`gap between requests ${was.minGapMs} ms → ${now.minGapMs} ms`)
    if (now.cooldownSeconds < was.cooldownSeconds)
      looser.push(`cooldown ${was.cooldownSeconds} s → ${now.cooldownSeconds} s`)
    if (now.maxCooldownSeconds < was.maxCooldownSeconds)
      looser.push(`longest cooldown ${was.maxCooldownSeconds} s → ${now.maxCooldownSeconds} s`)
    push('limits', 'widened', looser, 'medium')
  }
  return lines
}

export interface InstallFacts {
  readonly manifest: AdapterManifest
  readonly hash: string
  readonly files: Readonly<Record<string, string>>
  /** The approved version this replaces, or null for a first install. */
  readonly previous: { readonly hash: string; readonly manifest: AdapterManifest } | null
  readonly source: ApprovalSubject<'adapter-install'>['source']
  /** It takes over a signed-in session or grants of the version it replaces. */
  readonly inheritsSession: boolean
  /** Not one of the app's own built-ins: before the sandbox ships, that means unsandboxed (B). */
  readonly unsandboxed: boolean
}

export function installSubject(facts: InstallFacts): ApprovalSubject<'adapter-install'> {
  const name = items([facts.manifest.name])[0] ?? facts.manifest.id
  return {
    adapterId: facts.manifest.id,
    adapterName: [...name].slice(0, 80).join(''),
    version: facts.manifest.version,
    adapterHash: facts.hash,
    packageHash: bundleHash(facts.files),
    previousHash: facts.previous?.hash ?? null,
    source: facts.source,
    inheritsSession: facts.inheritsSession,
    references: [],
    changes: permissionChanges(facts.previous?.manifest ?? null, facts.manifest, facts.unsandboxed),
    unsandboxed: facts.unsandboxed,
  }
}
