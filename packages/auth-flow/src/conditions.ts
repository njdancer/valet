// Conditions for waitFor and when. They only ever read the page through AuthPage, which takes
// selectors and text as data; nothing here evaluates script.

import { type AuthPage, type Condition, SiteAdapterError } from '@siteadapter/core'

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
  return regex === null ? target.includes(pattern) : regex.test(target)
}

function asRegex(pattern: string): RegExp | null {
  if (pattern.length < 3 || !pattern.startsWith('/') || !pattern.endsWith('/')) return null
  try {
    return new RegExp(pattern.slice(1, -1))
  } catch {
    throw new SiteAdapterError('manifest', 'invalid')
  }
}
