import { describe, expect, it } from 'vitest'
import {
  ariaBootScript,
  ariaPointScript,
  ariaSnapshotScript,
  findInSnapshot,
  snapshotDelta,
} from '../src/aria'
import { parseKey } from '../src/keys'

const PAGE = [
  '- generic [ref=e1]:',
  '  - banner [ref=e2]:',
  '    - search [ref=e6]:',
  '      - textbox "Search" [ref=e7]',
  '      - button "Go" [ref=e8]',
  '  - main [ref=e9]:',
  '    - heading "Bread" [level=1] [ref=e10]',
  '    - paragraph',
].join('\n')

describe('snapshotDelta', () => {
  it('is empty when nothing changed', () => {
    expect(snapshotDelta(PAGE, PAGE)).toBe('')
  })

  it('gives the new lines under the lines they sit in', () => {
    const next = PAGE.replace('    - paragraph', '    - paragraph [ref=e18]: Results for sourdough')
    expect(snapshotDelta(PAGE, next)).toBe(
      ['- generic [ref=e1]:', '  - main [ref=e9]:', '    - paragraph [ref=e18]: Results for sourdough'].join(
        '\n',
      ),
    )
  })

  it('gives the whole page when every line is new', () => {
    expect(snapshotDelta('', PAGE)).toBe(PAGE)
  })
})

describe('findInSnapshot', () => {
  it('finds text case-insensitively, under its path', () => {
    expect(findInSnapshot(PAGE, { text: 'go' })).toEqual([
      '- generic [ref=e1]: > - banner [ref=e2]: > - search [ref=e6]: > - button "Go" [ref=e8]',
    ])
  })

  it('takes a regular expression and a limit', () => {
    expect(findInSnapshot(PAGE, { regex: /ref=e\d+\]$/ }, 2)).toHaveLength(2)
  })

  it('finds nothing for text that is not there', () => {
    expect(findInSnapshot(PAGE, { text: 'pumpernickel' })).toEqual([])
  })
})

describe('page scripts', () => {
  it('carry their input only as a JSON literal', () => {
    const script = ariaPointScript("e1'); alert(1); ('")
    expect(script.endsWith(`(${JSON.stringify("e1'); alert(1); ('")})`)).toBe(true)
    expect(ariaSnapshotScript({ target: null, depth: 3 })).toContain('{"target":null,"depth":3}')
  })

  it('boot Playwright with both of Valet’s hooks', () => {
    const boot = ariaBootScript()
    expect(boot).toContain('globalThis.__valetHidden =')
    expect(boot).toContain('globalThis.__valetName =')
    expect(boot).toContain('globalThis.__valetHidden(element)')
    expect(boot).toContain('globalThis.__valetName(element, name.text)')
  })
})

describe('parseKey', () => {
  it('reads Playwright’s key names', () => {
    expect(parseKey('Enter')).toEqual({ keyCode: 'Enter', modifiers: [], char: '\r' })
    expect(parseKey('ArrowLeft')).toEqual({ keyCode: 'Left', modifiers: [], char: null })
    expect(parseKey('a')).toEqual({ keyCode: 'a', modifiers: [], char: 'a' })
    expect(parseKey('F5')).toEqual({ keyCode: 'F5', modifiers: [], char: null })
  })

  it('reads combinations, where a shortcut types nothing', () => {
    expect(parseKey('Control+A')).toEqual({ keyCode: 'A', modifiers: ['control'], char: null })
    expect(parseKey('Shift+Tab')).toEqual({ keyCode: 'Tab', modifiers: ['shift'], char: null })
    expect(parseKey('Shift+a')).toEqual({ keyCode: 'a', modifiers: ['shift'], char: 'a' })
    expect(parseKey('Control++')).toEqual({ keyCode: '+', modifiers: ['control'], char: null })
    expect(parseKey('ControlOrMeta+c')).toEqual({ keyCode: 'c', modifiers: ['meta'], char: null })
  })

  it('refuses what it does not know', () => {
    for (const bad of ['', 'Hyper+A', 'Control+Control+A', 'Control+', 'Banana', 'x'.repeat(61)])
      expect(parseKey(bad)).toBeNull()
  })
})

describe('interactiveOnly', () => {
  it('keeps controls, links and their URLs, under the lines they sit in, and drops prose', async () => {
    const { interactiveOnly } = await import('../src/aria')
    const yaml = [
      '- banner [ref=e1]:',
      '  - link "Home" [ref=e2]:',
      '    - /url: https://a.example/',
      '  - paragraph [ref=e3]: Welcome',
      '- main [ref=e4]:',
      '  - heading "Deals" [level=2] [ref=e5]',
      '  - list [ref=e6]:',
      '    - listitem [ref=e7]:',
      '      - button "Add" [ref=e8]',
      '- contentinfo [ref=e9]: Fine print',
    ].join('\n')
    expect(interactiveOnly(yaml)).toBe(
      [
        '- banner [ref=e1]:',
        '  - link "Home" [ref=e2]:',
        '    - /url: https://a.example/',
        '- main [ref=e4]:',
        '  - list [ref=e6]:',
        '    - listitem [ref=e7]:',
        '      - button "Add" [ref=e8]',
      ].join('\n'),
    )
  })
})
