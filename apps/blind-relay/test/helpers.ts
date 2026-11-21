// A Mac, a relay and callers, all on 127.0.0.1, with names resolved by hand: `relay.test` is the
// relay's control host and Macs are `<macId>.macs.test`.

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { type LookupFunction, connect as netConnect } from 'node:net'
import { createSecureContext, type SecureContext, type TLSSocket, connect as tlsConnect } from 'node:tls'
import { generateP256, privateKeyPem, selfSignedCertificate, toPem } from '@valet/acme'
import { keyId, SIGNING_DOMAINS, tunnelHost } from '@valet/core'
import { TunnelClient, type TunnelClientOptions, type TunnelClientStatus } from '@valet/mcp-server'
import { WebSocket as WsWebSocket } from 'ws'
import { type BlindRelayOptions, type RunningBlindRelay, startBlindRelay } from '../src'

export const CONTROL_HOST = 'relay.test'
export const MAC_DOMAIN = 'macs.test'
export const RELAY_ORIGIN = `https://${CONTROL_HOST}`

export const lookup: LookupFunction = (_host, options, callback) => {
  if (typeof options === 'object' && options.all === true)
    (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 },
    ])
  else callback(null, '127.0.0.1', 4)
}

export interface TestCert {
  readonly pem: string
  readonly context: SecureContext
}

export function certFor(names: readonly string[], acmeKeyAuthorization?: string): TestCert {
  const keys = generateP256()
  const pem = toPem(
    selfSignedCertificate(keys, {
      names,
      ...(acmeKeyAuthorization === undefined ? {} : { acmeKeyAuthorization }),
    }),
    'CERTIFICATE',
  )
  return { pem, context: createSecureContext({ key: privateKeyPem(keys), cert: pem }) }
}

export interface TestMacKeys {
  readonly macId: string
  readonly transportKey: string
  readonly transportPrivate: KeyObject
  readonly binding: { approvalKey: string; signature: string }
}

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    spki: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url'),
    privateKey,
  }
}

export function macKeys(): TestMacKeys {
  const approval = p256()
  const transport = p256()
  return {
    macId: keyId(approval.spki),
    transportKey: transport.spki,
    transportPrivate: transport.privateKey,
    binding: {
      approvalKey: approval.spki,
      signature: sign('sha256', Buffer.from(`${SIGNING_DOMAINS.relayBinding}\n${transport.spki}`), {
        key: approval.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
    },
  }
}

export function signerFor(keys: TestMacKeys, privateKey: KeyObject = keys.transportPrivate) {
  return {
    publicKey: keys.transportKey,
    sign: async (payload: string) =>
      sign('sha256', Buffer.from(`${SIGNING_DOMAINS.relayAuth}\n${payload}`), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
  }
}

/** ws's WebSocket, pointed at the relay on 127.0.0.1 and trusting its test certificate. */
export function testWebSocket(ca: string, received?: Buffer[]): typeof WebSocket {
  class TestWebSocket extends WsWebSocket {
    constructor(url: string | URL) {
      super(url, { ca, lookup })
      if (received !== undefined)
        this.on('message', (data, isBinary) => {
          if (isBinary) received.push(Buffer.from(data as Buffer))
        })
    }
  }
  return TestWebSocket as unknown as typeof WebSocket
}

export interface Rig {
  readonly relay: RunningBlindRelay
  readonly controlCert: TestCert
  readonly port: number
  readonly lines: string[]
  close(): Promise<void>
}

export async function startRig(extra: Partial<BlindRelayOptions> = {}): Promise<Rig> {
  const controlCert = certFor([CONTROL_HOST])
  const lines: string[] = []
  const relay = await startBlindRelay({
    controlHost: CONTROL_HOST,
    macDomain: MAC_DOMAIN,
    controlCertificate: () => controlCert.context,
    port: 0,
    host: '127.0.0.1',
    log: (line) => lines.push(line),
    ...extra,
  })
  return { relay, controlCert, port: relay.port, lines, close: () => relay.close() }
}

export interface TestMac {
  readonly client: TunnelClient
  readonly keys: TestMacKeys
  readonly host: string
  readonly cert: TestCert
  readonly statuses: TunnelClientStatus[]
  /** Binary frames the Mac received from the relay: everything the relay passed on. */
  readonly received: Buffer[]
  online(): Promise<void>
}

export function startMac(
  rig: Rig,
  accept: NonNullable<ReturnType<TunnelClientOptions['listener']>> | null,
  extra: Partial<TunnelClientOptions> & { keys?: TestMacKeys } = {},
): TestMac {
  const keys = extra.keys ?? macKeys()
  const host = tunnelHost(keys.macId, MAC_DOMAIN)
  const cert = certFor([host])
  const statuses: TunnelClientStatus[] = []
  const received: Buffer[] = []
  const client = new TunnelClient({
    relay: RELAY_ORIGIN,
    macDomain: MAC_DOMAIN,
    macId: keys.macId,
    signer: signerFor(keys),
    binding: keys.binding,
    certificate: () => cert.context,
    listener: () => accept,
    connectUrl: `wss://${CONTROL_HOST}:${rig.port}`,
    WebSocket: testWebSocket(rig.controlCert.pem, received),
    backoff: { minMs: 50, maxMs: 200 },
    onStatus: (status) => statuses.push(status),
    ...extra,
  })
  client.start()
  return {
    client,
    keys,
    host,
    cert,
    statuses,
    received,
    online: () => waitFor(() => client.status.state === 'online'),
  }
}

export async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A TLS connection to `servername` through the relay. */
export function dial(
  rig: Rig,
  servername: string,
  ca: string | null,
  alpn: string[] = ['http/1.1'],
): TLSSocket {
  return tlsConnect({
    // A validator checks the challenge certificate's extension itself, not its chain.
    ...(ca === null ? { rejectUnauthorized: false } : { ca }),
    socket: netConnect({ host: '127.0.0.1', port: rig.port }),
    servername,
    ALPNProtocols: alpn,
  })
}
