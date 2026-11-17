// Where the app finds what it runs `protocol` adapters' clients with (docs/imap.md#the-protocol-host):
// the Node runtime's binary (docs/node-runtime.md#shipping-the-binary) and the bundled protocol host
// script. The script is a real file, never inside app.asar, because the sandboxed Node reads it
// directly; and never under Valet's data folder, which the sandbox profile denies.

import { join } from 'node:path'

/** The main build emits the host here, beside index.js (protocol-host-plugin.ts). */
export const PROTOCOL_HOST_FILE = 'protocol-host.cjs'
/** Its path inside the app's files, which electron-builder unpacks beside app.asar. */
export const PROTOCOL_HOST_PACKAGED = `out/main/${PROTOCOL_HOST_FILE}`
/** The Node runtime's executable, beside the app's own when packaged. */
export const NODE_RUNTIME_NAME = 'valet-node'
/** A development build's copy, made by scripts/node-runtime.mjs, relative to apps/desktop. */
export const NODE_RUNTIME_DEV = '.node-runtime/valet-node'

export interface ProtocolHostPlaces {
  readonly packaged: boolean
  /** process.execPath: Contents/MacOS/<app> when packaged. */
  readonly execPath: string
  /** process.resourcesPath: Contents/Resources when packaged. */
  readonly resourcesPath: string
  /** The main bundle's own folder (out/main). */
  readonly mainDir: string
  /** app.getAppPath(): apps/desktop in a development run. */
  readonly appPath: string
  readonly exists: (path: string) => boolean
}

/**
 * The binary and script, or null if either is missing: then protocol adapters' calls end
 * not-granted, and sign-in mail is unavailable.
 */
export function protocolHostPaths(
  places: ProtocolHostPlaces,
): { readonly nodeBinary: string; readonly hostScript: string } | null {
  const nodeBinary = places.packaged
    ? join(places.execPath, '..', NODE_RUNTIME_NAME)
    : join(places.appPath, NODE_RUNTIME_DEV)
  const hostScript = places.packaged
    ? join(places.resourcesPath, 'app.asar.unpacked', PROTOCOL_HOST_PACKAGED)
    : join(places.mainDir, PROTOCOL_HOST_FILE)
  return places.exists(nodeBinary) && places.exists(hostScript) ? { nodeBinary, hostScript } : null
}
