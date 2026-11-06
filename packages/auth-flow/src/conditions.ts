// Conditions for waitFor and when. They only ever read the page through AuthPage, which takes
// selectors and text as data; nothing here evaluates script.

import {
  type AuthPage,
  type AuthStep,
  type Condition,
  isScreenedPattern,
  SiteAdapterError,
} from '@siteadapter/core'
import type { UrlPatternMatcher } from './url-matcher'

/** Every urlRegex pattern in a flow, screened before its first step, and what runs them. */
export interface UrlRegexes {
  readonly patterns: ReadonlySet<string>
  readonly matcher: UrlPatternMatcher
}

export async function evaluateCondition(
  page: AuthPage,
  condition: Condition,
  regexes: UrlRegexes,
): Promise<boolean> {
  if ('visible' in condition) return (await page.inspect(condition.visible))?.visible === true
  if ('urlContains' in condition) return urlContains(page.currentUrl(), condition.urlContains)
  if ('urlRegex' in condition) {
    // compileUrlRegexes saw every condition in the flow; one it didn't is not from this manifest.
    if (!regexes.patterns.has(condition.urlRegex)) throw new SiteAdapterError('manifest', 'invalid')
    return urlRegexMatches(page.currentUrl(), condition.urlRegex, regexes.matcher)
  }
  if ('textPresent' in condition) return page.textPresent(condition.textPresent)
  if ('not' in condition) return !(await evaluateCondition(page, condition.not, regexes))
  if ('any' in condition) {
    for (const inner of condition.any) {
      if (await evaluateCondition(page, inner, regexes)) return true
    }
    return false
  }
  for (const inner of condition.all) {
    if (!(await evaluateCondition(page, inner, regexes))) return false
  }
  return true
}

/**
 * The longest path and query a regular expression is run against; a longer URL simply doesn't
 * match. The worker's deadline is what bounds a slow pattern; this keeps what crosses to the worker
 * small, and keeps an honest pattern well inside the deadline.
 */
export const MAX_REGEX_INPUT = 2048

/**
 * The URL's path and query, which is all a condition may look at: never the host (the navigation
 * allowlist covers hosts, and a pattern must not be satisfiable by an attacker's domain), and never
 * the fragment. Null for a URL that doesn't parse.
 */
function pathAndQuery(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return null
  }
}

/** True when the URL's path and query contain `text`. A substring test can't backtrack. */
export function urlContains(url: string, text: string): boolean {
  return pathAndQuery(url)?.includes(text) ?? false
}

/**
 * True when the URL's path and query match `pattern`, if they are short enough to try. The pattern
 * runs in `matcher`'s worker, never on this thread.
 */
export async function urlRegexMatches(
  url: string,
  pattern: string,
  matcher: UrlPatternMatcher,
): Promise<boolean> {
  const target = pathAndQuery(url)
  if (target === null || target.length > MAX_REGEX_INPUT) return false
  return (await matcher.test(pattern, target)) === true
}

/**
 * Every urlRegex anywhere in the steps, in every branch, or null if any fails to compile or to pass
 * core's backtracking screen. The manifest schema screens them already; this runs again because the
 * flow can't know its manifest was parsed, and because a bad pattern in a branch the flow rarely
 * takes would otherwise only fail mid-flow, perhaps after secrets were typed. Compiling is cheap
 * and happens here; matching, which is not, happens in the worker.
 */
export function compileUrlRegexes(steps: readonly AuthStep[]): Set<string> | null {
  const patterns = new Set<string>()
  for (const pattern of urlRegexesIn(conditionsIn(steps))) {
    if (patterns.has(pattern)) continue
    if (typeof pattern !== 'string' || !isScreenedPattern(pattern)) return null
    patterns.add(pattern)
  }
  return patterns
}

function conditionsIn(steps: readonly AuthStep[]): Condition[] {
  const conditions: Condition[] = []
  for (const step of steps) {
    if (step.op === 'waitFor') conditions.push(step.condition)
    if (step.op === 'when') {
      conditions.push(step.condition, ...conditionsIn(step.steps), ...conditionsIn(step.otherwise ?? []))
    }
    if (step.op === 'retry') conditions.push(...conditionsIn(step.steps))
  }
  return conditions
}

function urlRegexesIn(conditions: readonly Condition[]): string[] {
  const patterns: string[] = []
  for (const condition of conditions) {
    if ('urlRegex' in condition) patterns.push(condition.urlRegex)
    if ('not' in condition) patterns.push(...urlRegexesIn([condition.not]))
    if ('any' in condition) patterns.push(...urlRegexesIn(condition.any))
    if ('all' in condition) patterns.push(...urlRegexesIn(condition.all))
  }
  return patterns
}
