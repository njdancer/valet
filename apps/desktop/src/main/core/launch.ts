// How this launch runs, decided once from argv and the environment before Electron is ready, and
// which URLs are the app's own pages.

import { isAbsolute, join, resolve, sep } from 'node:path'
import { appPageUrl } from './app-scheme'
import type { WindowRole } from './ipc'

export interface LaunchMode {
  /** A local fake site and a test credential, in a userData of its own. */
  readonly demo: boolean
  /**
   * Deterministic window titles for the end-to-end suite. In a demo launch only, also the canary
   * host mapping and the demo site's hook (electron/demo.ts, exposeToE2e); nothing else.
   */
  readonly e2e: boolean
  /** VALET_USER_DATA: an absolute directory to use as userData instead of the default. */
  readonly userData: string | null
}

/** What this build is, decided by the build and Electron, never by argv or the environment. */
export interface LaunchContext {
  /** app.isPackaged. */
  readonly packaged: boolean
  /** Whether the bundle carries demo mode at all (electron-vite dev, or `build --mode demo`). */
  readonly demoBuild: boolean
}

/**
 * Demo mode and the userData override are development switches: a packaged app, or a build made
 * without demo mode, ignores both, so nothing in argv or the environment can point a real install
 * at a fake site, a fake certificate or another data folder.
 */
export function launchMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  context: LaunchContext,
): LaunchMode {
  const override = context.packaged ? undefined : env['VALET_USER_DATA']
  const demoAllowed = context.demoBuild && !context.packaged
  return {
    demo: demoAllowed && (env['VALET_DEMO'] === '1' || argv.includes('--demo')),
    e2e: env['VALET_E2E'] === '1',
    // A relative path would land wherever the app was started from; it is ignored.
    userData: override !== undefined && isAbsolute(override) ? resolve(override) : null,
  }
}

/** The release app's name, and so its userData folder's. */
export const RELEASE_DATA_NAME = 'Valet'
/** A development package's name (electron-builder.config.ts), and every unpackaged run's folder. */
export const DEV_DATA_NAME = 'Valet Dev'

/**
 * An install's userData: ~/Library/Application Support/<name>. `name` is the packaged app's own
 * (app.getName(): Valet for a release, Valet Dev for a development package, so the two
 * never share data); an unpackaged run uses the development name (electron/app.ts).
 */
export function realDataDir(appData: string, name: string = RELEASE_DATA_NAME): string {
  return join(appData, name)
}

/**
 * The userData directory: the override, or ~/Library/Application Support/<name>(-demo). A demo
 * launch never uses the real data folder (or anything inside it), whatever the override says: it
 * would reuse the real grants, approvals and bridge.json.
 */
export function userDataDir(mode: LaunchMode, appData: string, name: string = RELEASE_DATA_NAME): string {
  const demoDir = join(appData, 'valet-demo')
  if (mode.userData !== null) {
    if (
      mode.demo &&
      (within(mode.userData, realDataDir(appData)) || within(mode.userData, realDataDir(appData, name)))
    )
      return demoDir
    return mode.userData
  }
  return mode.demo ? demoDir : realDataDir(appData, name)
}

/** `path` is `dir` or inside it. macOS volumes are case-insensitive by default, so case is ignored. */
function within(path: string, dir: string): boolean {
  const a = resolve(path).toLowerCase()
  const b = resolve(dir).toLowerCase()
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`)
}

/** The host resolver rule demo mode appends before ready: only the demo's own names. */
export const DEMO_RESOLVER_RULES = 'MAP *.woolworths.test 127.0.0.1'

/**
 * The end-to-end suite's egress canary: an attacker's host it runs the fake's exfil sink behind.
 * Mapped to 127.0.0.1 too, in an e2e launch of demo mode only, so that a request the app let out to
 * it would arrive at the sink rather than fail to resolve, and "nothing arrived" means blocked.
 */
export const E2E_CANARY_HOST = 'evil.test'

/** The resolver rules for a demo launch: the demo's names, plus the canary in e2e mode. */
export function demoResolverRules(mode: Pick<LaunchMode, 'e2e'>): string {
  return mode.e2e ? `${DEMO_RESOLVER_RULES}, MAP ${E2E_CANARY_HOST} 127.0.0.1` : DEMO_RESOLVER_RULES
}

/**
 * Where the renderer's pages come from: the built files, served at app://renderer from `root`
 * (app-scheme.ts; never file://, which the grantFileProtocolExtraPrivileges fuse leaves unable to
 * run the renderer's module scripts), or electron-vite's dev server.
 */
export type RendererBase =
  | { readonly kind: 'app'; readonly root: string }
  | { readonly kind: 'dev'; readonly origin: string }

/**
 * The renderer's base. The dev server's URL (ELECTRON_RENDERER_URL) is taken only from a bundle
 * electron-vite built for `dev`, never in a packaged app, and only as an http origin on this
 * machine's loopback names: every page on that origin gets the preload and the app's IPC trust, so a
 * value left over in a shell must not make some other origin the app's.
 */
export function rendererBase(
  devUrl: string | undefined,
  context: { readonly packaged: boolean; readonly devServerBuild: boolean },
  filesDir: string,
): RendererBase {
  const files: RendererBase = { kind: 'app', root: filesDir }
  if (context.packaged || !context.devServerBuild || devUrl === undefined) return files
  let url: URL
  try {
    url = new URL(devUrl)
  } catch {
    return files
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '' || url.port === '')
    return files
  return { kind: 'dev', origin: url.origin }
}

export const PAGES = ['index.html', 'tray.html'] as const
export type Page = (typeof PAGES)[number]

/** The URL of one of the app's pages, with a hash route the caller has already checked. */
export function pageUrl(base: RendererBase, page: Page, hash = ''): string {
  if (base.kind === 'app') return appPageUrl(page, hash)
  const url = new URL(`/${page}`, base.origin)
  url.hash = hash
  return url.toString()
}

/** True only for the app's own pages, whatever their hash. Query strings are never ours. */
export function isAppPage(base: RendererBase, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.search !== '' || parsed.username !== '' || parsed.password !== '') return false
  return PAGES.some((page) => {
    const expected = new URL(pageUrl(base, page))
    return (
      parsed.protocol === expected.protocol &&
      parsed.host === expected.host &&
      parsed.pathname === expected.pathname
    )
  })
}

/** Window titles: fixed words, and in e2e mode a stable suffix the suite can find windows by. */
export function windowTitle(role: WindowRole, demo: boolean, e2e: boolean, detail = ''): string {
  const names: Record<WindowRole, string> = {
    control: 'Valet',
    tray: 'Valet menu',
    confirmation: 'Valet: confirm',
    'needs-user': 'Valet: sign in',
  }
  const title = `${names[role]}${demo ? ' (demo)' : ''}`
  return e2e && detail !== '' ? `${title} [${detail}]` : e2e ? `${title} [${role}]` : title
}
