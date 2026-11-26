// The agents' browser over real Electron (docs/agent-browser.md): Playwright's own snapshot with
// refs, and the trusted input an agent sends with them.

import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchHarness, scenario } from './launch'

let app: ElectronApplication

test.beforeAll(async () => {
  app = await launchHarness()
})

test.afterAll(async () => {
  await app?.close()
})

test('reads a page as Playwright MCP does and acts on it with trusted input', async () => {
  const r = (await scenario(app, 'aria')) as Record<string, unknown> & {
    first: string
    results: { url: string; yaml: string; previous: string | null }
    waited: { met: boolean; yaml: string }
  }
  expect(r.first).toMatch(/- heading "Agent page" \[level=1\] \[ref=e\d+\]/)
  expect(r.first).toMatch(/- searchbox "Search" \[ref=e\d+\]: old/)
  // Links carry absolute URLs.
  expect(r.first).toMatch(/- \/url: https:\/\/site\.test:\d+\/scratch-next\n/)
  expect(r.sameRefs).toBe(true)
  expect(r.againPrevious).toBe(true)
  expect(String(r.found)).toContain('button "Twice"')
  expect(r.live).toContain('keys:abc')
  expect(r.select).toContain('chosen: l')
  expect(r.dbl).toContain('doubles: 1')
  expect(r.ctx).toContain('menus: 1')
  expect(r.hover).toContain('hovered: yes')
  expect(r.drag).toContain('dropped: yes')
  // What the page scrolled past is still on it.
  expect(r.pressed).toContain('heading "Agent page"')
  expect(r.covered).toMatch(/covers that element/)
  expect(r.password).toMatch(/password or code/)
  expect(r.badKey).toMatch(/doesn’t know that key/)
  expect(r.pressed).toContain('pressed: Shift+Tab')
  expect(r.waited.met).toBe(true)
  expect(r.waited.yaml).toContain('Late arrival')
  expect(r.notYet).toBe(false)
  // Filled with submit: the old text replaced, Enter sent the form.
  expect(r.results.url).toContain('/agent-results?q=MSFT+shares')
  expect(r.results.yaml).toContain('Results for MSFT shares')
  expect(r.results.previous).toBeNull()
  expect(r.stale).toMatch(/page changed/)
  expect(r.partial).toContain('Results for')
})

test('Playwright’s snapshot leaves out every kind of hidden text a page aims at an agent', async () => {
  const { yaml } = (await scenario(app, 'hostileAria')) as { yaml: string }
  expect(yaml).toContain('VISIBLE-1')
  expect(yaml).toContain('VISIBLE-2')
  expect(yaml.match(/HIDDEN-[a-z]+/g) ?? []).toEqual([])
  expect(yaml).toMatch(/button "Buy"/)
  // An icon link: its picture's alt names it.
  expect(yaml).toMatch(/- link \[ref=e\d+\] \[cursor=pointer\]:\n(.*\n)*?\s+- img "Cart"/)
})

test('in a session, forms post, back goes back, checkboxes tick, the window resizes, pictures, uploads and downloads work', async () => {
  const r = (await scenario(app, 'session')) as Record<string, unknown>
  expect(r.ticked).toMatch(/checkbox "Agree" \[checked\]/)
  expect(r.again).toBe(true)
  expect(r.unticked).toMatch(/checkbox "Agree" (\[active\] )?\[ref=e\d+\]/)
  expect(r.unticked).not.toMatch(/checkbox "Agree" \[checked\]/)
  expect(r.notBox).toMatch(/isn’t a checkbox/)
  expect(String(r.narrow)).toContain('/agent')
  // Pictures: the window, the whole page (taller, past the spacer) and one 120x60 element.
  const shot = (k: string) => r[k] as { png: string; width: number; height: number }
  expect(shot('windowShot').png).toBe('PNG')
  expect(shot('fullShot').height).toBeGreaterThan(3000)
  expect(shot('fullShot').height).toBeGreaterThan(shot('windowShot').height)
  expect(shot('elementShot')).toEqual({ png: 'PNG', width: 120, height: 60 })
  // Files into a hidden file input: the page reads them, as from its dialog.
  expect(r.uploaded).toContain('uploaded: a.txt=first,b.txt=second')
  expect(r.notInput).toMatch(/isn’t a file input/)
  // A download is kept in memory, named safely, and the page stays where it was.
  expect(r.download).toEqual({ name: '_report.csv', mimeType: 'text/csv', text: 'a,b\n1,2\n' })
  expect(String(r.stillOn)).toMatch(/\/agent$/)
  expect(r.posted).toBe(1)
  expect(String(r.back)).toMatch(/\/scratch$/)
})
