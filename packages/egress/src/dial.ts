// Opening a connection to one endpoint, the broker's way (docs/adapter-kinds.md#f1-the-egress-broker):
//
// - a public endpoint is an exact host name on port 443. The broker resolves it itself, and every
//   address the name resolves to must be public, so a name that answers with a private address (or
//   with both kinds, for a rebinding race) reaches nothing. The socket is opened to the checked
//   address, never to the name again, so a second DNS answer can't change where it goes. TLS is
//   verified against the name with the system's trust store.
// - a private endpoint is an IP literal from the manifest, on its declared port and scheme. It is
//   never one of this Mac's own addresses (reaching this Mac is a local-service exception's job,
//   and Valet's own ports must stay out of reach). Its certificate is either verified normally or,
//   when the manifest pins one, compared byte for byte by its SHA-256, before anything is sent.
//
// Nothing here knows about adapters or runs: the broker (broker.ts) decides what may be dialled.

import { createHash } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { connect as netConnect, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { type PeerCertificate, type TLSSocket, connect as tlsConnect } from 'node:tls'
import { canonicalAddress, isPublicAddress, ValetError } from '@valet/core'

export type Lookup = (
  hostname: string,
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void

export const systemLookup: Lookup = (hostname, callback) =>
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => callback(error, addresses ?? []))

/** Every address this Mac has on its own interfaces, canonical. */
export function ownAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      const address = canonicalAddress(entry.address.replace(/%.*$/, ''))
      if (address !== null) out.push(address)
    }
  }
  return out
}

export const CONNECT_TIMEOUT_MS = 15_000

/** Where to connect, once the broker has decided the endpoint is allowed. */
export type DialTarget =
  /** Port 443 for the broker's own HTTPS; a tunnel's declared port otherwise. */
  | { readonly kind: 'public'; readonly host: string; readonly port: number }
  | {
      readonly kind: 'private'
      readonly address: string
      readonly port: number
      readonly scheme: 'https' | 'http'
      readonly certSha256?: string
    }

/** Only for tests: how to reach fakes on loopback. The app never sets any of it. */
export interface DialTesting {
  /** Addresses a public name may resolve to although they aren't public (a test server's). */
  readonly allowAddresses?: readonly string[]
  /** Moves the connection after every check has passed: a private host or port 443 to a test server. */
  readonly route?: (address: string, port: number) => { readonly address: string; readonly port: number }
  /** Trusted in place of the system's store for public hosts. */
  readonly ca?: string | Buffer
}

export interface DialOptions {
  readonly lookup?: Lookup
  /** This Mac's own addresses, asked at each dial (they change as networks do). */
  readonly ownAddresses?: () => readonly string[]
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly testing?: DialTesting
  /** ALPN for TLS: `http/1.1` for HTTP and WebSocket. */
  readonly alpn?: readonly string[]
  /**
   * The connection carries the client's own bytes, TLS included, which the broker never decrypts (a
   * tunnel): return the connected TCP socket and do no TLS here. The address checks are the same.
   */
  readonly passThrough?: boolean
}

const fail = (errorClass: 'host-not-allowed' | 'unavailable' | 'aborted' | 'timed-out') =>
  new ValetError('egress', errorClass)

/** Resolves a public host to the addresses the broker will dial: all public, or a refusal. */
export function resolvePublic(host: string, lookup: Lookup, testing?: DialTesting): Promise<string[]> {
  return new Promise((resolve, reject) => {
    lookup(host, (error, addresses) => {
      if (error !== null || addresses.length === 0) return reject(fail('unavailable'))
      const allowed = (a: string) => isPublicAddress(a) || (testing?.allowAddresses ?? []).includes(a)
      // Every answer, not just the first: a name that answers both ways is refused outright.
      if (!addresses.every((a) => allowed(a.address))) return reject(fail('host-not-allowed'))
      resolve(addresses.map((a) => a.address))
    })
  })
}

/** SHA-256 of a certificate's DER bytes, lower-case hex. */
export function certificateSha256(certificate: PeerCertificate): string {
  return createHash('sha256').update(certificate.raw).digest('hex')
}

/**
 * Opens a connection to `target`: a TLSSocket that has finished its handshake and been verified,
 * or for a private `http` host a plain connected Socket. Rejects with a ValetError at stage
 * `egress`: `host-not-allowed` (a name that resolves somewhere non-public, or one of this Mac's own
 * addresses), `unavailable` (DNS, refused, reset, a bad certificate) or `timed-out`.
 */
export async function dial(target: DialTarget, options: DialOptions = {}): Promise<Socket | TLSSocket> {
  const lookup = options.lookup ?? systemLookup
  const testing = options.testing
  if (options.signal?.aborted) throw fail('aborted')
  let address: string
  if (target.kind === 'public') {
    const addresses = await resolvePublic(target.host, lookup, testing)
    address = addresses[0] as string
  } else {
    address = target.address
    if ((options.ownAddresses ?? ownAddresses)().includes(address)) throw fail('host-not-allowed')
  }
  const routed = testing?.route?.(address, target.port) ?? { address, port: target.port }
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS
  const tcp = await connectTcp(routed.address, routed.port, timeoutMs, options.signal)
  // From here a late error must never be unhandled: whoever uses the socket adds its own too.
  tcp.on('error', () => {})
  if (options.passThrough === true || (target.kind === 'private' && target.scheme === 'http')) return tcp
  const alpn = options.alpn === undefined ? {} : { ALPNProtocols: [...options.alpn] }
  const tls =
    target.kind === 'public'
      ? tlsConnect({
          socket: tcp,
          servername: target.host,
          host: target.host,
          ...(testing?.ca === undefined ? {} : { ca: testing.ca }),
          ...alpn,
        })
      : target.certSha256 !== undefined
        ? // Pinned: the chain isn't trusted, the exact certificate is, checked below before use.
          tlsConnect({
            socket: tcp,
            rejectUnauthorized: false,
            checkServerIdentity: () => undefined,
            ...alpn,
          })
        : tlsConnect({ socket: tcp, host: target.address, ...alpn })
  await secured(tls, timeoutMs, options.signal)
  tls.on('error', () => {})
  if (target.kind === 'private' && target.certSha256 !== undefined) {
    const peer = tls.getPeerCertificate()
    if (
      peer === null ||
      !('raw' in peer) ||
      !Buffer.isBuffer(peer.raw) ||
      certificateSha256(peer) !== target.certSha256
    ) {
      tls.destroy()
      throw fail('unavailable')
    }
  }
  return tls
}

function connectTcp(address: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port })
    socket.setNoDelay(true)
    const timer = setTimeout(() => done(fail('timed-out')), timeoutMs)
    const onAbort = () => done(fail('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (error: ValetError | null) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.removeAllListeners('connect')
      socket.removeListener('error', onError)
      if (error === null) return resolve(socket)
      socket.destroy()
      reject(error)
    }
    const onError = () => done(fail('unavailable'))
    socket.once('connect', () => done(null))
    socket.once('error', onError)
  })
}

function secured(tls: TLSSocket, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(fail('timed-out')), timeoutMs)
    const onAbort = () => done(fail('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (error: ValetError | null) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      tls.removeListener('secureConnect', onSecure)
      tls.removeListener('error', onError)
      if (error === null) return resolve()
      tls.destroy()
      reject(error)
    }
    const onSecure = () => done(null)
    const onError = () => done(fail('unavailable'))
    tls.once('secureConnect', onSecure)
    tls.once('error', onError)
  })
}
