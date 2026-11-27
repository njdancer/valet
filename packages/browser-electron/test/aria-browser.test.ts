// The agents' browser engine in ScratchBrowser (src/scratch.ts), over the fake platform. Playwright's
// injected script needs a real layout engine, so here each page script is answered by the test
// and what is checked is the plumbing: booting, refs and errors, trusted input, waits and scrubbing.
// What the scripts do in a real page is covered by e2e/aria.spec.ts.

import { describe, expect, it } from 'vitest'
import { ariaBootedScript, ariaBootScript } from '../src/aria'
import type { FrameHandle, Timers } from '../src/platform'
import { SCRATCH_LIMITS, ScratchBrowser, type ScratchRules } from '../src/scratch'
import { pageFieldsScript } from '../src/sensitive-page'
import { type FakeFrame, FakePlatform, FakeSurface } from './fake-browser'

type Kind =
  | 'snapshot'
  | 'point'
  | 'field'
  | 'select'
  | 'text'
  | 'checked'
  | 'upload'
  | 'box'
  | 'mark'
  | 'storage'
  | 'fields'
type Answer = (kind: Kind, args: Record<string, unknown> | string) => unknown

const MARKERS: [Kind, string][] = [
  ['snapshot', 'ariaSnapshot(root'],
  ['point', 'elementFromPoint'],
  ['field', 'v.fill(el'],
  ['select', 'selectOptions(found'],
  ['text', "innerText || ''"],
  ['checked', "elementState(found, 'checked')"],
  ['upload', 'v.setInputFiles(el'],
  ['box', 'found.getBoundingClientRect()'],
  ['mark', 'found.setAttribute(args.attribute'],
  ['storage', "read('localStorage')"],
]

/** Timers that fire at once, so settling and waiting take no real time. */
const instant: Timers & { waited: number } = {
  waited: 0,
  setTimeout(callback, ms) {
    instant.waited += ms
    return setImmediate(callback)
  },
  clearTimeout(handle) {
    clearImmediate(handle as NodeJS.Immediate)
  },
}

const PAGE = `- heading "Shop" [level=1] [ref=e1]
- link "Deals" [ref=e2] [cursor=pointer]:
  - /url: /deals?x=1
- link "Help" [ref=e3]:
  - /url: "https://help.example.com/a b"
- textbox "Search" [ref=e4]`

function stubFrame(answer: Answer): FrameHandle & { boots: number; scripts: string[] } {
  let booted = false
  const frame = {
    boots: 0,
    scripts: [] as string[],
    id: 'f1',
    nodeId: 'n1',
    origin: 'https://shop.example.com',
    url: 'https://shop.example.com/',
    parentIndex: null,
    receivesInput: true,
    run: async (code: string) => {
      if (code === ariaBootedScript()) return booted
      if (code === ariaBootScript()) {
        booted = true
        frame.boots++
        return true
      }
      if (code === pageFieldsScript) return answer('fields', {})
      const kind = MARKERS.find(([, marker]) => code.includes(marker))?.[0]
      if (kind === undefined) throw new Error('unknown script')
      frame.scripts.push(kind)
      if (kind === 'storage') return answer(kind, {})
      const json = code.slice(code.lastIndexOf(')(') + 2, -1)
      const args = JSON.parse(`[${json}]`) as (Record<string, unknown> | string)[]
      return answer(kind, args.length === 1 ? (args[0] as Record<string, unknown> | string) : { args })
    },
    runAdapter: async () => {
      throw new Error('no adapter code here')
    },
  }
  return frame
}

const point = { x: 10, y: 20, covered: false, tag: 'button', inputType: null, autocomplete: '', name: ' ' }

function defaults(kind: Kind): unknown {
  if (kind === 'snapshot') return { url: 'https://shop.example.com/home', title: 'Shop', yaml: PAGE }
  if (kind === 'point') return point
  if (kind === 'field') return { done: false, focused: true }
  if (kind === 'select') return { selected: ['l'] }
  if (kind === 'text') return true
  if (kind === 'checked') return { checked: false }
  if (kind === 'upload') return { done: true }
  if (kind === 'box') return { x: 5, y: 900, width: 120, height: 40 }
  if (kind === 'mark') return { done: true }
  if (kind === 'storage')
    return {
      origin: 'https://shop.example.com',
      local: [
        ['k', 'v'],
        [1, 2],
      ],
      session: 'nope',
    }
  return { url: 'https://shop.example.com/home', fields: [] }
}

async function open(answer: Answer = defaults, overrides: Partial<ScratchRules> = {}) {
  const platform = new FakePlatform()
  const frame = stubFrame(answer)
  platform.makeSurface = (partition) => new FakeSurface(partition, [frame as unknown as FakeFrame])
  const typed: string[] = []
  const browser = await ScratchBrowser.open({
    platform,
    partition: 'scratch:ag-abcdefghij',
    rules: {
      mayNavigate: () => true,
      mayRequest: () => true,
      pace: async () => undefined,
      blocked: () => undefined,
      mayType: (text) => {
        typed.push(text)
        return text !== 'known-secret'
      },
      ...overrides,
    },
    timers: instant,
  })
  const surface = platform.surfaces[0] as FakeSurface
  const session = platform.session('scratch:ag-abcdefghij')
  return { browser, frame, surface, session, typed, platform }
}

const detail = (work: Promise<unknown>) =>
  work.then(
    () => 'ok',
    (e: { detail?: string }) => e.detail ?? 'no detail',
  )

describe('the agents’ snapshot', () => {
  it('boots Playwright’s script once per document and gives its YAML with absolute links', async () => {
    const { browser, frame } = await open()
    const first = await browser.ariaSnapshot()
    expect(first.url).toBe('https://shop.example.com/home')
    expect(first.title).toBe('Shop')
    expect(first.yaml).toContain('- /url: https://shop.example.com/deals?x=1')
    // Already absolute, but as a browser would send it.
    expect(first.yaml).toContain('- /url: https://help.example.com/a%20b')
    expect(first.previous).toBeNull()
    expect(first.cut).toBe(false)
    const second = await browser.ariaSnapshot()
    expect(second.previous).toBe(first.yaml)
    expect(frame.boots).toBe(1)
  })

  it('quotes an absolute link YAML would misread, and keeps a line it can’t resolve', async () => {
    const yaml = "- link:\n  - /url: \"/a #b\"\n- link:\n  - /url: '/it''s'\n- link:\n  - /url: \"broken"
    const { browser } = await open((kind) =>
      kind === 'snapshot' ? { url: 'not a url', title: '', yaml } : defaults(kind),
    )
    expect((await browser.ariaSnapshot()).yaml).toBe(yaml)
    const { browser: other } = await open((kind) =>
      kind === 'snapshot' ? { url: 'https://s.example.com/', title: '', yaml } : defaults(kind),
    )
    const out = (await other.ariaSnapshot()).yaml
    expect(out).toContain('- /url: "https://s.example.com/a%20#b"')
    expect(out).toContain('- /url: "https://s.example.com/it\'s"')
    expect(out).toContain('- /url: https://s.example.com/%22broken')
  })

  it('replaces cookie values, and cuts a snapshot too long to send', async () => {
    const long = Array.from({ length: 20_000 }, (_, i) => `- text: line ${i} cookie-value-777`).join('\n')
    const { browser, session } = await open((kind) =>
      kind === 'snapshot'
        ? { url: 'https://shop.example.com/?t=cookie-value-777', title: 'x', yaml: long }
        : defaults(kind),
    )
    for (const listener of session.cookieListeners)
      listener({ name: 'sid', value: 'cookie-value-777', sameSite: 'lax' })
    const page = await browser.ariaSnapshot()
    expect(page.cut).toBe(true)
    expect(page.yaml.length).toBeLessThanOrEqual(SCRATCH_LIMITS.snapshotChars)
    expect(page.yaml).not.toContain('cookie-value-777')
    expect(page.url).toBe('https://shop.example.com/?t=[cookie]')
  })

  it('reads one element or a few levels, without making that the page to compare with', async () => {
    const seen: unknown[] = []
    const { browser } = await open((kind, args) => {
      if (kind === 'snapshot') seen.push(args)
      return defaults(kind)
    })
    await browser.ariaSnapshot({ target: 'e2', depth: 0 })
    await browser.ariaSnapshot({ depth: 1e6 })
    expect(seen).toEqual([
      { target: 'e2', depth: 1 },
      { target: null, depth: SCRATCH_LIMITS.snapshotDepth },
    ])
    expect((await browser.ariaSnapshot()).previous).toBeNull()
  })

  it('says why a target can’t be read', async () => {
    for (const [error, words] of [
      ['stale', /page changed/],
      ['invalid-selector', /valid selector/],
      ['not-found', /Nothing on the page/],
      ['hidden', /isn’t visible/],
      ['odd', /could not be read/],
    ] as const) {
      const { browser } = await open((kind) => (kind === 'snapshot' ? { error } : defaults(kind)))
      expect(await detail(browser.ariaSnapshot({ target: '#x' }))).toMatch(words)
    }
    const { browser } = await open((kind) => (kind === 'snapshot' ? null : defaults(kind)))
    expect(await detail(browser.ariaSnapshot())).toMatch(/could not be read/)
    expect(await detail(browser.ariaSnapshot({ target: '' }))).toMatch(/ref or a valid selector/)
    expect(await detail(browser.ariaSnapshot({ target: 'x'.repeat(501) }))).toMatch(/ref or a valid selector/)
  })

  it('finds lines by text or pattern, each under its path', async () => {
    const { browser } = await open()
    expect((await browser.find({ text: ' deals ' })).matches).toEqual([
      '- link "Deals" [ref=e2] [cursor=pointer]:',
      '- link "Deals" [ref=e2] [cursor=pointer]: > - /url: https://shop.example.com/deals?x=1',
    ])
    expect((await browser.find({ regex: 'text(box)?' })).matches).toEqual(['- textbox "Search" [ref=e4]'])
    expect(await detail(browser.find({ regex: '(' }))).toMatch(/regular expression/)
    expect(await detail(browser.find({ regex: '' }))).toMatch(/too long/)
    expect(await detail(browser.find({ text: '  ' }))).toMatch(/Give some text/)
  })

  it('closes a signed-in browser that reaches a page a grant never shows', async () => {
    const platform = new FakePlatform()
    const frame = stubFrame((kind) =>
      kind === 'fields'
        ? {
            url: 'https://shop.example.com/account/password',
            fields: [{ type: 'password', autocomplete: 'new-password', name: 'pw' }],
          }
        : defaults(kind),
    )
    platform.makeSurface = (partition) => new FakeSurface(partition, [frame as unknown as FakeFrame])
    const browser = await ScratchBrowser.open({
      platform,
      partition: 'scratch:ag-abcdefghij',
      rules: {
        mayNavigate: () => true,
        mayRequest: () => true,
        pace: async () => undefined,
        blocked: () => undefined,
        mayType: () => true,
        signedIn: { adapterId: 'shop', cookieDomains: ['shop.example.com'] },
      },
      timers: instant,
    })
    expect(await detail(browser.ariaSnapshot())).toMatch(/closed the signed-in browser/)
    expect(browser.isClosed()).toBe(true)
  })
})

describe('the agents’ input', () => {
  it('clicks as a mouse does, twice or with another button and keys held', async () => {
    const { browser, surface } = await open()
    await browser.clickElement('e2')
    await browser.clickElement('e2', { doubleClick: true, button: 'right', modifiers: ['shift'] })
    expect(surface.mice.map((m) => `${m.type}:${m.button ?? ''}:${m.clickCount ?? ''}`)).toEqual([
      'move::',
      'down:left:1',
      'up:left:1',
      'move::',
      'down:right:1',
      'up:right:1',
      'down:right:2',
      'up:right:2',
    ])
    expect(surface.mice[4]?.modifiers).toEqual(['shift'])
    expect(surface.focusCalls).toBe(2)
  })

  it('won’t click what is covered, hidden or gone', async () => {
    const answers = [{ ...point, covered: true }, { error: 'hidden' }, null, { error: 'stale' }, { x: 'no' }]
    for (const answer of answers) {
      const { browser, surface } = await open((kind) => (kind === 'point' ? answer : defaults(kind)))
      expect(await detail(browser.clickElement('e9'))).not.toBe('ok')
      expect(surface.mice).toEqual([])
    }
  })

  it('hovers, and drags from one element to another in steps', async () => {
    const points = [point, point, { ...point, x: 100, y: 70 }]
    const { browser, surface } = await open((kind) => (kind === 'point' ? points.shift() : defaults(kind)))
    await browser.hover('e1')
    await browser.drag('e1', 'e3')
    expect(surface.mice[0]).toEqual({ type: 'move', x: 10, y: 20 })
    const drag = surface.mice.slice(1)
    expect(drag[1]?.type).toBe('down')
    expect(drag.filter((m) => m.type === 'move')).toHaveLength(1 + SCRATCH_LIMITS.dragSteps)
    expect(drag.at(-1)).toMatchObject({ type: 'up', x: 100 })
  })

  it('finds both ends before pressing, so nothing scrolls the page mid-drag', async () => {
    const asked: unknown[] = []
    const { browser, surface } = await open((kind, args) => {
      if (kind !== 'point') return defaults(kind)
      asked.push((args as { args: unknown[] }).args)
      return asked.length === 1 ? point : { ...point, x: 100, y: 70 }
    })
    await browser.drag('e1', 'e3')
    // The source is scrolled to the middle; the target is only measured where it now is.
    expect(asked).toEqual([
      ['e1', 'center'],
      ['e3', 'none'],
    ])
    expect(surface.mice[0]).toEqual({ type: 'move', x: 10, y: 20 })
    expect(surface.mice[1]).toEqual({ type: 'down', x: 10, y: 20 })
    expect(surface.mice.at(-1)).toEqual({ type: 'up', x: 100, y: 70 })
  })

  it('brings an off-screen drop target into view, then measures the source again', async () => {
    const asked: unknown[] = []
    const answers = [point, { ...point, inView: false }, { ...point, x: 100, y: 600 }, { ...point, y: 5 }]
    const { browser, surface } = await open((kind, args) => {
      if (kind !== 'point') return defaults(kind)
      asked.push((args as { args: unknown[] }).args)
      return answers.shift()
    })
    await browser.drag('e1', 'e3')
    expect(asked).toEqual([
      ['e1', 'center'],
      ['e3', 'none'],
      ['e3', 'nearest'],
      ['e1', 'none'],
    ])
    expect(surface.mice[1]).toEqual({ type: 'down', x: 10, y: 5 })
    expect(surface.mice.at(-1)).toEqual({ type: 'up', x: 100, y: 600 })
  })

  it('won’t drag between two elements that can’t both be on screen', async () => {
    const answers = [point, { ...point, inView: false }, point, { ...point, inView: false }]
    const { browser, surface } = await open((kind) => (kind === 'point' ? answers.shift() : defaults(kind)))
    expect(await detail(browser.drag('e1', 'e3'))).toMatch(/too far apart/)
    expect(surface.mice).toEqual([])
  })

  it('presses nothing when the drop target can’t be found', async () => {
    let n = 0
    const { browser, surface } = await open((kind) =>
      kind === 'point' ? (n++ === 0 ? point : { error: 'stale' }) : defaults(kind),
    )
    expect(await detail(browser.drag('e1', 'e9'))).toMatch(/page changed/)
    expect(surface.mice).toEqual([])
  })

  it('fills a field at once, clears it with an empty fill, types slowly, and submits', async () => {
    const fields: unknown[] = []
    const { browser, surface, typed } = await open((kind, args) => {
      if (kind === 'field') fields.push(args)
      return defaults(kind)
    })
    await browser.fill('e4', 'milk')
    await browser.fill('e4', '')
    await browser.fill('e4', 'ab', { slowly: true, submit: true })
    expect(fields).toEqual([
      { target: 'e4', value: 'milk', keep: false },
      { target: 'e4', value: '', keep: false },
      { target: 'e4', value: 'ab', keep: true },
    ])
    expect(surface.inserted).toEqual(['milk'])
    expect(surface.chars).toEqual(['a', 'b'])
    expect(surface.keys.map((k) => k.keyCode)).toEqual(['Delete', 'Enter'])
    expect(typed).toEqual(['milk', '', 'ab'])
  })

  it('sends nothing more for a field the page fills itself (a date, a colour)', async () => {
    const { browser, surface } = await open((kind) => (kind === 'field' ? { done: true } : defaults(kind)))
    await browser.fill('e4', '2026-11-26')
    expect(surface.inserted).toEqual([])
    expect(surface.keys).toEqual([])
  })

  it('refuses secrets, fields it can’t type in, and too much text', async () => {
    const cases: [unknown, RegExp][] = [
      [{ error: 'secret' }, /password or code/],
      [{ error: 'not-editable' }, /isn’t a field/],
      [{ error: 'cannot-fill', message: 'Input of type "file" cannot be filled' }, /cannot be filled/],
      [{ error: 'stale' }, /page changed/],
      [{ done: false, focused: false }, /moved focus/],
      [null, /could not be read/],
    ]
    for (const [answer, words] of cases) {
      const { browser, surface } = await open((kind) => (kind === 'field' ? answer : defaults(kind)))
      expect(await detail(browser.fill('e4', 'x'))).toMatch(words)
      expect(surface.inserted).toEqual([])
    }
    const { browser } = await open()
    expect(await detail(browser.fill('e4', 'known-secret'))).toMatch(/doesn’t type that/)
    expect(await detail(browser.fill('e4', 'x'.repeat(SCRATCH_LIMITS.fillChars + 1)))).toMatch(
      /than the browser fills/,
    )
    expect(
      await detail(browser.fill('e4', 'x'.repeat(SCRATCH_LIMITS.typeChars + 1), { slowly: true })),
    ).toMatch(/a key at a time/)
  })

  it('presses keys and combinations, and says when it doesn’t know one', async () => {
    const { browser, surface, typed } = await open()
    await browser.press('Shift+Tab')
    await browser.press('Enter')
    await browser.press('a')
    expect(surface.keys).toEqual([
      { keyCode: 'Tab', modifiers: ['shift'], char: null },
      { keyCode: 'Enter', modifiers: [], char: '\r' },
      { keyCode: 'a', modifiers: [], char: 'a' },
    ])
    // A character it types is checked like any text; Enter and Tab aren't text.
    expect(typed).toEqual(['a'])
    expect(await detail(browser.press('Hyper+Q'))).toMatch(/doesn’t know that key/)
    const refusing = await open(defaults, { mayType: () => false })
    expect(await detail(refusing.browser.press('k'))).toMatch(/doesn’t type that/)
  })

  it('chooses options, and says why it can’t', async () => {
    const seen: unknown[] = []
    const { browser } = await open((kind, args) => {
      if (kind === 'select') seen.push(args)
      return defaults(kind)
    })
    await browser.select('e5', ['Large'])
    expect(seen).toEqual([{ target: 'e5', values: ['Large'] }])
    expect(await detail(browser.select('e5', []))).toMatch(/between 1 and 50/)
    expect(await detail(browser.select('e5', ['x'.repeat(501)]))).toMatch(/between 1 and 50/)
    for (const [error, words] of [
      ['not-select', /isn’t a select/],
      ['no-option', /no option/],
      ['option-disabled', /disabled/],
      ['stale', /page changed/],
    ] as const) {
      const other = await open((kind) => (kind === 'select' ? { error } : defaults(kind)))
      expect(await detail(other.browser.select('e5', ['a']))).toMatch(words)
    }
    const empty = await open((kind) => (kind === 'select' ? null : defaults(kind)))
    expect(await detail(empty.browser.select('e5', ['a']))).toMatch(/could not be read/)
  })
})

describe('waiting', () => {
  it('waits for text to show or go, through a page mid-navigation', async () => {
    let polls = 0
    const { browser } = await open((kind) => {
      if (kind !== 'text') return defaults(kind)
      polls++
      if (polls === 1) throw new Error('no document yet')
      return polls >= 3
    })
    expect((await browser.waitFor({ text: 'Delivered' })).met).toBe(true)
    expect(polls).toBe(3)
    expect((await browser.waitFor({ textGone: 'Loading' })).met).toBe(false)
  })

  it('stops at the time limit, and waits a time when asked', async () => {
    const { browser } = await open((kind) => (kind === 'text' ? false : defaults(kind)))
    instant.waited = 0
    const result = await browser.waitFor({ text: 'Never', timeoutMs: 1e9 })
    expect(result.met).toBe(false)
    expect(instant.waited).toBeLessThan(SCRATCH_LIMITS.waitMs + 5000)
    instant.waited = 0
    expect((await browser.waitFor({ timeMs: 1e9 })).met).toBe(true)
    expect(instant.waited).toBeLessThan(SCRATCH_LIMITS.waitMs + 5000)
    expect(await detail(browser.waitFor({ text: ' ' }))).toMatch(/text to wait for/)
  })

  it('gives up when the browser closes while it waits', async () => {
    const { browser } = await open((kind) => {
      if (kind === 'text') {
        browser.close()
        throw new Error('gone')
      }
      return defaults(kind)
    })
    expect(await detail(browser.waitFor({ text: 'x' }))).toMatch(/closed/)
  })
})

describe('a session’s page', () => {
  it('opens a page and gives its snapshot, goes back, and resizes', async () => {
    const { browser, surface } = await open()
    const page = await browser.go('https://shop.example.com/')
    expect(page.yaml).toContain('heading "Shop"')
    expect(await detail(browser.back())).toMatch(/no page to go back to/)
    surface.history.push('https://shop.example.com/before')
    await browser.back()
    expect(surface.url()).toBe('https://shop.example.com/before')
    await browser.resize(800.4, 600)
    expect(surface.sizes).toEqual([{ width: 800, height: 600 }])
    expect(await detail(browser.resize(100, 600))).toMatch(/between 200 and 4000/)
    expect(await detail(browser.resize(Number.NaN, 600))).toMatch(/between 200 and 4000/)
  })

  it('ticks a box by clicking it, only when it isn’t so already', async () => {
    let checked = false
    const { browser, surface } = await open((kind) => (kind === 'checked' ? { checked } : defaults(kind)))
    await browser.check('#agree', true)
    expect(surface.mice.filter((m) => m.type === 'down')).toHaveLength(1)
    checked = true
    await browser.check('#agree', true)
    expect(surface.mice.filter((m) => m.type === 'down')).toHaveLength(1)
    for (const [answer, words] of [
      [{ error: 'not-checkbox' }, /isn’t a checkbox/],
      [{ error: 'stale' }, /page changed/],
      [null, /could not be read/],
    ] as const) {
      const other = await open((kind) => (kind === 'checked' ? answer : defaults(kind)))
      expect(await detail(other.browser.check('#x', true))).toMatch(words)
    }
  })

  it('pictures the window, the whole page or one element', async () => {
    const { browser, surface } = await open()
    const shot = await browser.screenshot()
    expect(shot.png).toEqual(Buffer.from('png'))
    await browser.screenshot({ fullPage: true })
    await browser.screenshot({ target: 'e1' })
    expect(surface.screenshots).toEqual([
      { fullPage: false, clip: null },
      { fullPage: true, clip: null },
      { fullPage: false, clip: { x: 5, y: 900, width: 120, height: 40 } },
    ])
    surface.picture = null
    expect(await detail(browser.screenshot())).toMatch(/couldn’t be pictured/)
    surface.picture = Buffer.alloc(SCRATCH_LIMITS.screenshotBytes + 1)
    expect(await detail(browser.screenshot())).toMatch(/too big/)
    for (const [answer, words] of [
      [{ error: 'hidden' }, /isn't visible|isn’t visible/],
      [{ x: 'a' }, /could not be read/],
      [null, /could not be read/],
    ] as const) {
      const other = await open((kind) => (kind === 'box' ? answer : defaults(kind)))
      expect(await detail(other.browser.screenshot({ target: '#x' }))).toMatch(words)
    }
  })

  it('puts files in a file input with safe names, within limits, and gives the page after', async () => {
    const seen: unknown[] = []
    const { browser } = await open((kind, args) => {
      if (kind === 'upload') seen.push(args)
      return defaults(kind)
    })
    const page = await browser.upload('e4', [
      { name: '..\\etc/passwd\n', mimeType: 'text/plain', data: Buffer.from('hi') },
      { name: '', mimeType: 'application/pdf', data: Buffer.from([0, 1]) },
    ])
    expect(page.yaml).toContain('heading "Shop"')
    expect(seen).toEqual([
      {
        target: 'e4',
        files: [
          { name: '.._etc_passwd_', mimeType: 'text/plain', buffer: Buffer.from('hi').toString('base64') },
          { name: 'file', mimeType: 'application/pdf', buffer: 'AAE=' },
        ],
      },
    ])
    expect(await detail(browser.upload('e4', []))).toMatch(/between 1 and 10/)
    const big = Buffer.alloc(SCRATCH_LIMITS.uploadBytes + 1)
    expect(await detail(browser.upload('e4', [{ name: 'a', mimeType: 'x', data: big }]))).toMatch(/10 MB/)
    const other = await open((kind) => (kind === 'upload' ? { error: 'not-file-input' } : defaults(kind)))
    expect(
      await detail(other.browser.upload('#x', [{ name: 'a', mimeType: 'x', data: Buffer.from('a') }])),
    ).toMatch(/isn’t a file input/)
  })

  it('inspects only in a session: console by level, scripts in either world, cookies, storage', async () => {
    const plain = await open()
    expect(await detail(plain.browser.evaluate('() => 1'))).toMatch(/Only an agent’s session/)
    expect(() => plain.browser.consoleMessages()).toThrow()
    const { browser, frame, surface, session } = await open(defaults, { session: true })
    for (const [level, text] of [
      ['debug', 'd'],
      ['info', 'i'],
      ['warning', 'w'],
      ['error', 'e'],
      ['info', '%cElectron Security Warning (x)'],
    ] as const)
      for (const listener of surface.consoleListeners)
        listener({ level, text, source: 'https://shop.example.com/a.js', line: 3 })
    expect(browser.consoleMessages().map((m) => m.text)).toEqual(['i', 'w', 'e'])
    expect(browser.consoleMessages('debug')).toHaveLength(4)
    expect(browser.consoleMessages('error').map((m) => m.text)).toEqual(['e'])
    const ran: { world: string; code: string }[] = []
    Object.assign(frame, {
      runAdapter: async (code: string) => {
        ran.push({ world: 'isolated', code })
        return '{"a":1}'
      },
      runPage: async (code: string) => {
        ran.push({ world: 'page', code })
        return 'x'.repeat(SCRATCH_LIMITS.evaluateChars + 5)
      },
    })
    expect(await browser.evaluate('() => ({ a: 1 })')).toEqual({ result: '{"a":1}', cut: false })
    const long = await browser.evaluate('() => window.big', { world: 'page' })
    expect(long.cut).toBe(true)
    expect(long.result).toHaveLength(SCRATCH_LIMITS.evaluateChars)
    await browser.evaluate('(el) => el.id', { target: 'e2' })
    expect(ran.map((r) => r.world)).toEqual(['isolated', 'page', 'isolated'])
    expect(ran[0]?.code).toContain('() => ({ a: 1 })')
    expect(ran[2]?.code).toMatch(/document\.querySelector\('\[data-valet-[0-9a-f]{12}\]'\)/)
    expect(frame.scripts).toContain('mark')
    Object.assign(frame, {
      runAdapter: async () => {
        throw new Error('ReferenceError: nope is not defined')
      },
    })
    expect(await detail(browser.evaluate('() => nope'))).toMatch(/The script failed: ReferenceError: nope/)
    session.cookies = [
      { name: 'sid', value: 'abc123', domain: 'shop.example.com', path: '/', secure: true, httpOnly: true },
    ] as never
    expect((await browser.cookies())[0]).toMatchObject({ name: 'sid', value: 'abc123' })
    expect(await browser.storage()).toEqual({
      origin: 'https://shop.example.com',
      local: [{ key: 'k', value: 'v' }],
      session: [],
    })
  })

  it('keeps a session’s downloads until handed on, and only a session’s', async () => {
    const plain = await open()
    expect(plain.session.downloads).toBeNull()
    const { browser, session } = await open(defaults, { session: true })
    const accept = session.downloads
    expect(accept?.maxBytes).toBe(SCRATCH_LIMITS.downloadBytes)
    accept?.listener({ kind: 'started', id: 'd1', name: '../a.pdf' })
    accept?.listener({ kind: 'started', id: 'd2', name: 'b.zip' })
    expect(browser.takeDownloads()).toEqual([
      { status: 'downloading', id: 'd1', name: '.._a.pdf' },
      { status: 'downloading', id: 'd2', name: 'b.zip' },
    ])
    accept?.listener({ kind: 'done', id: 'd1', name: '../a.pdf', mimeType: '', data: Buffer.from('%PDF') })
    accept?.listener({ kind: 'failed', id: 'd2', name: 'b.zip', reason: 'too-large' })
    expect(browser.takeDownloads()).toEqual([
      {
        status: 'ready',
        id: 'd1',
        name: '.._a.pdf',
        mimeType: 'application/octet-stream',
        data: Buffer.from('%PDF'),
      },
      { status: 'failed', id: 'd2', name: 'b.zip', reason: 'too-large' },
    ])
    expect(browser.takeDownloads()).toEqual([])
    accept?.listener({ kind: 'started', id: 'd3', name: 'c' })
    browser.close()
    accept?.listener({ kind: 'done', id: 'd3', name: 'c', mimeType: 'text/plain', data: Buffer.from('c') })
    expect(browser.takeDownloads()).toEqual([])
  })

  it('shows the session’s own cookie values as they are, and lets forms post', async () => {
    const { browser, session } = await open(
      (kind) =>
        kind === 'snapshot'
          ? {
              url: 'https://shop.example.com/',
              title: 'woolworths.com.au',
              yaml: '- text: woolworths.com.au',
            }
          : defaults(kind),
      { session: true },
    )
    for (const listener of session.cookieListeners)
      listener({ name: 'site', value: 'woolworths.com.au', sameSite: 'lax' })
    const page = await browser.ariaSnapshot()
    expect(page.title).toBe('woolworths.com.au')
    expect(page.yaml).toBe('- text: woolworths.com.au')
    const allow = session.filter as (request: object) => boolean | Promise<boolean>
    expect(
      await allow({ id: 1, url: 'https://shop.example.com/cart', method: 'POST', resourceType: 'mainFrame' }),
    ).toBe(true)
  })
})
