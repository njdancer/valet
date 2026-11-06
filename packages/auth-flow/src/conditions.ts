// Conditions for waitFor and when. They only ever read the page through AuthPage, which takes
// selectors and text as data; nothing here evaluates script.

import { type AuthPage, type AuthStep, type Condition, SiteAdapterError } from '@siteadapter/core'

export async function evaluateCondition(page: AuthPage, condition: Condition): Promise<boolean> {
  if ('visible' in condition) return (await page.inspect(condition.visible))?.visible === true
  if ('urlMatches' in condition) return urlMatches(page.currentUrl(), condition.urlMatches)
  if ('textPresent' in condition) return page.textPresent(condition.textPresent)
  if ('not' in condition) return !(await evaluateCondition(page, condition.not))
  if ('any' in condition) {
    for (const inner of condition.any) {
      if (await evaluateCondition(page, inner)) return true
    }
    return false
  }
  for (const inner of condition.all) {
    if (!(await evaluateCondition(page, inner))) return false
  }
  return true
}

/**
 * The longest path and query a regular expression is run against. The regex runs synchronously in
 * the main process on a URL the site chose, and this engine backtracks, so the input is bounded;
 * a longer URL simply doesn't match a regex. Substring patterns have no such limit.
 */
export const MAX_REGEX_INPUT = 2048

/**
 * Matches against the URL's path and query only, so that a pattern can't be satisfied by the host
 * (the navigation allowlist covers hosts). A pattern wrapped in slashes, like `/^\/account/`, is a
 * regular expression; anything else is a substring.
 */
export function urlMatches(url: string, pattern: string): boolean {
  let target: string
  try {
    const parsed = new URL(url)
    target = parsed.pathname + parsed.search
  } catch {
    return false
  }
  const regex = asRegex(pattern)
  if (regex === null) return target.includes(pattern)
  return target.length <= MAX_REGEX_INPUT && regex.test(target)
}

/**
 * True when every urlMatches pattern anywhere in the steps, in every branch, compiles. The flow
 * checks this before its first step, so that a bad pattern fails the manifest up front.
 */
export function patternsValid(steps: readonly AuthStep[]): boolean {
  try {
    for (const condition of conditionsIn(steps)) checkCondition(condition)
    return true
  } catch {
    return false
  }
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

function checkCondition(condition: Condition): void {
  if ('urlMatches' in condition) asRegex(condition.urlMatches)
  if ('not' in condition) checkCondition(condition.not)
  if ('any' in condition) for (const inner of condition.any) checkCondition(inner)
  if ('all' in condition) for (const inner of condition.all) checkCondition(inner)
}

function asRegex(pattern: string): RegExp | null {
  if (pattern.length < 3 || !pattern.startsWith('/') || !pattern.endsWith('/')) return null
  try {
    return new RegExp(pattern.slice(1, -1))
  } catch {
    throw new SiteAdapterError('manifest', 'invalid')
  }
}
