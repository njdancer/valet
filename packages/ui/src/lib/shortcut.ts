// Keyboard shortcuts are written once, platform-neutral ("mod+K", "mod+shift+P", "alt+T"), and shown
// the way each OS writes them: ⌘K on macOS, Ctrl+K on Windows and Linux. Shortcuts that are already
// formatted ("⌘K", "Esc") pass through unchanged.

import type { Platform } from './platform'

const macSymbols: Record<string, string> = {
  mod: '⌘',
  cmd: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  enter: '↩',
  backspace: '⌫',
  esc: 'Esc',
  escape: 'Esc',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
}
const pcNames: Record<string, string> = {
  mod: 'Ctrl',
  cmd: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  backspace: 'Backspace',
  esc: 'Esc',
  escape: 'Esc',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
}
// The names aria-keyshortcuts expects (WAI-ARIA uses KeyboardEvent.key values).
const ariaNames: Record<string, string> = {
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  backspace: 'Backspace',
  esc: 'Escape',
  escape: 'Escape',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}

const isNeutral = (shortcut: string) => /^[a-z]+\+/i.test(shortcut) && shortcut.length > 1

/** The platform the page runs on, from data-platform on <html> (set by applyPlatform). */
export function currentPlatform(): Platform {
  const p = typeof document === 'undefined' ? undefined : document.documentElement.dataset['platform']
  return p === 'mac' || p === 'windows' || p === 'linux' ? p : 'other'
}

const keyLabel = (key: string) =>
  key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1)

/** "mod+shift+K" → "⇧⌘K" on macOS (Apple's modifier order), "Ctrl+Shift+K" elsewhere. */
export function formatShortcut(shortcut: string, platform: Platform = currentPlatform()): string {
  if (!isNeutral(shortcut)) return shortcut
  const parts = shortcut.split('+').map((p) => p.trim())
  if (platform === 'mac') {
    const order = ['ctrl', 'alt', 'option', 'shift', 'mod', 'cmd']
    const mods = parts.slice(0, -1).map((p) => p.toLowerCase())
    mods.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const key = parts.at(-1) as string
    return mods.map((m) => macSymbols[m] ?? m).join('') + (macSymbols[key.toLowerCase()] ?? keyLabel(key))
  }
  return parts.map((p) => pcNames[p.toLowerCase()] ?? keyLabel(p)).join('+')
}

/** The aria-keyshortcuts value: "Meta+K" on macOS, "Control+K" elsewhere. Undefined if not neutral. */
export function ariaShortcut(shortcut: string, platform: Platform = currentPlatform()): string | undefined {
  if (!isNeutral(shortcut)) return undefined
  return shortcut
    .split('+')
    .map((p) => {
      const k = p.trim().toLowerCase()
      if (k === 'mod' || k === 'cmd') return platform === 'mac' ? 'Meta' : 'Control'
      return ariaNames[k] ?? keyLabel(p.trim())
    })
    .join('+')
}
