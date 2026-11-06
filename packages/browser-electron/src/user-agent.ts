// What the partitions present as. By default both send the UA string of Chrome at the bundled
// Chromium's real major version, with Nick's en-AU language: run 4 of the live probe
// (docs/findings/2026-11-07-woolworths-live-probe.md) showed Akamai refusing Electron's own UA from
// his IP and accepting this one, and D24 allows matching what the person's own browser sends.
// Electron's own UA is an explicit opt-in.
//
// The session's UA and Accept-Language don't reach navigator.language, which follows the Mac's
// language list instead, so each page also gets a DevTools user-agent override. That override has
// to restate the client hints, or navigator.userAgentData comes back empty; by default it restates
// exactly what the engine reports (a GREASE brand and Chromium). Naming Google Chrome too is D24a,
// still open, and only happens when the driver is asked to.

import { SiteAdapterError } from '@siteadapter/core'
import type { UserAgentOverride } from './platform'

/** `chrome`: the clean Chrome UA and en-AU (the default). `electron`: Electron's own, untouched. */
export type UserAgentMode = 'chrome' | 'electron'

/** Client-hint brands: the engine's own (`Chromium`), or also `Google Chrome` (D24a). */
export type ClientHintBrands = 'engine' | 'chrome'

/**
 * The language list the partitions are given, as Electron and the DevTools protocol take it:
 * codes only. Chromium adds the weights itself, so the header goes out as en-AU,en;q=0.9, as
 * Nick's Chrome sends it, and navigator.language is en-AU.
 */
export const LANGUAGES = 'en-AU,en'

/**
 * LANGUAGES as the Accept-Language header Chromium makes of it, for a request the driver sends
 * itself and must word the same way.
 */
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

// Chromium's GREASE brand: a "Not A Brand" entry with varying punctuation, version and position,
// all seeded from the major version, so that servers can't hard-code the list. Mirrors
// components/embedder_support/user_agent_utils.cc. The e2e suite checks the engine-brands
// override against what Electron's Chromium reports with no override at all.
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
const GREASE_VERSIONS = ['8', '99', '24']
const TWO_BRAND_ORDERS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
]
const THREE_BRAND_ORDERS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]

/** The brand names in order: GREASE, Chromium and, for `chrome`, Google Chrome, placed by seed. */
function brandNames(major: number, brands: ClientHintBrands): string[] {
  const grease = `Not${GREASE_CHARS[major % GREASE_CHARS.length]}A${GREASE_CHARS[(major + 1) % GREASE_CHARS.length]}Brand`
  if (brands === 'engine') {
    const [greaseAt, chromiumAt] = TWO_BRAND_ORDERS[major % 2] as [number, number]
    const ordered = ['', '']
    ordered[greaseAt] = grease
    ordered[chromiumAt] = 'Chromium'
    return ordered
  }
  const [greaseAt, chromiumAt, chromeAt] = THREE_BRAND_ORDERS[major % THREE_BRAND_ORDERS.length] as [
    number,
    number,
    number,
  ]
  const ordered = ['', '', '']
  ordered[greaseAt] = grease
  ordered[chromiumAt] = 'Chromium'
  ordered[chromeAt] = 'Google Chrome'
  return ordered
}

/**
 * The DevTools override every page gets with the chrome user agent: the clean UA, en-AU, and client
 * hints that describe this machine and engine as they are, naming Google Chrome only for `chrome`.
 */
export function chromeUserAgentOverride(engine: EngineInfo, brands: ClientHintBrands): UserAgentOverride {
  const major = chromeMajor(engine.chromeVersion)
  const greaseVersion = GREASE_VERSIONS[major % GREASE_VERSIONS.length] as string
  const names = brandNames(major, brands)
  const isGrease = (brand: string) => brand.startsWith('Not')
  const platform = CLIENT_HINT_PLATFORMS[engine.os] ?? LINUX
  return {
    userAgent: cleanChromeUserAgent(engine.chromeVersion, engine.os),
    acceptLanguage: LANGUAGES,
    platform: platform.navigator,
    userAgentMetadata: {
      brands: names.map((brand) => ({ brand, version: isGrease(brand) ? greaseVersion : String(major) })),
      fullVersionList: names.map((brand) => ({
        brand,
        version: isGrease(brand) ? `${greaseVersion}.0.0.0` : engine.chromeVersion,
      })),
      platform: platform.platform,
      platformVersion: engine.systemVersion,
      architecture: engine.arch.startsWith('arm') ? 'arm' : 'x86',
      model: '',
      mobile: false,
      bitness: engine.arch.endsWith('64') ? '64' : '32',
      wow64: false,
      formFactors: ['Desktop'],
    },
  }
}

function chromeMajor(chromeVersion: string): number {
  const major = /^(\d+)\./.exec(chromeVersion)?.[1]
  if (major === undefined) throw new SiteAdapterError('manifest', 'invalid')
  return Number(major)
}
