// @vitest-environment node
// Launch mode, the app's own pages, window titles, window placement and client snippets.

import { describe, expect, it } from 'vitest'
import { aboveWindow, topRight, underTrayIcon } from '../../src/main/core/geometry'
import {
  isAppPage,
  launchMode,
  pageUrl,
  realDataDir,
  rendererBase,
  userDataDir,
  windowTitle,
} from '../../src/main/core/launch'
import { clientSnippets, shellQuote, snippetFor } from '../../src/main/core/snippets'

const DEV = { packaged: false, demoBuild: true } as const

describe('launchMode', () => {
  it('turns demo on by flag or environment, and e2e only by environment', () => {
    expect(launchMode([], {}, DEV)).toEqual({ demo: false, e2e: false, userData: null })
    expect(launchMode(['electron', '.', '--demo'], {}, DEV).demo).toBe(true)
    expect(launchMode([], { SITEADAPTER_DEMO: '1' }, DEV).demo).toBe(true)
    expect(launchMode([], { SITEADAPTER_DEMO: 'true' }, DEV).demo).toBe(false)
    expect(launchMode([], { SITEADAPTER_E2E: '1' }, DEV).e2e).toBe(true)
  })

  it('never turns demo on in a packaged app, or in a build without demo mode', () => {
    const asked = { SITEADAPTER_DEMO: '1' }
    expect(launchMode(['--demo'], asked, { packaged: true, demoBuild: true }).demo).toBe(false)
    expect(launchMode(['--demo'], asked, { packaged: false, demoBuild: false }).demo).toBe(false)
    expect(launchMode(['--demo'], asked, { packaged: true, demoBuild: false }).demo).toBe(false)
  })

  it('takes an absolute userData override only, and none in a packaged app', () => {
    expect(launchMode([], { SITEADAPTER_USER_DATA: '/tmp/sa' }, DEV).userData).toBe('/tmp/sa')
    expect(launchMode([], { SITEADAPTER_USER_DATA: '/tmp/a/../sa' }, DEV).userData).toBe('/tmp/sa')
    expect(launchMode([], { SITEADAPTER_USER_DATA: 'sa' }, DEV).userData).toBeNull()
    expect(
      launchMode([], { SITEADAPTER_USER_DATA: '/tmp/sa' }, { packaged: true, demoBuild: false }).userData,
    ).toBeNull()
  })

  it('keeps demo data apart from the real data', () => {
    const appData = '/Users/n/Library/Application Support'
    expect(userDataDir(launchMode([], {}, DEV), appData)).toBe(`${appData}/siteadapter`)
    expect(userDataDir(launchMode(['--demo'], {}, DEV), appData)).toBe(`${appData}/siteadapter-demo`)
    expect(userDataDir(launchMode(['--demo'], { SITEADAPTER_USER_DATA: '/tmp/x' }, DEV), appData)).toBe(
      '/tmp/x',
    )
    expect(realDataDir(appData)).toBe(`${appData}/siteadapter`)
  })

  it.each([
    '/Users/n/Library/Application Support/siteadapter',
    '/Users/n/Library/Application Support/siteadapter/',
    '/Users/n/Library/Application Support/SiteAdapter',
    '/Users/n/Library/Application Support/x/../siteadapter',
    '/Users/n/Library/Application Support/siteadapter/sub',
  ])('never points a demo launch at the real data folder (%s)', (override) => {
    const appData = '/Users/n/Library/Application Support'
    const mode = launchMode(['--demo'], { SITEADAPTER_USER_DATA: override }, DEV)
    expect(userDataDir(mode, appData)).toBe(`${appData}/siteadapter-demo`)
  })

  it('still lets a normal development launch use a folder beside the real one', () => {
    const appData = '/Users/n/Library/Application Support'
    const mode = launchMode(['--demo'], { SITEADAPTER_USER_DATA: `${appData}/siteadapter-e2e` }, DEV)
    expect(userDataDir(mode, appData)).toBe(`${appData}/siteadapter-e2e`)
  })
})

describe('rendererBase', () => {
  const dir = '/app/out/renderer'
  const dev = { packaged: false, devServerBuild: true } as const

  it('uses the dev server only in a dev-server build, unpackaged, on a loopback http origin', () => {
    expect(rendererBase('http://localhost:5173/', dev, dir)).toEqual({
      kind: 'dev',
      origin: 'http://localhost:5173',
    })
    expect(rendererBase('http://127.0.0.1:5173', dev, dir)).toEqual({
      kind: 'dev',
      origin: 'http://127.0.0.1:5173',
    })
    expect(rendererBase(undefined, dev, dir)).toEqual({ kind: 'file', dir })
  })

  it.each([
    ['a packaged app', 'http://localhost:5173', { packaged: true, devServerBuild: true }],
    ['a plain build (start, demo)', 'http://localhost:5173', { packaged: false, devServerBuild: false }],
    ['another host', 'http://evil.example:5173', dev],
    ['a name that only starts like localhost', 'http://localhost.evil.example:5173', dev],
    ['https', 'https://localhost:5173', dev],
    ['a file URL', 'file:///tmp/x', dev],
    ['credentials in the URL', 'http://u:p@localhost:5173', dev],
    ['no port', 'http://localhost', dev],
    ['not a URL', 'nope', dev],
  ] as const)('ignores ELECTRON_RENDERER_URL in %s', (_name, url, context) => {
    expect(rendererBase(url, context, dir)).toEqual({ kind: 'file', dir })
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
