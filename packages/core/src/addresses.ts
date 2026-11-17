// IP addresses as the egress broker and the manifest see them (docs/adapter-kinds.md#f1-the-egress-broker).
// Pure TypeScript with no Node imports, so the manifest schema can use it wherever core runs.
//
// Two questions matter. Is an address the public internet (a host name may only ever be dialled at
// one of those)? And is it an address on the person's own network that a manifest may name as a
// private host (an IP literal, never a name, so DNS can't redirect it)?

import { isHostname } from './origins'

/** Four bytes, or null unless `value` is a dotted quad in plain decimal with no leading zeros. */
export function parseIPv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    bytes.push(n)
  }
  return bytes
}

/**
 * Sixteen bytes, or null unless `value` is an IPv6 address: hex groups, at most one "::", an
 * optional dotted-quad tail. Zone ids ("%en0") and brackets are refused.
 */
export function parseIPv6(value: string): number[] | null {
  if (value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) return null
  let tail: number[] = []
  let head = value
  const lastColon = value.lastIndexOf(':')
  if (value.includes('.')) {
    const v4 = parseIPv4(value.slice(lastColon + 1))
    if (v4 === null) return null
    tail = v4
    // "::1.2.3.4" leaves "::" and "a::1.2.3.4" leaves "a::"; "a:b:c:d:e:f:1.2.3.4" leaves "a:...:f".
    head = value.slice(0, lastColon + 1)
    if (!head.endsWith('::')) head = head.slice(0, -1)
  }
  const doubled = head.split('::')
  if (doubled.length > 2) return null
  const groupsOf = (text: string): number[] | null => {
    if (text === '') return []
    const groups: number[] = []
    for (const group of text.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      groups.push(Number.parseInt(group, 16))
    }
    return groups
  }
  const want = tail.length === 4 ? 6 : 8
  let groups: number[]
  if (doubled.length === 2) {
    const left = groupsOf(doubled[0] as string)
    const right = groupsOf(doubled[1] as string)
    if (left === null || right === null || left.length + right.length >= want) return null
    groups = [...left, ...new Array<number>(want - left.length - right.length).fill(0), ...right]
  } else {
    const all = groupsOf(head)
    if (all === null || all.length !== want) return null
    groups = all
  }
  const bytes: number[] = []
  for (const group of groups) bytes.push(group >> 8, group & 255)
  return [...bytes, ...tail]
}

/** 4 or 6 for an IP literal as parsed above, 0 for anything else. */
export function ipFamily(value: string): 0 | 4 | 6 {
  if (parseIPv4(value) !== null) return 4
  if (parseIPv6(value) !== null) return 6
  return 0
}

/** An address in its one written form: dotted quad, or RFC 5952 IPv6 (lower case, longest zero run as "::"). */
export function canonicalAddress(value: string): string | null {
  const v4 = parseIPv4(value)
  if (v4 !== null) return v4.join('.')
  const v6 = parseIPv6(value)
  if (v6 === null) return null
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((v6[i] as number) << 8) | (v6[i + 1] as number))
  let best = -1
  let bestLength = 1
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLength) {
      best = i
      bestLength = j - i
    }
    i = j
  }
  const hex = groups.map((g) => g.toString(16))
  if (best === -1) return hex.join(':')
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLength).join(':')}`
}

type Range = readonly [prefix: readonly number[], bits: number]

function inRange(bytes: readonly number[], [prefix, bits]: Range): boolean {
  for (let bit = 0; bit < bits; bit++) {
    const byte = bit >> 3
    const mask = 0x80 >> (bit & 7)
    if (((bytes[byte] as number) & mask) !== ((prefix[byte] ?? 0) & mask)) return false
  }
  return true
}

const v4 = (text: string, bits: number): Range => [parseIPv4(text) as number[], bits]
const v6 = (text: string, bits: number): Range => [parseIPv6(text) as number[], bits]

/** Every IPv4 range that isn't the public internet. */
const NOT_PUBLIC_V4: readonly Range[] = [
  v4('0.0.0.0', 8),
  v4('10.0.0.0', 8),
  v4('100.64.0.0', 10),
  v4('127.0.0.0', 8),
  v4('169.254.0.0', 16),
  v4('172.16.0.0', 12),
  v4('192.0.0.0', 24),
  v4('192.0.2.0', 24),
  v4('192.88.99.0', 24),
  v4('192.168.0.0', 16),
  v4('198.18.0.0', 15),
  v4('198.51.100.0', 24),
  v4('203.0.113.0', 24),
  v4('224.0.0.0', 4),
  v4('240.0.0.0', 4),
]

/** Every IPv6 range that isn't the public internet. IPv4-mapped and compatible forms are unwrapped first. */
const NOT_PUBLIC_V6: readonly Range[] = [
  v6('::', 128),
  v6('::1', 128),
  // IPv4-translated (SIIT, RFC 2765): a translator on the path reaches the embedded IPv4 address.
  v6('::ffff:0:0:0', 96),
  v6('64:ff9b::', 96),
  v6('64:ff9b:1::', 48),
  v6('100::', 64),
  v6('2001::', 23),
  v6('2001:db8::', 32),
  v6('2002::', 16),
  v6('fc00::', 7),
  v6('fe80::', 10),
  v6('fec0::', 10),
  v6('ff00::', 8),
]

/** The IPv4 address an IPv6 one stands for (mapped ::ffff:a.b.c.d or the old compatible ::a.b.c.d), or null. */
function embeddedIPv4(bytes: readonly number[]): number[] | null {
  const zeros = bytes.slice(0, 10).every((b) => b === 0)
  if (!zeros) return null
  const mid = [bytes[10], bytes[11]]
  if (mid[0] === 0xff && mid[1] === 0xff) return bytes.slice(12)
  // ::a.b.c.d, but not :: or ::1, which are their own (non-public) addresses.
  if (mid[0] === 0 && mid[1] === 0 && !bytes.slice(12, 15).every((b) => b === 0)) return bytes.slice(12)
  return null
}

/** True only for an IP literal on the public internet. A name, or anything unparseable, is false. */
export function isPublicAddress(address: string): boolean {
  const four = parseIPv4(address)
  if (four !== null) return !NOT_PUBLIC_V4.some((r) => inRange(four, r))
  const six = parseIPv6(address)
  if (six === null) return false
  const inner = embeddedIPv4(six)
  if (inner !== null) return !NOT_PUBLIC_V4.some((r) => inRange(inner, r))
  return !NOT_PUBLIC_V6.some((r) => inRange(six, r))
}

/**
 * Ranges a manifest's private host may be in: the person's own network (RFC 1918), carrier-grade
 * NAT (which VPN overlays such as Tailscale use) and IPv6 unique local addresses. Never loopback
 * (that is this Mac, and Valet's own ports), link-local (where cloud metadata services live),
 * multicast, or anything public.
 */
const PRIVATE_HOST_RANGES_V4: readonly Range[] = [
  v4('10.0.0.0', 8),
  v4('172.16.0.0', 12),
  v4('192.168.0.0', 16),
  v4('100.64.0.0', 10),
]
const PRIVATE_HOST_RANGES_V6: readonly Range[] = [v6('fc00::', 7)]

/**
 * Addresses in those ranges that a VPN client on this Mac answers itself (Tailscale's resolver and
 * service address), so a private host there would be this Mac, which is never one.
 */
const SERVED_BY_THIS_MAC_V4: readonly Range[] = [v4('100.100.100.100', 32)]
const SERVED_BY_THIS_MAC_V6: readonly Range[] = [v6('fd7a:115c:a1e0::53', 128)]

/** True for an address, in its canonical form, that a manifest may declare as a private host. */
export function isPrivateHostAddress(address: string): boolean {
  if (canonicalAddress(address) !== address) return false
  const four = parseIPv4(address)
  if (four !== null)
    return (
      PRIVATE_HOST_RANGES_V4.some((r) => inRange(four, r)) &&
      !SERVED_BY_THIS_MAC_V4.some((r) => inRange(four, r))
    )
  const six = parseIPv6(address)
  return (
    six !== null &&
    PRIVATE_HOST_RANGES_V6.some((r) => inRange(six, r)) &&
    !SERVED_BY_THIS_MAC_V6.some((r) => inRange(six, r))
  )
}

/** `address:port` as a URL's host would say it: IPv6 in brackets. */
export function hostPort(address: string, port: number): string {
  return `${address.includes(':') ? `[${address}]` : address}:${port}`
}

/**
 * `host:port` as the runtime writes a raw adapter's endpoint: lower case, an IP literal canonical
 * and without brackets, a port from 1 to 65535. Null if it isn't one.
 */
export function parseEndpoint(value: string): { readonly host: string; readonly port: number } | null {
  if (typeof value !== 'string') return null
  const match = /^(.+):(\d{1,5})$/.exec(value)
  if (match === null) return null
  const host = (match[1] as string).toLowerCase()
  const port = Number(match[2])
  if (port < 1 || port > 65_535) return null
  const literal = canonicalAddress(host)
  if (literal !== null) return literal === host ? { host, port } : null
  return isHostname(host) ? { host, port } : null
}
