// Where a development build finds the native helpers (swift-bridge). The two that keep Valet's
// secrets, valet-approver and valet-keychain, come first as the signed app bundles
// swift-bridge/build-helper-apps.sh makes: only those carry the provisioning profile that opens
// Valet's secure store. Without them, the plain SwiftPM binaries, which use the classic Keychain.

import { join } from 'node:path'

/** The helpers built as app bundles, by executable name, and the bundle each one is in. */
export const HELPER_APPS: Readonly<Record<string, string>> = {
  'valet-approver': 'Valet Approver.app',
  'valet-keychain': 'Valet Keychain.app',
}

/** `buildDir` is swift-bridge/.build. Null if neither form of the helper is there. */
export function devHelperPath(
  name: string,
  buildDir: string,
  exists: (path: string) => boolean,
): string | null {
  const bundle = HELPER_APPS[name]
  if (bundle !== undefined) {
    const inBundle = join(buildDir, 'apps', 'Debug', bundle, 'Contents', 'MacOS', name)
    if (exists(inBundle)) return inBundle
  }
  const plain = join(buildDir, 'debug', name)
  return exists(plain) ? plain : null
}
