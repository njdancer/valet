import type { AdapterManifest } from '@siteadapter/core'
import { ElectronSessionDriver, type ManifestOptions } from './driver'

export { SurfaceAuthPage } from './auth-page'
export { cookieHost, cookieSetDetails, cookiesForDomains } from './cookies'
export type { BlockedRequest, DriverOptions, ManifestOptions } from './driver'
export { ElectronSessionDriver } from './driver'
export { authNavigationAllowed, egressAllowed, requestTarget } from './guards'
export { partitionName } from './partitions'
export type * from './platform'
export { CHROMIUM_SWITCHES, hardenProcess } from './process-hardening'
export { SurfaceToolPage } from './tool-page'
export { cleanChromeUserAgent, type UserAgentMode } from './user-agent'

// Electron is loaded only when this is called, so that this package can be imported, and
// its pure parts tested, in plain Node.

/** A driver over real Electron for one adapter. Call from the main process after app ready. */
export async function createElectronSessionDriver(
  manifest: AdapterManifest,
  options: ManifestOptions = {},
): Promise<ElectronSessionDriver> {
  const { electronPlatform } = await import('./electron/platform')
  return ElectronSessionDriver.forManifest(electronPlatform(), manifest, options)
}
