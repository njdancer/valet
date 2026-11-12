// The scratch browser's upstream connections (docs/authoring-tools.md#the-scratch-browser-pr-2):
// resolved here, and refused unless every address the name has is public, so an agent can't use a
// site, a redirect or DNS to reach this Mac, the person's network or a tailnet. The connection goes
// to the address that was checked, never a second lookup. The one exception is an address the
// person let a draft reach (a private-network approval, R21), which `allowed` answers for.

import { lookup } from 'node:dns'
import { Socket } from 'node:net'
import { isPublicAddress } from '@valet/sandbox'

export type Lookup = (
  host: string,
  callback: (error: Error | null, addresses: readonly { address: string; family: number }[]) => void,
) => void

const systemLookup: Lookup = (host, callback) =>
  lookup(host, { all: true, verbatim: true }, (error, addresses) => callback(error, addresses ?? []))

export function publicOnlyDial(
  resolve: Lookup = systemLookup,
  allowed: (address: string, port: number) => boolean = () => false,
): (host: string, port: number) => Socket {
  return (host, port) => {
    const socket = new Socket()
    resolve(host, (error, addresses) => {
      const first = addresses[0]
      const reachable = addresses.every((a) => isPublicAddress(a.address) || allowed(a.address, port))
      if (error !== null || first === undefined || !reachable) {
        socket.destroy(new Error('refused'))
        return
      }
      socket.connect({ host: first.address, port })
    })
    return socket
  }
}
