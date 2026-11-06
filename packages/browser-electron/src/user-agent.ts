// An optional clean Chrome user agent. Off by default: Electron's own UA passed Akamai in the live
// probe (docs/findings/2026-11-07-woolworths-live-probe.md). When on, it names the same Chrome
// major version the bundled Chromium really is, so the UA and the engine's behaviour agree.

export type UserAgentMode = 'default' | 'chrome'

const PLATFORM_TOKENS: Readonly<Record<string, string>> = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
}

/** Chrome's reduced UA string: major version only, frozen platform token. */
export function cleanChromeUserAgent(chromeVersion: string, os: string): string {
  const major = /^(\d+)\./.exec(chromeVersion)?.[1]
  if (major === undefined) throw new Error('unrecognised Chrome version')
  const platform = PLATFORM_TOKENS[os] ?? PLATFORM_TOKENS['linux']
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}
