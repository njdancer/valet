import type { AdapterManifest } from '@valet/core'
import { ElectronSessionDriver, type ManifestOptions } from './driver'
import type { Dial } from './egress-proxy'

import { ScratchBrowser, type ScratchOptions } from './scratch'

export { type AuthPageOptions, SurfaceAuthPage } from './auth-page'
export { cookieHost, cookieSetDetails, cookiesForDomains } from './cookies'
export type { AuthPageRequest, DriverOptions, ManifestOptions } from './driver'
export { ElectronSessionDriver } from './driver'
export { type Dial, parseAuthority, startEgressProxy } from './egress-proxy'
export {
  apiRoots,
  authBlock,
  authNavigationAllowed,
  type BlockReason,
  type Budget,
  decideToolRequest,
  egressAllowed,
  isApiCall,
  purposeAllowed,
  type RequestDecision,
  requestTarget,
  underApiRoot,
} from './guards'
export { needsUserTitle } from './needs-user'
export { partitionName, trialPartitionName } from './partitions'
export type * from './platform'
export { CHROMIUM_SWITCHES, hardenProcess } from './process-hardening'
export {
  type LogEntry,
  SCRATCH_LIMITS,
  ScratchBrowser,
  ScratchError,
  type ScratchOptions,
  type ScratchRules,
  type ScratchSnapshot,
  type Target as ScratchTarget,
} from './scratch'
export {
  type ChainState,
  hopHeaders,
  MAX_PROBE_BYTES,
  MAX_PROBE_REDIRECTS,
  PROBE_ACCEPT,
  ProbeRedirects,
  type ProbeRequest,
  probeFailure,
  probeResult,
  probeTarget,
  referrerFor,
  sessionProbe,
} from './session-fetch'
export { SessionValues } from './session-values'
export { type Announce, SurfaceToolPage } from './tool-page'
export {
  ACCEPT_LANGUAGE,
  type ClientHintBrands,
  chromeUserAgentOverride,
  cleanChromeUserAgent,
  type EngineInfo,
  LANGUAGES,
  pageIdentityHeaders,
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

/**
 * A scratch browser over real Electron (docs/authoring-tools.md#the-scratch-browser-pr-2). Call from
 * the main process after app ready. Give each open its own partition name, so nothing one left
 * behind is there the next time.
 */
export async function openElectronScratchBrowser(
  options: Omit<ScratchOptions, 'platform'>,
): Promise<ScratchBrowser> {
  const { electronPlatform } = await import('./electron/platform')
  return ScratchBrowser.open({ ...options, platform: electronPlatform() })
}
