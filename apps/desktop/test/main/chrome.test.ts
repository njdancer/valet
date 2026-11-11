// @vitest-environment node
// How each window is drawn per platform, how its page learns it, and the banner shortcut.

import { describe, expect, it } from 'vitest'
import {
  CANVAS,
  chromeArgument,
  chromeFromArgv,
  chromeOptions,
  isBannerShortcut,
  platformOf,
  windowChrome,
} from '../../src/main/core/chrome'

describe('window chrome', () => {
  it('insets the traffic lights over a sidebar of vibrancy on a Mac, and keeps a normal frame elsewhere', () => {
    expect(windowChrome('darwin', 'control')).toEqual({
      platform: 'mac',
      frame: 'inset',
      vibrancy: 'sidebar',
    })
    expect(windowChrome('win32', 'control')).toEqual({ platform: 'windows', frame: 'native', vibrancy: null })
    expect(windowChrome('linux', 'tray')).toEqual({ platform: 'linux', frame: 'native', vibrancy: null })
    expect(windowChrome('darwin', 'tray')).toEqual({ platform: 'mac', frame: 'native', vibrancy: 'popover' })
    expect(windowChrome('win32', 'tray').vibrancy).toBe('popover')
    expect(windowChrome('darwin', 'confirmation').vibrancy).toBeNull()
    expect(platformOf('freebsd')).toBe('other')
  })

  it('gives each window the options for its chrome, with the canvas behind anything opaque', () => {
    expect(chromeOptions(windowChrome('darwin', 'control'), false)).toEqual({
      titleBarStyle: 'hiddenInset',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
    })
    expect(chromeOptions(windowChrome('darwin', 'tray'), true)).toEqual({
      vibrancy: 'popover',
      visualEffectState: 'active',
      transparent: true,
      backgroundColor: '#00000000',
    })
    expect(chromeOptions(windowChrome('win32', 'tray'), true)).toEqual({
      backgroundMaterial: 'acrylic',
      backgroundColor: '#00000000',
    })
    expect(chromeOptions(windowChrome('linux', 'control'), true)).toEqual({ backgroundColor: CANVAS.dark })
    expect(chromeOptions(windowChrome('win32', 'control'), false)).toEqual({ backgroundColor: CANVAS.light })
  })

  it('round-trips through the window’s arguments, and falls back to a plain window', () => {
    for (const chrome of [
      windowChrome('darwin', 'control'),
      windowChrome('win32', 'tray'),
      windowChrome('linux', 'needs-user'),
    ])
      expect(chromeFromArgv(['electron', '--foo', chromeArgument(chrome)], 'linux')).toEqual(chrome)
    expect(chromeFromArgv([], 'darwin')).toEqual({ platform: 'mac', frame: 'native', vibrancy: null })
    expect(chromeFromArgv(['--valet-chrome=amiga:inset:sidebar'], 'win32')).toEqual({
      platform: 'windows',
      frame: 'native',
      vibrancy: null,
    })
    expect(chromeFromArgv(['--valet-chrome=mac:odd:glass'], 'darwin')).toEqual({
      platform: 'mac',
      frame: 'native',
      vibrancy: null,
    })
  })
})

describe('the hand-off banner shortcut', () => {
  const key = { type: 'keyDown', key: 'B', shift: true, meta: false, control: false, alt: false }

  it('is ⇧⌘B on a Mac and Ctrl+Shift+B elsewhere', () => {
    expect(isBannerShortcut({ ...key, meta: true }, 'darwin')).toBe(true)
    expect(isBannerShortcut({ ...key, control: true }, 'darwin')).toBe(false)
    expect(isBannerShortcut({ ...key, control: true, key: 'b' }, 'win32')).toBe(true)
    expect(isBannerShortcut({ ...key, meta: true }, 'linux')).toBe(false)
  })

  it('ignores key-ups, other keys, and the shortcut without shift or with alt', () => {
    expect(isBannerShortcut({ ...key, meta: true, type: 'keyUp' }, 'darwin')).toBe(false)
    expect(isBannerShortcut({ ...key, meta: true, key: 'n' }, 'darwin')).toBe(false)
    expect(isBannerShortcut({ ...key, meta: true, shift: false }, 'darwin')).toBe(false)
    expect(isBannerShortcut({ ...key, meta: true, alt: true }, 'darwin')).toBe(false)
  })
})
