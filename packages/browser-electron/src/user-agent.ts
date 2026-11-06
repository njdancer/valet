// What the partitions present as. By default both send the UA string of Chrome at the bundled
// Chromium's real major version, with Nick's en-AU language: run 4 of the live probe
// (docs/findings/2026-11-07-woolworths-live-probe.md) showed Akamai refusing Electron's own UA from
// his IP and accepting this one, and D24 allows matching what the person's own browser sends.
// Electron's own UA is an explicit opt-in.
//
// Client-hint brands are D24a, still open: by default they stay the engine's own ("Chromium").
// `chromeUserAgentOverride` builds the override that would make them say "Google Chrome" too; the
// driver only applies it when asked.

import { SiteAdapterError } from '@siteadapter/core'
import type { UserAgentOverride } from './platform'

/** `chrome`: the clean Chrome UA and en-AU (the default). `electron`: Electron's own, untouched. */
export type UserAgentMode = 'chrome' | 'electron'

/** Accept-Language as Nick's Chrome sends it. navigator.language follows its first entry. */
export const ACCEPT_LANGUAGE = 'en-AU,en;q=0.9'

const PLATFORM_TOKENS: Readonly<Record<string, string>> = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
}

/** Chrome's reduced UA string: major version only, frozen platform token. */
export function cleanChromeUserAgent(chromeVersion: string, os: string): string {
  return `Mozilla/5.0 (${PLATFORM_TOKENS[os] ?? PLATFORM_TOKENS['linux']}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor(chromeVersion)}.0.0.0 Safari/537.36`
}

/** The engine a platform reports, as the override needs it. */
export interface EngineInfo {
  /** Full Chromium version, e.g. 152.0.7977.169. */
  readonly chromeVersion: string
  readonly os: string
  /** The OS's own version, e.g. 15.5.0 on macOS. */
  readonly systemVersion: string
  /** Node's process.arch: arm64, x64, … */
  readonly arch: string
}

const LINUX = { platform: 'Linux', navigator: 'Linux x86_64' }
const CLIENT_HINT_PLATFORMS: Readonly<Record<string, { platform: string; navigator: string }>> = {
  darwin: { platform: 'macOS', navigator: 'MacIntel' },
  win32: { platform: 'Windows', navigator: 'Win32' },
  linux: LINUX,
}

// Chromium's GREASE brand: a "Not A Brand" entry with varying punctuation and a position, both
// seeded from the major version, so that servers can't hard-code the list. Mirrors
// components/embedder_support/user_agent_utils.cc; check it against a real Chrome of the same
// major before relying on it.
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
const GREASE_VERSIONS = ['8', '99', '24']
const ORDERS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]

function brandList(major: number, version: (brand: string) => string) {
  const grease = `Not${GREASE_CHARS[major % GREASE_CHARS.length]}A${GREASE_CHARS[(major + 1) % GREASE_CHARS.length]}Brand`
  const [greasePosition, chromiumPosition, chromePosition] = ORDERS[major % ORDERS.length] as [
    number,
    number,
    number,
  ]
  const ordered = ['', '', '']
  ordered[greasePosition] = grease
  ordered[chromiumPosition] = 'Chromium'
  ordered[chromePosition] = 'Google Chrome'
  return ordered.map((brand) => ({ brand, version: version(brand) }))
}

/**
 * The DevTools override that makes a page's client hints name Google Chrome, as Nick's Chrome does,
 * alongside the clean UA and en-AU. Off unless DriverOptions.clientHints is 'chrome' (D24a).
 */
export function chromeUserAgentOverride(engine: EngineInfo): UserAgentOverride {
  const major = chromeMajor(engine.chromeVersion)
  const greaseVersion = GREASE_VERSIONS[major % GREASE_VERSIONS.length] as string
  const platform = CLIENT_HINT_PLATFORMS[engine.os] ?? LINUX
  const arm = engine.arch.startsWith('arm')
  return {
    userAgent: cleanChromeUserAgent(engine.chromeVersion, engine.os),
    acceptLanguage: ACCEPT_LANGUAGE,
    platform: platform.navigator,
    userAgentMetadata: {
      brands: brandList(major, (brand) => (brand.startsWith('Not') ? greaseVersion : String(major))),
      fullVersionList: brandList(major, (brand) =>
        brand.startsWith('Not') ? `${greaseVersion}.0.0.0` : engine.chromeVersion,
      ),
      platform: platform.platform,
      platformVersion: engine.systemVersion,
      architecture: arm ? 'arm' : 'x86',
      model: '',
      mobile: false,
      bitness: engine.arch.endsWith('64') ? '64' : '32',
      wow64: false,
    },
  }
}

function chromeMajor(chromeVersion: string): number {
  const major = /^(\d+)\./.exec(chromeVersion)?.[1]
  if (major === undefined) throw new SiteAdapterError('manifest', 'invalid')
  return Number(major)
}
