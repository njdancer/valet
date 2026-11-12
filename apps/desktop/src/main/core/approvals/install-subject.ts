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
  sandboxPermissionChanges,
} from '@valet/core'
import type { ListDiff } from '../../../shared/api'
import { permissionDiff } from '../permission-diff'

type Area = PermissionChange['area']

const MAX_LINES = 200
const MAX_ITEMS = 50

/** Characters a card can't show as they are; each is written out as its code instead. */
const UNSHOWABLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Me}\p{Variation_Selector}\u115F\u1160\u3164\uFFA0\u2800\u180E\u17B4\u17B5\uFDFD\uFDFA\uFDFB\u2E3B]/u

const code = (c: string) => `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`

/**
 * A value as display text, never dropped: anything unprintable or invisible is written out as its
 * code, so a request path with a hidden character still shows (and shows that it has one).
 */
export function showable(value: string): string {
  let out = ''
  let marks = 0
  for (const c of value) {
    const mark = /\p{M}/u.test(c)
    marks = mark ? marks + 1 : 0
    if (UNSHOWABLE.test(c) || (mark && marks > 2)) out += code(c)
    else if (/\s/u.test(c)) out += ' '
    else out += c
  }
  out = out.replace(/ {2,}/g, ' ').trim()
  if (isDisplayText(out)) return out
  // A mark with nothing to sit on, say: every character outside printable ASCII as its code.
  const ascii = [...out].map((c) => (/^[\x21-\x7E ]$/.test(c) ? c : code(c))).join('')
  return ascii.trim() === '' ? '(blank)' : ascii
}

/** Cut to `max` UTF-16 units (what the subject's schema counts), never inside a character. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value
  let out = ''
  for (const c of value) {
    if (out.length + c.length > max - 1) break
    out += c
  }
  return `${out.trimEnd()}…`
}

/** What a line shows of one value: the text, cut if long, and a suffix that is never cut. */
type Shown = string | readonly [text: string, suffix: string]

/** One line's items, as display text, at most 200 characters each; past 50, a count of the rest. */
function items(values: readonly Shown[]): string[] {
  const out: string[] = []
  for (const value of values) {
    if (out.length === MAX_ITEMS - 1 && values.length > MAX_ITEMS) {
      out.push(`and ${values.length - out.length} more not shown`)
      break
    }
    const [text, suffix] = typeof value === 'string' ? [value, ''] : value
    const tail = suffix === '' ? '' : ` ${showable(suffix)}`
    out.push(cut(showable(text), 200 - tail.length) + tail)
  }
  return out
}

/**
 * The Mac's permission diff from `before` (null for a first install) to `after`, as B's lines.
 * Additions carry the area's risk; removals are low. `unsandboxed` (how this version would run
 * here) adds the critical sandbox-mode line, which makes the request Mac only (approvableOn).
 */
export function permissionChanges(
  before: AdapterManifest | null,
  after: AdapterManifest,
  unsandboxed: boolean,
): PermissionChange[] {
  const diff = permissionDiff(before, after)
  const lines: PermissionChange[] = []
  const push = (area: Area, change: PermissionChange['change'], values: readonly Shown[], risk: Risk) => {
    const kept = items(values)
    if (kept.length > 0 && lines.length < MAX_LINES) lines.push({ area, change, items: kept, risk })
  }
  const list = <T>(area: Area, d: ListDiff<T>, show: (t: T) => Shown, risk: Risk | ((t: T) => Risk)) => {
    const riskOf = typeof risk === 'function' ? risk : () => risk
    for (const level of ['critical', 'high', 'medium', 'low'] as const) {
      push(area, 'added', d.added.filter((t) => riskOf(t) === level).map(show), level)
    }
    push(area, 'removed', d.removed.map(show), 'low')
  }
  // The sandbox's own lines (docs/sandbox.md#the-permission-diff): becoming unsandboxed, and each
  // exception at its own risk. A version that runs unsandboxed always carries the critical line,
  // even when the one it replaces did too, so its request is Mac only every time.
  const sandbox = sandboxPermissionChanges(before === null ? null : (before.sandbox ?? null), after.sandbox)
  if (unsandboxed && !sandbox.some((c) => c.area === 'sandbox-mode' && c.risk === 'critical'))
    push('sandbox-mode', 'added', ['Runs without the sandbox: it can do anything you can'], 'critical')
  for (const change of sandbox) push(change.area, change.change, change.items, change.risk)
  list('navigation', diff.navigation, (o) => o, 'medium')
  list('egress', diff.egress, (o) => o, 'medium')
  list('auth-frames', diff.frameOrigins, (o) => o, 'high')
  list('session-cookies', diff.cookieDomains, (d) => d, 'high')
  list('session-storage', diff.storage, (s) => `${s.origin} ${s.key}`, 'high')
  list(
    'requests',
    diff.requests,
    (r) => [`${r.method} ${r.path}`, `(${r.purpose})`],
    (r) => (r.purpose === 'irreversible' ? 'high' : r.purpose === 'write' ? 'medium' : 'low'),
  )
  list(
    'tool',
    diff.tools,
    (t) => [t.name, `(${t.sideEffect})`],
    (t) => (t.sideEffect === 'irreversible' ? 'high' : t.sideEffect === 'write' ? 'medium' : 'low'),
  )
  // Where a secret may be typed is the part that matters, so its origins are always shown.
  list(
    'secret',
    diff.secrets,
    (s) => [`${s.name}: ${s.fields.join(', ')}`, `into ${s.origins.join(', ')}`],
    'high',
  )
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
  const name = showable(facts.manifest.name)
  return {
    adapterId: facts.manifest.id,
    adapterName: cut(name, 80),
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
