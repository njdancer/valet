import axe from 'axe-core'
import { expect } from 'vitest'

/**
 * Runs axe on a rendered tree. Colour contrast is off here (jsdom has no layout or computed colour);
 * the token contrast test and the gallery's Playwright axe run cover it in a real browser.
 */
export async function expectAccessible(node: Element = document.body): Promise<void> {
  const result = await axe.run(node, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  const problems = result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  )
  expect(problems).toEqual([])
}
