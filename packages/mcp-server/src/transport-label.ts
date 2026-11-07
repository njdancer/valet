// How a session says it reached the endpoint. The stdio bridge sends a header on every request; the
// endpoint reads it once, on the initialize that opens the session. Any local client that holds the
// token could send the same header, so it is a label for the person and the log, never a permission.

import type { ClientTransport } from './tool-caller'

export const TRANSPORT_HEADER = 'x-valet-transport'
export const BRIDGE_TRANSPORT = 'stdio-bridge'

/** The transport an opening request names. Anything but the bridge's exact value is plain HTTP. */
export function transportFrom(header: string | readonly string[] | undefined): ClientTransport {
  return header === BRIDGE_TRANSPORT ? 'stdio-bridge' : 'http'
}
