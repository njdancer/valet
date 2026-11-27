// The scratch browser's upstream connections (docs/authoring-tools.md#the-scratch-browser-pr-2):
// resolved here, and refused unless every address the name has is public, so an agent can't use a
// site, a redirect or DNS to reach this Mac, the person's network or a tailnet. The connection goes
// to the address that was checked, never a second lookup. The one exception is an address the
// person let a draft reach (a private-network approval, R21), which `allowed` answers for.

import { lookup } from 'node:dns'
import { BlockList, isIP, Socket } from 'node:net'
import { networkInterfaces as osInterfaces } from 'node:os'
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

/**
 * An agent's browser session's dial with its network settings (docs/agent-browser.md, "Network"):
 * public addresses as always; with `homeNetwork`, private ones too (the home network, a tailnet),
 * but never loopback, link-local or one of this Mac's own addresses, so a session can't reach Valet
 * or anything else listening on the Mac. With `interface`, every connection leaves from that
 * interface's address (macOS then routes by that interface alone), and a name with no address for
 * the family needed is refused rather than sent out another way.
 */
export function agentSessionDial(
  network: { readonly homeNetwork: boolean; readonly interface: string | null },
  options: {
    readonly resolve?: Lookup
    readonly interfaces?: () => NodeJS.Dict<
      readonly { readonly address: string; readonly family: string | number; readonly internal: boolean }[]
    >
    readonly timeoutMs?: number
  } = {},
): (host: string, port: number) => Socket {
  const resolve = options.resolve ?? systemLookup
  const interfaces = options.interfaces ?? osInterfaces
  const timeoutMs = options.timeoutMs ?? 10_000
  return (host, port) => {
    const socket = new Socket()
    resolve(host, (error, addresses) => {
      const all = Object.values(interfaces()).flatMap((list) => list ?? [])
      const own = new Set(all.map((a) => plain(a.address)))
      const reachable = (address: string) =>
        isPublicAddress(address) ||
        (network.homeNetwork && isHomeAddress(address) && !own.has(plain(address)))
      const first = addresses[0]
      if (error !== null || first === undefined || !addresses.every((a) => reachable(a.address))) {
        socket.destroy(new Error('refused'))
        return
      }
      let localAddress: string | undefined
      if (network.interface !== null) {
        const family = first.family === 6 ? 6 : 4
        const pinned = (interfaces()[network.interface] ?? []).find(
          (a) =>
            !a.internal &&
            (a.family === `IPv${family}` || a.family === family) &&
            !a.address.toLowerCase().startsWith('fe80:'),
        )
        if (pinned === undefined) {
          socket.destroy(new Error('interface'))
          return
        }
        localAddress = pinned.address
      }
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')))
      socket.once('connect', () => socket.setTimeout(0))
      socket.connect({ host: first.address, port, ...(localAddress === undefined ? {} : { localAddress }) })
    })
    return socket
  }
}

const plain = (address: string) =>
  address
    .toLowerCase()
    .replace(/^::ffff:/, '')
    .split('%')[0] ?? ''

const HOME = new BlockList()
for (const [net, bits] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  // Shared address space: carrier NAT, and a tailnet's addresses.
  ['100.64.0.0', 10],
] as const)
  HOME.addSubnet(net, bits, 'ipv4')
// Unique local addresses: a home network's, and a tailnet's.
HOME.addSubnet('fc00::', 7, 'ipv6')

/** A private address on a home network or tailnet: not loopback, link-local or anything else. */
export function isHomeAddress(address: string): boolean {
  const a = plain(address)
  const family = isIP(a)
  if (family === 0) return false
  return HOME.check(a, family === 4 ? 'ipv4' : 'ipv6')
}
