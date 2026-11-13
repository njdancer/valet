// Valet's checks on a draft (docs/authoring-tools.md#valets-checks), run on one in-memory copy of
// its files. Steps 1 and 2 (package rules, manifest, compile, describe in the sandbox) are the
// builder's: the same prepare an install uses, storing nothing. This file adds the names check,
// the lint, and runs the agent's cases. Every line it produces is Valet's own wording.

import type { AdapterManifest, PackageFiles } from '@valet/core'
import { declarationOnHost, describeDeclaration, hostAllowed, isDisplayText, sha256Hex } from '@valet/core'
import { CASE_FILE, type CaseRun, readCases } from './cases'

/** Words a tool title may not use: they'd tell the person what to think of it. */
const SAFETY_WORDS = /\b(safe|safely|harmless|read[- ]only|verified|approved|trusted|official|secure)\b/i
export const MAX_TITLE = 40

export interface Finding {
  readonly level: 'error' | 'caution'
  readonly check: 'package' | 'build' | 'names' | 'lint' | 'cases' | 'reproduction'
  readonly text: string
}

/** The site's registrable domain, without a public suffix list: the last two labels, or three under
 * a two-letter country code's com/net/org/co/gov/edu/ac. A heuristic for the lint and the card's
 * domain only; it never decides what a request may reach. */
export function siteDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.')
  if (labels.length <= 2) return labels.join('.')
  const tld = labels.at(-1) ?? ''
  const second = labels.at(-2) ?? ''
  const take = tld.length === 2 && /^(com|net|org|co|gov|edu|ac|id|asn)$/.test(second) ? 3 : 2
  return labels.slice(-take).join('.')
}

function hostOf(pattern: string): string {
  return pattern.replace(/^\*\./, '')
}

function within(host: string, domain: string): boolean {
  const h = hostOf(host).toLowerCase()
  return h === domain || h.endsWith(`.${domain}`)
}

/** Names the person sees: display text, short titles, no safety words, no taking another site's name. */
export function checkNames(
  manifest: AdapterManifest,
  installed: readonly { readonly id: string; readonly name: string }[],
): Finding[] {
  const out: Finding[] = []
  if (!isDisplayText(manifest.name) || manifest.name.length > 80)
    out.push({
      level: 'error',
      check: 'names',
      text: 'The adapter’s name has characters a card can’t show, or is over 80.',
    })
  for (const tool of manifest.tools) {
    if (!isDisplayText(tool.title))
      out.push({
        level: 'error',
        check: 'names',
        text: `${tool.name}’s title has characters a card can’t show.`,
      })
    if (tool.title.length > MAX_TITLE)
      out.push({
        level: 'error',
        check: 'names',
        text: `${tool.name}’s title is over ${MAX_TITLE} characters.`,
      })
    if (SAFETY_WORDS.test(tool.title))
      out.push({
        level: 'error',
        check: 'names',
        text: `${tool.name}’s title says how safe it is; titles say what it does.`,
      })
  }
  const fold = (s: string) =>
    s
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, '')
  for (const other of installed) {
    if (other.id === manifest.id) continue
    if (fold(other.name) === fold(manifest.name))
      out.push({
        level: 'error',
        check: 'names',
        text: `Another installed site is already called ${other.name}.`,
      })
  }
  return out
}

const EVALUATE_NETWORK =
  /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|RTCPeerConnection|EventSource)\b|import\s*\(|\.(src|href|action)\s*=|location\s*=|\.submit\s*\(/
/** An absolute URL at the start of a string literal: its host, then any literal path after it. */
const ABSOLUTE_URL = /['"`](https?:)?\/\/([a-z0-9.-]+)(\/[^'"`\s$?#]*)?/gi

/** Deterministic, heuristic lint. Findings are cautions for the card, never passes or blocks. */
export function lint(manifest: AdapterManifest, files: PackageFiles): Finding[] {
  const out: Finding[] = []
  const home = new URL(manifest.home).hostname
  const domain = siteDomain(home)
  const sources = Object.entries(files).filter(([path]) => path.startsWith('src/'))
  const hostsSeen = new Set<string>()
  const urlsSeen = new Set<string>()
  for (const [path, text] of sources) {
    for (const match of text.matchAll(ABSOLUTE_URL)) {
      const host = (match[2] ?? '').toLowerCase()
      if (host === '') continue
      const declared = hostAllowed(host, manifest.egress)
      if (!declared) {
        if (hostsSeen.has(host)) continue
        hostsSeen.add(host)
        out.push({
          level: 'caution',
          check: 'lint',
          text: `${path} names ${host}, which the manifest doesn’t let it reach: add it to egress.`,
        })
        continue
      }
      // On an egress host: a fetch there also needs a declared request whose path can start so.
      const prefix = match[3] ?? ''
      const key = `${host}${prefix}`
      if (urlsSeen.has(key)) continue
      urlsSeen.add(key)
      if (host === home && prefix.replace(/\/+$/, '') === '') continue
      if (!manifest.requests.some((r) => declarationOnHost(r, host) && pathCanStartWith(r.path, prefix)))
        out.push({
          level: 'caution',
          check: 'lint',
          text: `${path} names https://${clipText(key, 120)}, but no declared request reaches it: page.fetch there would be refused. Declare its path in requests (with "host": "${host}" if only that host serves it).`,
        })
    }
    if (/page\.(fetch|goto)\s*\(\s*`[^`]*\$\{[^}]*\binput\b/.test(text) && /https?:\/\/\$\{/.test(text))
      out.push({
        level: 'caution',
        check: 'lint',
        text: `${path} builds a request’s host from the tool’s input.`,
      })
    // The source given to page.evaluate: a string or template literal argument, or a function's text.
    for (const call of text.matchAll(/page\.evaluate\s*\(([\s\S]{0,2000}?)\)\s*[;,)\n]/g)) {
      if (EVALUATE_NETWORK.test(call[1] ?? '')) {
        out.push({
          level: 'caution',
          check: 'lint',
          text: `${path} runs page script that can send requests or navigate (look for fetch, src, href or submit).`,
        })
        break
      }
    }
  }
  for (const r of manifest.requests) {
    if (r.method.toUpperCase() !== 'GET' && r.purpose === 'read')
      out.push({
        level: 'caution',
        check: 'lint',
        text: `The adapter says ${describeDeclaration(r)} only reads. Valet can’t check that.`,
      })
  }
  for (const host of manifest.egress)
    if (!within(host, domain))
      out.push({ level: 'caution', check: 'lint', text: `Reaches ${host}, which isn’t part of ${domain}.` })
  for (const origin of manifest.navigation) {
    const h = new URL(origin).hostname
    if (!within(h, domain))
      out.push({
        level: 'caution',
        check: 'lint',
        text: `Opens pages on ${h}, which isn’t part of ${domain}.`,
      })
  }
  for (const [name, secret] of Object.entries(manifest.secrets))
    for (const origin of secret.origins) {
      const h = new URL(origin).hostname
      if (!within(h, domain))
        out.push({
          level: 'caution',
          check: 'lint',
          text: `Would type ${name} into ${h}, which isn’t part of ${domain}.`,
        })
    }
  const writes = manifest.requests.some((r) => r.purpose !== 'read')
  if (writes)
    for (const tool of manifest.tools)
      if (tool.sideEffect === 'read' && manifest.requests.length > 0 && hasNonReadNear(files, tool.name))
        out.push({
          level: 'caution',
          check: 'lint',
          text: `${tool.name} says it only reads, but the adapter declares requests that change things.`,
        })
  return out
}

/**
 * Whether some path `pattern` matches could begin with `prefix`, a literal path that tool code may
 * go on to extend (`/v0` before `/item/${id}.json`). Its last segment may be cut short.
 */
export function pathCanStartWith(pattern: string, prefix: string): boolean {
  const want =
    pattern
      .split('?')[0]
      ?.split('/')
      .filter((x) => x.length > 0) ?? []
  const parts = prefix.split('/')
  const open = !prefix.endsWith('/')
  const got = parts.filter((x) => x.length > 0)
  for (let i = 0; i < got.length; i++) {
    const w = want[i]
    const g = got[i] ?? ''
    if (w === undefined) return false
    if (w === '*' && i === want.length - 1) return true
    if (w.startsWith(':')) continue
    const last = open && i === got.length - 1
    if (last ? !w.toLowerCase().startsWith(g.toLowerCase()) : w.toLowerCase() !== g.toLowerCase())
      return false
  }
  return true
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Weak signal: a read tool whose file also mentions a non-GET method. */
function hasNonReadNear(files: PackageFiles, tool: string): boolean {
  return Object.entries(files).some(
    ([path, text]) =>
      path.startsWith('src/') &&
      text.includes(tool) &&
      /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(text),
  )
}

/** The cases' own requirements: every case passes, every tool has at least one that passes. */
export function caseFindings(manifest: AdapterManifest, run: CaseRun, onlyTool?: string): Finding[] {
  const out: Finding[] = []
  for (const p of run.problems) out.push({ level: 'error', check: 'cases', text: `${p.file}: ${p.problem}.` })
  const failed = run.results.filter((r) => !r.passed)
  if (failed.length > 0)
    out.push({
      level: 'error',
      check: 'cases',
      text: `${failed.length} of ${run.results.length} cases fail.`,
    })
  for (const tool of manifest.tools) {
    if (onlyTool !== undefined && tool.name !== onlyTool) continue
    if (!run.results.some((r) => r.tool === tool.name && r.passed && r.checksOutput))
      out.push({
        level: 'error',
        check: 'cases',
        text: `${tool.name} has no passing case that checks its output.`,
      })
  }
  const empty = run.results.filter((r) => r.emptyExpectation).length
  if (empty > 0)
    out.push({
      level: 'caution',
      check: 'cases',
      text: `${empty} cases expect output without checking any value in it.`,
    })
  return out
}

/** Version rules: an update's version must be greater than the installed one's. */
export function checkVersion(manifest: AdapterManifest, installed: AdapterManifest | null): Finding[] {
  if (installed === null) return []
  return compareVersions(manifest.version, installed.version) > 0
    ? []
    : [
        {
          level: 'error',
          check: 'names',
          text: `The version must be greater than ${installed.version}, the one installed.`,
        },
      ]
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Fixtures the passing cases used, split by whether Valet recorded them as they are now. */
export function fixtureProvenance(
  run: CaseRun,
  files: PackageFiles,
  recorded: Readonly<Record<string, string>>,
): { recordedByValet: number; writtenByAgent: number } {
  const used = new Set(run.results.flatMap((r) => r.fixtures))
  let byValet = 0
  for (const path of used)
    if (recorded[path] !== undefined && recorded[path] === sha256Hex(files[path] ?? '')) byValet++
  return { recordedByValet: byValet, writtenByAgent: used.size - byValet }
}

export function caseFileCount(files: PackageFiles): number {
  return Object.keys(files).filter((p) => CASE_FILE.test(p)).length
}

export { readCases }
