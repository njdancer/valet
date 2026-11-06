import type { AdapterManifest } from '@siteadapter/core'
import { ElectronSessionDriver, type ManifestOptions } from './driver'
import type { Dial } from './egress-proxy'

export { SurfaceAuthPage, type TypeOptions } from './auth-page'
export { cookieHost, cookieSetDetails, cookiesForDomains } from './cookies'
export type { BlockedRequest, DriverOptions, ManifestOptions } from './driver'
export { ElectronSessionDriver } from './driver'
export { type Dial, parseAuthority, startEgressProxy } from './egress-proxy'
export {
  ambiguousPath,
  authNavigationAllowed,
  type BlockReason,
  decideToolRequest,
  deniedPath,
  egressAllowed,
  type FrameRule,
  isApiCall,
  pathDigest,
  requestTarget,
} from './guards'
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
  platform: { readonly dial?: Dial } = {},
): Promise<ElectronSessionDriver> {
  const { electronPlatform } = await import('./electron/platform')
  return ElectronSessionDriver.forManifest(electronPlatform(platform), manifest, options)
}
