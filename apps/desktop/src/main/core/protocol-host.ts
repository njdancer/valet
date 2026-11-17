// Where the app finds what it runs `protocol` adapters' clients with (docs/imap.md#the-protocol-host):
// the bundled protocol host script, run by the Node runtime's binary (docs/node-runtime.md). The script is a real file, never inside app.asar, because the sandboxed Node reads it
// directly; and never under Valet's data folder, which the sandbox profile denies.

import { join } from 'node:path'

/** The main build emits the host here, beside index.js (protocol-host-plugin.ts). */
export const PROTOCOL_HOST_FILE = 'protocol-host.cjs'
/** Its path inside the app's files, which electron-builder unpacks beside app.asar. */
export const PROTOCOL_HOST_PACKAGED = `out/main/${PROTOCOL_HOST_FILE}`
export interface ProtocolHostPlaces {
  readonly packaged: boolean
  /** process.resourcesPath: Contents/Resources when packaged. */
  readonly resourcesPath: string
  /** The main bundle's own folder (out/main). */
  readonly mainDir: string
  readonly exists: (path: string) => boolean
}

/**
 * The bundled host script, or null if it is missing. The binary that runs it is the raw runtime's
 * own (raw-runtime.ts nodeRuntimeBinary); without either, protocol adapters' calls end not-granted
 * and sign-in mail is unavailable.
 */
export function protocolHostScript(places: ProtocolHostPlaces): string | null {
  const hostScript = places.packaged
    ? join(places.resourcesPath, 'app.asar.unpacked', PROTOCOL_HOST_PACKAGED)
    : join(places.mainDir, PROTOCOL_HOST_FILE)
  return places.exists(hostScript) ? hostScript : null
}
