// @vitest-environment node
// Launch mode, the app's own pages, window titles, window placement and client snippets.

import { describe, expect, it } from 'vitest'
import { aboveWindow, topRight, underTrayIcon } from '../../src/main/core/geometry'
import { isAppPage, launchMode, pageUrl, userDataDir, windowTitle } from '../../src/main/core/launch'
import { clientSnippets, shellQuote, snippetFor } from '../../src/main/core/snippets'

describe('launchMode', () => {
  it('turns demo on by flag or environment, and e2e only by environment', () => {
    expect(launchMode([], {})).toEqual({ demo: false, e2e: false, userData: null })
    expect(launchMode(['electron', '.', '--demo'], {}).demo).toBe(true)
    expect(launchMode([], { SITEADAPTER_DEMO: '1' }).demo).toBe(true)
    expect(launchMode([], { SITEADAPTER_DEMO: 'true' }).demo).toBe(false)
    expect(launchMode([], { SITEADAPTER_E2E: '1' }).e2e).toBe(true)
  })

  it('takes an absolute userData override only', () => {
    expect(launchMode([], { SITEADAPTER_USER_DATA: '/tmp/sa' }).userData).toBe('/tmp/sa')
    expect(launchMode([], { SITEADAPTER_USER_DATA: '/tmp/a/../sa' }).userData).toBe('/tmp/sa')
    expect(launchMode([], { SITEADAPTER_USER_DATA: 'sa' }).userData).toBeNull()
  })

  it('keeps demo data apart from the real data', () => {
    const appData = '/Users/n/Library/Application Support'
    expect(userDataDir(launchMode([], {}), appData)).toBe(`${appData}/siteadapter`)
    expect(userDataDir(launchMode(['--demo'], {}), appData)).toBe(`${appData}/siteadapter-demo`)
    expect(userDataDir(launchMode(['--demo'], { SITEADAPTER_USER_DATA: '/tmp/x' }), appData)).toBe('/tmp/x')
  })
})

describe('the app’s pages', () => {
  const files = {
    kind: 'file',
    dir: '/Applications/siteadapter.app/Contents/Resources/app/out/renderer',
  } as const
  const dev = { kind: 'dev', origin: 'http://localhost:5173' } as const

  it('builds page URLs with the hash and nothing else', () => {
    expect(pageUrl(files, 'index.html', '#/confirm/cf_1')).toBe(
      'file:///Applications/siteadapter.app/Contents/Resources/app/out/renderer/index.html#/confirm/cf_1',
    )
    expect(pageUrl(dev, 'tray.html')).toBe('http://localhost:5173/tray.html')
  })

  it('recognises only the two pages, whatever their hash', () => {
    expect(isAppPage(files, pageUrl(files, 'index.html', '#/adapters'))).toBe(true)
    expect(isAppPage(files, pageUrl(files, 'tray.html'))).toBe(true)
    expect(isAppPage(dev, 'http://localhost:5173/index.html#/audit')).toBe(true)
  })

  it.each([
    'file:///tmp/out/renderer/index.html',
    'file:///Applications/siteadapter.app/Contents/Resources/app/out/renderer/other.html',
    'file:///Applications/siteadapter.app/Contents/Resources/app/out/renderer/index.html?x=1',
    'https://localhost:5173/index.html',
    'http://localhost:5174/index.html',
    'http://user:pw@localhost:5173/index.html',
    'about:blank',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAppPage(url.startsWith('file:') ? files : dev, url)).toBe(false)
  })

  it('titles windows deterministically, marking demo mode', () => {
    expect(windowTitle('control', false, false)).toBe('siteadapter')
    expect(windowTitle('control', true, false)).toBe('siteadapter (demo)')
    expect(windowTitle('control', true, true)).toBe('siteadapter (demo) [control]')
    expect(windowTitle('confirmation', false, true, 'cf_1')).toBe('siteadapter: confirm [cf_1]')
  })
})

describe('placement', () => {
  const work = { x: 0, y: 25, width: 1440, height: 875 }

  it('puts the popover under the icon, inside the screen', () => {
    expect(
      underTrayIcon({ x: 1000, y: 0, width: 24, height: 24 }, { width: 400, height: 600 }, work),
    ).toEqual({
      x: 812,
      y: 28,
      width: 400,
      height: 600,
    })
    expect(underTrayIcon({ x: 1430, y: 0, width: 24, height: 24 }, { width: 400, height: 600 }, work).x).toBe(
      1040,
    )
  })

  it('puts the confirmation top right and the banner above the auth window', () => {
    expect(topRight({ width: 460, height: 620 }, work)).toEqual({ x: 964, y: 41, width: 460, height: 620 })
    expect(aboveWindow({ x: 100, y: 300, width: 800, height: 600 }, 168, work)).toEqual({
      x: 100,
      y: 132,
      width: 800,
      height: 168,
    })
    expect(aboveWindow({ x: 100, y: 60, width: 800, height: 600 }, 168, work).y).toBe(25)
    expect(aboveWindow(null, 168, work)).toEqual({ x: 340, y: 25, width: 760, height: 168 })
  })
})

describe('client snippets', () => {
  const bridge = {
    command: '/repo/node_modules/.bin/tsx',
    args: ['/repo/bridge-cli.ts', '/Users/n/Library/Application Support/siteadapter/bridge.json'],
  }

  it('launch the bridge with the config path, quoted, and never a token', () => {
    const snippets = clientSnippets('siteadapter', bridge)
    expect(snippetFor(snippets, 'claude-code')).toBe(
      "claude mcp add siteadapter -- /repo/node_modules/.bin/tsx /repo/bridge-cli.ts '/Users/n/Library/Application Support/siteadapter/bridge.json'",
    )
    expect(JSON.parse(snippetFor(snippets, 'claude-desktop') ?? '')).toEqual({
      mcpServers: { siteadapter: { command: bridge.command, args: bridge.args } },
    })
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(snippetFor([], 'claude-code')).toBeNull()
  })
})
