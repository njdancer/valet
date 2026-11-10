// @vitest-environment node
// Launch mode, the app's own pages, window titles, window placement and client snippets.

import { describe, expect, it } from 'vitest'
import {
  bannerBeside,
  handoffLayout,
  MIN_AUTH_WINDOW_HEIGHT,
  type Rect,
  topRight,
  underTrayIcon,
} from '../../src/main/core/geometry'
import {
  DEMO_RESOLVER_RULES,
  demoResolverRules,
  E2E_CANARY_HOST,
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
    expect(launchMode([], {}, DEV)).toEqual({ demo: false, e2e: false, userData: null, setup: true })
    expect(launchMode(['electron', '.', '--demo'], {}, DEV).demo).toBe(true)
    expect(launchMode([], { VALET_DEMO: '1' }, DEV).demo).toBe(true)
    expect(launchMode([], { VALET_DEMO: 'true' }, DEV).demo).toBe(false)
    expect(launchMode([], { VALET_E2E: '1' }, DEV).e2e).toBe(true)
    // Setup opens on a first launch, except in an e2e launch that doesn't ask for it.
    expect(launchMode([], { VALET_E2E: '1' }, DEV).setup).toBe(false)
    expect(launchMode([], { VALET_E2E: '1', VALET_E2E_SETUP: '1' }, DEV).setup).toBe(true)
    expect(launchMode(['--demo'], { VALET_E2E_SETUP: '0' }, DEV).setup).toBe(true)
  })

  it('never turns demo on in a packaged app, or in a build without demo mode', () => {
    const asked = { VALET_DEMO: '1' }
    expect(launchMode(['--demo'], asked, { packaged: true, demoBuild: true }).demo).toBe(false)
    expect(launchMode(['--demo'], asked, { packaged: false, demoBuild: false }).demo).toBe(false)
    expect(launchMode(['--demo'], asked, { packaged: true, demoBuild: false }).demo).toBe(false)
  })

  it('takes an absolute userData override only, and none in a packaged app', () => {
    expect(launchMode([], { VALET_USER_DATA: '/tmp/sa' }, DEV).userData).toBe('/tmp/sa')
    expect(launchMode([], { VALET_USER_DATA: '/tmp/a/../sa' }, DEV).userData).toBe('/tmp/sa')
    expect(launchMode([], { VALET_USER_DATA: 'sa' }, DEV).userData).toBeNull()
    expect(
      launchMode([], { VALET_USER_DATA: '/tmp/sa' }, { packaged: true, demoBuild: false }).userData,
    ).toBeNull()
  })

  it('keeps demo data apart from the real data', () => {
    const appData = '/Users/n/Library/Application Support'
    expect(userDataDir(launchMode([], {}, DEV), appData)).toBe(`${appData}/Valet`)
    expect(userDataDir(launchMode(['--demo'], {}, DEV), appData)).toBe(`${appData}/valet-demo`)
    expect(userDataDir(launchMode(['--demo'], { VALET_USER_DATA: '/tmp/x' }, DEV), appData)).toBe('/tmp/x')
    expect(realDataDir(appData)).toBe(`${appData}/Valet`)
    // A development package has its own folder, apart from the release app's.
    expect(realDataDir(appData, 'Valet Dev')).toBe(`${appData}/Valet Dev`)
    expect(userDataDir(launchMode([], {}, DEV), appData, 'Valet Dev')).toBe(`${appData}/Valet Dev`)
    expect(
      userDataDir(
        launchMode(['--demo'], { VALET_USER_DATA: `${appData}/Valet Dev/x` }, DEV),
        appData,
        'Valet Dev',
      ),
    ).toBe(`${appData}/valet-demo`)
  })

  it.each([
    '/Users/n/Library/Application Support/Valet',
    '/Users/n/Library/Application Support/Valet/',
    '/Users/n/Library/Application Support/valet',
    '/Users/n/Library/Application Support/x/../Valet',
    '/Users/n/Library/Application Support/Valet/sub',
  ])('never points a demo launch at the real data folder (%s)', (override) => {
    const appData = '/Users/n/Library/Application Support'
    const mode = launchMode(['--demo'], { VALET_USER_DATA: override }, DEV)
    expect(userDataDir(mode, appData)).toBe(`${appData}/valet-demo`)
  })

  it('still lets a normal development launch use a folder beside the real one', () => {
    const appData = '/Users/n/Library/Application Support'
    const mode = launchMode(['--demo'], { VALET_USER_DATA: `${appData}/valet-e2e` }, DEV)
    expect(userDataDir(mode, appData)).toBe(`${appData}/valet-e2e`)
  })
})

describe('demo resolver rules', () => {
  it('map only the demo’s own names, and the canary host in an e2e launch alone', () => {
    expect(demoResolverRules({ e2e: false })).toBe('MAP *.woolworths.test 127.0.0.1')
    expect(demoResolverRules({ e2e: false })).toBe(DEMO_RESOLVER_RULES)
    expect(demoResolverRules({ e2e: true })).toBe('MAP *.woolworths.test 127.0.0.1, MAP evil.test 127.0.0.1')
    expect(E2E_CANARY_HOST).toBe('evil.test')
    // Every rule points at this machine: no launch can map a name somewhere else.
    for (const e2e of [false, true])
      for (const rule of demoResolverRules({ e2e }).split(','))
        expect(rule.trim()).toMatch(/^MAP \S+ 127\.0\.0\.1$/)
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
    expect(rendererBase(undefined, dev, dir)).toEqual({ kind: 'app', root: dir })
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
    expect(rendererBase(url, context, dir)).toEqual({ kind: 'app', root: dir })
  })
})

describe('the app’s pages', () => {
  const files = {
    kind: 'app',
    root: '/Applications/Valet.app/Contents/Resources/app.asar/out/renderer',
  } as const
  const dev = { kind: 'dev', origin: 'http://localhost:5173' } as const

  it('builds page URLs on app://renderer (never file://) with the hash and nothing else', () => {
    expect(pageUrl(files, 'index.html', '#/confirm/cf_1')).toBe('app://renderer/index.html#/confirm/cf_1')
    expect(pageUrl(dev, 'tray.html')).toBe('http://localhost:5173/tray.html')
  })

  it('recognises only the two pages, whatever their hash', () => {
    expect(isAppPage(files, pageUrl(files, 'index.html', '#/adapters'))).toBe(true)
    expect(isAppPage(files, pageUrl(files, 'tray.html'))).toBe(true)
    expect(isAppPage(dev, 'http://localhost:5173/index.html#/audit')).toBe(true)
  })

  it.each([
    'file:///Applications/Valet.app/Contents/Resources/app.asar/out/renderer/index.html',
    'app://renderer/other.html',
    'app://renderer/assets/index.html',
    'app://renderer/index.html?x=1',
    'app://other/index.html',
    'app://renderer.evil/index.html',
    'app://user@renderer/index.html',
    'app://renderer:80/index.html',
    'https://renderer/index.html',
    'https://localhost:5173/index.html',
    'http://localhost:5174/index.html',
    'http://user:pw@localhost:5173/index.html',
    'about:blank',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAppPage(url.startsWith('http') ? dev : files, url)).toBe(false)
  })

  it('titles windows deterministically, marking demo mode', () => {
    expect(windowTitle('control', false, false)).toBe('Valet')
    expect(windowTitle('control', true, false)).toBe('Valet (demo)')
    expect(windowTitle('control', true, true)).toBe('Valet (demo) [control]')
    expect(windowTitle('confirmation', false, true, 'cf_1')).toBe('Valet: confirm [cf_1]')
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

  it('puts the confirmation top right', () => {
    expect(topRight({ width: 460, height: 620 }, work)).toEqual({ x: 964, y: 41, width: 460, height: 620 })
  })

  const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  it('puts the banner directly above the auth window when there is room, and leaves the window', () => {
    const target = { x: 100, y: 300, width: 800, height: 500 }
    expect(handoffLayout(target, 168, work)).toEqual({
      banner: { x: 100, y: 132, width: 800, height: 168 },
      window: null,
    })
    expect(handoffLayout(null, 168, work)).toEqual({
      banner: { x: 340, y: 25, width: 760, height: 168 },
      window: null,
    })
  })

  it('moves the usual 900 px auth window down to make room, never covering its title bar', () => {
    // The demo's case: the auth window centred at y=109 on a 1440x900 screen.
    const target = { x: 80, y: 109, width: 1280, height: 791 }
    const layout = handoffLayout(target, 168, work)
    expect(layout.banner).toEqual({ x: 80, y: 25, width: 1280, height: 168 })
    expect(layout.window).toEqual({ x: 80, y: 193, width: 1280, height: 707 })
    expect(overlaps(layout.banner, layout.window as Rect)).toBe(false)
    // Inside the work area.
    expect((layout.window as Rect).y + (layout.window as Rect).height).toBe(work.y + work.height)
  })

  it('moves a short window down without shrinking it', () => {
    const layout = handoffLayout({ x: 0, y: 25, width: 900, height: 500 }, 168, work)
    expect(layout.window).toEqual({ x: 0, y: 193, width: 900, height: 500 })
  })

  it('on a screen too small to shrink the window that far, puts the banner below or at the bottom', () => {
    const small = { x: 0, y: 25, width: 1024, height: 540 }
    const tall = { x: 0, y: 25, width: 1000, height: 540 }
    const layout = handoffLayout(tall, 168, small)
    expect(layout.window).toBeNull()
    // No room above or below: the bottom of the work area, clear of the title bar.
    expect(layout.banner).toEqual({ x: 0, y: 397, width: 1000, height: 168 })
    expect(layout.banner.y).toBeGreaterThan(tall.y + 28)
    expect(MIN_AUTH_WINDOW_HEIGHT).toBeGreaterThan(540 - 168)
  })

  it('follows the window as it moves: above, else below, else along the bottom', () => {
    expect(bannerBeside({ x: 10, y: 400, width: 800, height: 300 }, 168, work)).toEqual({
      x: 10,
      y: 232,
      width: 800,
      height: 168,
    })
    expect(bannerBeside({ x: 10, y: 60, width: 800, height: 300 }, 168, work)).toEqual({
      x: 10,
      y: 360,
      width: 800,
      height: 168,
    })
    expect(bannerBeside({ x: 10, y: 60, width: 800, height: 800 }, 168, work).y).toBe(732)
    // Kept on screen sideways, and no wider than the screen.
    expect(bannerBeside({ x: 1000, y: 400, width: 800, height: 300 }, 168, work).x).toBe(640)
    expect(bannerBeside({ x: -50, y: 400, width: 2000, height: 300 }, 168, work)).toMatchObject({
      x: 0,
      width: 1440,
    })
  })
})

describe('client snippets', () => {
  const bridge = {
    command: '/repo/node_modules/.bin/tsx',
    args: ['/repo/bridge-cli.ts', '/Users/n/Library/Application Support/Valet/bridge.json'],
  }

  it('launch the bridge with the config path, quoted, and never a token', () => {
    const snippets = clientSnippets('valet', bridge)
    expect(snippetFor(snippets, 'claude-code')).toBe(
      "claude mcp add valet -- /repo/node_modules/.bin/tsx /repo/bridge-cli.ts '/Users/n/Library/Application Support/Valet/bridge.json'",
    )
    expect(JSON.parse(snippetFor(snippets, 'claude-desktop') ?? '')).toEqual({
      mcpServers: { valet: { command: bridge.command, args: bridge.args } },
    })
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(snippetFor([], 'claude-code')).toBeNull()
  })
})
