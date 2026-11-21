// The Mac gets its own certificate through the blind relay: the CA's TLS-ALPN-01 check connects to
// the relay like any caller and is answered by the Mac, so the relay never holds a key or writes DNS.
// Against the fake CA here (runs anywhere); against Pebble on CI (pebble.test.ts).

import { X509Certificate } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { CertificateManager, type CertificateStatus, type StoredCertificate } from '@valet/acme'
import { tunnelHost } from '@valet/core'
import { type FakeAcme, startFakeAcme } from '@valet/fake-acme'
import { TunnelClient } from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  lookup,
  MAC_DOMAIN,
  macKeys,
  RELAY_ORIGIN,
  type Rig,
  signerFor,
  startRig,
  type TestMacKeys,
  testWebSocket,
  waitFor,
} from './helpers'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function memoryStore() {
  let saved: StoredCertificate | null = null
  return {
    saves: 0,
    get value() {
      return saved
    },
    async load() {
      return saved
    },
    async save(state: StoredCertificate) {
      saved = state
      this.saves++
    },
  }
}

interface CertMac {
  readonly keys: TestMacKeys
  readonly host: string
  readonly client: TunnelClient
  readonly manager: CertificateManager
  readonly statuses: CertificateStatus[]
}

function startCertMac(
  rig: Rig,
  acme: FakeAcme,
  store: ReturnType<typeof memoryStore>,
  keys: TestMacKeys = macKeys(),
): CertMac {
  const host = tunnelHost(keys.macId, MAC_DOMAIN)
  const statuses: CertificateStatus[] = []
  let client: TunnelClient | null = null
  const manager = new CertificateManager({
    name: host,
    directoryUrl: acme.directoryUrl,
    store,
    reachable: () => client?.status.state === 'online',
    onStatus: (s) => statuses.push(s),
    pollMs: 20,
    minRetryMs: 200,
  })
  client = new TunnelClient({
    relay: RELAY_ORIGIN,
    macDomain: MAC_DOMAIN,
    macId: keys.macId,
    signer: signerFor(keys),
    binding: keys.binding,
    certificate: () => manager.certificate(),
    acmeChallenge: (name) => manager.challenge(name),
    listener: () => (socket) => {
      socket.on('secure', () =>
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'),
      )
    },
    connectUrl: `wss://relay.test:${rig.port}`,
    WebSocket: testWebSocket(rig.controlCert.pem),
    backoff: { minMs: 50, maxMs: 200 },
    onStatus: (s) => {
      if (s.state === 'online') manager.kick()
    },
  })
  cleanup.push(() => {
    manager.stop()
    client?.stop()
  })
  return { keys, host, client, manager, statuses }
}

/** An HTTPS request to the Mac through the relay, trusting only the CA's root. */
function hello(rig: Rig, host: string, ca: string): Promise<{ body: string; cert: X509Certificate }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host, port: rig.port, path: '/', ca, lookup, agent: false, headers: { host } },
      (res) => {
        const cert = (res.socket as import('node:tls').TLSSocket).getPeerX509Certificate() as X509Certificate
        let body = ''
        res.on('data', (c) => {
          body += c
        })
        res.on('end', () => resolve({ body, cert }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function setup(
  acmeOptions: Parameters<typeof startFakeAcme>[0] extends infer O ? Partial<O> : never = {},
) {
  const rig = await startRig()
  cleanup.push(() => rig.close())
  const acme = await startFakeAcme({ validationPort: rig.port, ...acmeOptions })
  cleanup.push(() => acme.close())
  return { rig, acme }
}

describe('certificates through the blind relay', () => {
  it('gets a certificate with TLS-ALPN-01 through the relay and serves it', async () => {
    const { rig, acme } = await setup({ rejectEveryNthNonce: 4 })
    const store = memoryStore()
    const mac = startCertMac(rig, acme, store)
    expect(mac.manager.certificate()).toBeNull()
    await mac.manager.start()
    mac.client.start()
    await waitFor(() => mac.manager.status.state === 'ready', 10_000)
    expect(mac.statuses.map((s) => s.state)).toContain('issuing')
    expect(acme.validations).toEqual([{ name: mac.host, ok: true, why: 'ok' }])
    const { body, cert } = await hello(rig, mac.host, acme.rootPem)
    expect(body).toBe('ok')
    expect(cert.checkHost(mac.host)).toBe(mac.host)
    // The key the certificate is for is the Mac's, kept in its store and nowhere else.
    expect(cert.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
      new X509Certificate(store.value?.certificatePem as string).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    // The challenge certificate is gone once validation is over.
    expect(mac.manager.challenge(mac.host)).toBeNull()
  })

  it('waits for the relay before asking, and says so', async () => {
    const { rig, acme } = await setup()
    const mac = startCertMac(rig, acme, memoryStore())
    await mac.manager.start()
    await waitFor(() => mac.manager.status.state === 'waiting-for-relay')
    expect(acme.orders).toHaveLength(0)
    mac.client.start()
    await waitFor(() => mac.manager.status.state === 'ready', 10_000)
  })

  it('queues when the weekly limit is hit, and gets one when the CA says to come back', async () => {
    const { rig, acme } = await setup({ newOrderLimit: 0, rateLimitRetryAfterS: 1 })
    const mac = startCertMac(rig, acme, memoryStore())
    await mac.manager.start()
    mac.client.start()
    await waitFor(() => mac.manager.status.state === 'queued')
    const queued = mac.manager.status as Extract<CertificateStatus, { state: 'queued' }>
    expect(queued.reason).toBe('rate-limited')
    expect(queued.until.getTime()).toBeGreaterThan(Date.now())
    // No certificate: connections to the name are closed rather than served badly.
    await expect(hello(rig, mac.host, acme.rootPem)).rejects.toThrow()
    acme.setNewOrderLimit(undefined)
    await waitFor(() => mac.manager.status.state === 'ready', 10_000)
    expect((await hello(rig, mac.host, acme.rootPem)).body).toBe('ok')
  })

  it('renews in the ARI window, replacing the old certificate, which is exempt from the limit', async () => {
    const { rig, acme } = await setup({ newOrderLimit: 1 })
    const store = memoryStore()
    const mac = startCertMac(rig, acme, store)
    await mac.manager.start()
    mac.client.start()
    await waitFor(() => mac.manager.status.state === 'ready', 10_000)
    const first = new X509Certificate(store.value?.certificatePem as string)
    const { ariCertId } = await import('@valet/acme')
    acme.setRenewalWindow(ariCertId(first), new Date(Date.now() - 60_000), new Date(Date.now() - 1000))
    await mac.manager.checkNow()
    await waitFor(() => acme.orders.length === 2 && mac.manager.status.state === 'ready', 10_000)
    expect(acme.orders[1]?.replaces).toBe(ariCertId(first))
    const second = new X509Certificate(store.value?.certificatePem as string)
    expect(second.serialNumber).not.toBe(first.serialNumber)
    expect((await hello(rig, mac.host, acme.rootPem)).cert.serialNumber).toBe(second.serialNumber)
  })

  it('keeps its certificate and account across restarts', async () => {
    const { rig, acme } = await setup()
    const store = memoryStore()
    const keys = macKeys()
    const first = startCertMac(rig, acme, store, keys)
    await first.manager.start()
    first.client.start()
    await waitFor(() => first.manager.status.state === 'ready', 10_000)
    first.manager.stop()
    first.client.stop()
    const again = startCertMac(rig, acme, store, keys)
    await again.manager.start()
    await waitFor(() => again.manager.status.state === 'ready')
    expect(acme.orders).toHaveLength(1)
    again.client.start()
    await waitFor(() => again.client.status.state === 'online')
    expect((await hello(rig, again.host, acme.rootPem)).body).toBe('ok')
  })

  it('a challenge for another name gets nothing', async () => {
    const { rig, acme } = await setup()
    const mac = startCertMac(rig, acme, memoryStore())
    await mac.manager.start()
    mac.client.start()
    await waitFor(() => mac.manager.status.state === 'ready', 10_000)
    expect(mac.manager.challenge(`other.${MAC_DOMAIN}`)).toBeNull()
  })
})
