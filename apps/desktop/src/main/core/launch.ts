// How this launch runs, decided once from argv and the environment before Electron is ready, and
// which URLs are the app's own pages.

import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WindowRole } from './ipc'

export interface LaunchMode {
  /** A local fake site and a test credential, in a userData of its own. */
  readonly demo: boolean
  /** Deterministic window titles for the end-to-end suite. Exposes nothing else. */
  readonly e2e: boolean
  /** SITEADAPTER_USER_DATA: an absolute directory to use as userData instead of the default. */
  readonly userData: string | null
}

export function launchMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): LaunchMode {
  const override = env['SITEADAPTER_USER_DATA']
  return {
    demo: env['SITEADAPTER_DEMO'] === '1' || argv.includes('--demo'),
    e2e: env['SITEADAPTER_E2E'] === '1',
    // A relative path would land wherever the app was started from; it is ignored.
    userData: override !== undefined && isAbsolute(override) ? resolve(override) : null,
  }
}

/** The userData directory: the override, or ~/Library/Application Support/siteadapter(-demo). */
export function userDataDir(mode: LaunchMode, appData: string): string {
  if (mode.userData !== null) return mode.userData
  return join(appData, mode.demo ? 'siteadapter-demo' : 'siteadapter')
}

/** Where the renderer's pages come from: the built files, or electron-vite's dev server. */
export type RendererBase =
  | { readonly kind: 'file'; readonly dir: string }
  | { readonly kind: 'dev'; readonly origin: string }

export const PAGES = ['index.html', 'tray.html'] as const
export type Page = (typeof PAGES)[number]

/** The URL of one of the app's pages, with a hash route the caller has already checked. */
export function pageUrl(base: RendererBase, page: Page, hash = ''): string {
  const url = base.kind === 'file' ? pathToFileURL(join(base.dir, page)) : new URL(`/${page}`, base.origin)
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
    control: 'siteadapter',
    tray: 'siteadapter menu',
    confirmation: 'siteadapter: confirm',
    'needs-user': 'siteadapter: sign in',
  }
  const title = `${names[role]}${demo ? ' (demo)' : ''}`
  return e2e && detail !== '' ? `${title} [${detail}]` : e2e ? `${title} [${role}]` : title
}
