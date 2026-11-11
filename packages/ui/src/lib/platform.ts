// The platform decides the floating material (materials.css): glass on macOS, frost elsewhere.
// The renderer can't read process.platform, so it reads the user agent once and sets
// data-platform on <html>. The app may also set it from the main process's answer.

export type Platform = 'mac' | 'windows' | 'linux' | 'other'

export function detectPlatform(userAgent: string): Platform {
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'mac'
  if (/Windows/.test(userAgent)) return 'windows'
  if (/Linux|X11|CrOS/.test(userAgent)) return 'linux'
  return 'other'
}

export function applyPlatform(root: HTMLElement, platform: Platform): void {
  root.dataset['platform'] = platform
}

export type Theme = 'light' | 'dark' | 'system'

/** Pins the theme, or with "system" follows the OS. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  if (theme === 'system') delete root.dataset['theme']
  else root.dataset['theme'] = theme
}
