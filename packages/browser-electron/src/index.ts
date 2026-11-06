import type { AdapterManifest } from '@siteadapter/core'
import { ElectronSessionDriver, type ManifestOptions } from './driver'
import type { Dial } from './egress-proxy'

export { type AuthPageOptions, SurfaceAuthPage } from './auth-page'
export { cookieHost, cookieSetDetails, cookiesForDomains } from './cookies'
export type { DriverOptions, ManifestOptions } from './driver'
export { ElectronSessionDriver } from './driver'
export { type Dial, parseAuthority, startEgressProxy } from './egress-proxy'
export {
  authNavigationAllowed,
  type BlockReason,
  decideToolRequest,
  egressAllowed,
  isApiCall,
  purposeAllowed,
  type RequestDecision,
  requestTarget,
} from './guards'
export { needsUserTitle } from './needs-user'
export { partitionName } from './partitions'
export type * from './platform'
export { CHROMIUM_SWITCHES, hardenProcess } from './process-hardening'
export { type Announce, SurfaceToolPage } from './tool-page'
export {
  type ClientHintBrands,
  chromeUserAgentOverride,
  cleanChromeUserAgent,
  type EngineInfo,
  LANGUAGES,
  type UserAgentMode,
} from './user-agent'

// Electron is loaded only when this is called, so that this package can be imported, and
// its pure parts tested, in plain Node.

/** A driver over real Electron for one adapter. Call from the main process after app ready. */
export async function createElectronSessionDriver(
  manifest: AdapterManifest,
  options: ManifestOptions = {},
  platform: { readonly dial?: Dial } = {},
): Promise<ElectronSessionDriver> {
  const { electronPlatform } = await import('./electron/platform')
  return ElectronSessionDriver.forManifest(electronPlatform(platform), manifest, options)
}
