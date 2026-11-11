// How each window is drawn on each platform, and how its page learns it. Plain data, so it is tested
// without Electron and the sandboxed preload can import it (no Node imports).
//
// The main process passes `--valet-chrome=<platform>:<frame>:<vibrancy>` in the window's
// additionalArguments; the preload reads it back (chromeFromArgv) and exposes window.valetChrome,
// from which the renderer sets data-platform, data-frame and data-vibrancy on <html>.

import type { WindowChrome } from '../../shared/api'

export const CHROME_ARG = '--valet-chrome='

/** The design system's canvas (packages/ui tokens.css, --bg-canvas: gray-50 and gray-950). */
export const CANVAS = { light: '#f6f7f9', dark: '#121418' } as const

export type ChromeRole = 'control' | 'tray' | 'confirmation' | 'needs-user'

export function platformOf(platform: string): WindowChrome['platform'] {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'other'
}

/**
 * The control panel on a Mac: traffic lights inset over a sidebar of window vibrancy. The tray
 * popover: popover material on a Mac, acrylic on Windows 11. Everything else: a plain window.
 */
export function windowChrome(platform: string, role: ChromeRole): WindowChrome {
  const os = platformOf(platform)
  if (role === 'control')
    return os === 'mac'
      ? { platform: os, frame: 'inset', vibrancy: 'sidebar' }
      : { platform: os, frame: 'native', vibrancy: null }
  if (role === 'tray')
    return { platform: os, frame: 'native', vibrancy: os === 'mac' || os === 'windows' ? 'popover' : null }
  return { platform: os, frame: 'native', vibrancy: null }
}

export function chromeArgument(chrome: WindowChrome): string {
  return `${CHROME_ARG}${chrome.platform}:${chrome.frame}:${chrome.vibrancy ?? 'none'}`
}

const PLATFORMS: readonly WindowChrome['platform'][] = ['mac', 'windows', 'linux', 'other']

/** What the preload exposes: the main process's argument, or the plain window for this platform. */
export function chromeFromArgv(argv: readonly string[], platform: string): WindowChrome {
  const fallback: WindowChrome = { platform: platformOf(platform), frame: 'native', vibrancy: null }
  const arg = argv.find((a) => a.startsWith(CHROME_ARG))
  if (arg === undefined) return fallback
  const [os, frame, vibrancy] = arg.slice(CHROME_ARG.length).split(':')
  if (!PLATFORMS.includes(os as WindowChrome['platform'])) return fallback
  return {
    platform: os as WindowChrome['platform'],
    frame: frame === 'inset' ? 'inset' : 'native',
    vibrancy: vibrancy === 'sidebar' || vibrancy === 'popover' ? vibrancy : null,
  }
}

/** BrowserWindow options for a window's chrome (a subset of BrowserWindowConstructorOptions). */
export interface ChromeOptions {
  readonly titleBarStyle?: 'hiddenInset'
  readonly vibrancy?: 'sidebar' | 'popover'
  readonly visualEffectState?: 'followWindow' | 'active'
  readonly backgroundMaterial?: 'acrylic'
  readonly transparent?: boolean
  readonly backgroundColor: string
}

/**
 * The control panel's background is the canvas for the current theme, so nothing flashes white in
 * dark mode before the page paints; with vibrancy on a Mac the window itself is clear, since an
 * opaque background would cover the sidebar's material, and the page paints the canvas.
 */
export function chromeOptions(chrome: WindowChrome, dark: boolean): ChromeOptions {
  const canvas = dark ? CANVAS.dark : CANVAS.light
  if (chrome.vibrancy === 'sidebar')
    return {
      titleBarStyle: 'hiddenInset',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
    }
  if (chrome.vibrancy === 'popover' && chrome.platform === 'mac')
    return {
      vibrancy: 'popover',
      visualEffectState: 'active',
      transparent: true,
      backgroundColor: '#00000000',
    }
  if (chrome.vibrancy === 'popover') return { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
  return { backgroundColor: canvas }
}

/** A key press as Electron's before-input-event reports it. */
export interface KeyInput {
  readonly type: string
  readonly key: string
  readonly shift: boolean
  readonly meta: boolean
  readonly control: boolean
  readonly alt: boolean
}

/**
 * ⇧⌘B on a Mac, Ctrl+Shift+B elsewhere: in a site's login window, brings the hand-off banner
 * forward and focuses it, so the person can reach "I've logged in" from the keyboard.
 */
export function isBannerShortcut(input: KeyInput, platform: string): boolean {
  if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'b' || !input.shift || input.alt) return false
  return platformOf(platform) === 'mac' ? input.meta && !input.control : input.control && !input.meta
}
