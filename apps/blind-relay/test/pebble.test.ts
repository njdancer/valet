// The same certificate path as certificates.test.ts, against Pebble, Let's Encrypt's own test CA,
// so the client meets a real ACME server's checks. CI downloads Pebble and sets PEBBLE_DIR (the
// "blind relay against Pebble" job, which also sets VALET_REQUIRE_PEBBLE so it can't skip).

import { type ChildProcess, spawn } from 'node:child_process'
import type { X509Certificate } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import {
  ariCertId,
  CertificateManager,
  generateP256,
  privateKeyPem,
  type StoredCertificate,
  selfSignedCertificate,
  toPem,
} from '@valet/acme'
import { tunnelHost } from '@valet/core'
import { TunnelClient } from '@valet/mcp-server'
import { afterAll, describe, expect, it } from 'vitest'
import {
  httpsFetch,
  lookup,
  MAC_DOMAIN,
  macKeys,
  RELAY_ORIGIN,
  signerFor,
  startRig,
  testWebSocket,
  waitFor,
} from './helpers'

const dir = process.env['PEBBLE_DIR']
if (process.env['VALET_REQUIRE_PEBBLE'] === '1' && dir === undefined) throw new Error('PEBBLE_DIR is not set')

const procs: ChildProcess[] = []
const cleanup: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const step of cleanup.reverse()) await step()
  for (const p of procs) p.kill()
})

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

function run(bin: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout?.on('data', (c) => {
    out += c
  })
  child.stderr?.on('data', (c) => {
    out += c
  })
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`${bin} exited ${code}:\n${out.slice(-2000)}`)
  })
  procs.push(child)
  return child
}

describe.skipIf(dir === undefined)('certificates from Pebble through the blind relay', () => {
  it('gets a Let’s Encrypt-style certificate with TLS-ALPN-01 and serves it', async () => {
    const rig = await startRig()
    cleanup.push(() => rig.close())
    const work = mkdtempSync(join(tmpdir(), 'pebble-'))
    // Pebble's own HTTPS: a certificate for localhost that this test trusts.
    const keys = generateP256()
    const apiCert = toPem(selfSignedCertificate(keys, { names: ['localhost'] }), 'CERTIFICATE')
    writeFileSync(join(work, 'cert.pem'), apiCert)
    writeFileSync(join(work, 'key.pem'), privateKeyPem(keys))
    const [api, management, dns, challMgmt] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
      freePort(),
    ])
    writeFileSync(
      join(work, 'config.json'),
      JSON.stringify({
        pebble: {
          listenAddress: `127.0.0.1:${api}`,
          managementListenAddress: `127.0.0.1:${management}`,
          certificate: join(work, 'cert.pem'),
          privateKey: join(work, 'key.pem'),
          httpPort: 5002,
          // TLS-ALPN-01 connects here: the relay, which passes it to the Mac.
          tlsPort: rig.port,
          ocspResponderURL: '',
          externalAccountBindingRequired: false,
        },
      }),
    )
    run(join(dir as string, 'pebble-challtestsrv'), [
      '-defaultIPv4',
      '127.0.0.1',
      '-defaultIPv6',
      '',
      '-dns01',
      `127.0.0.1:${dns}`,
      '-http01',
      '',
      '-https01',
      '',
      '-tlsalpn01',
      '',
      '-doh',
      '',
      '-management',
      `127.0.0.1:${challMgmt}`,
    ])
    run(
      join(dir as string, 'pebble'),
      ['-config', join(work, 'config.json'), '-dnsserver', `127.0.0.1:${dns}`],
      {
        PEBBLE_VA_NOSLEEP: '1',
        // Pebble rejects some nonces on purpose; the client must retry them.
        PEBBLE_WFE_NONCEREJECT: '20',
      },
    )
    const f = httpsFetch(apiCert)
    const directoryUrl = `https://localhost:${api}/dir`
    for (let i = 0; ; i++) {
      try {
        if ((await f(directoryUrl)).ok) break
      } catch {
        if (i > 100) throw new Error('Pebble did not start')
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    const mac = macKeys()
    const host = tunnelHost(mac.macId, MAC_DOMAIN)
    let saved: StoredCertificate | null = null
    let client: TunnelClient | null = null
    const manager = new CertificateManager({
      name: host,
      directoryUrl,
      store: {
        load: async () => saved,
        save: async (s) => {
          saved = s
        },
      },
      reachable: () => client?.status.state === 'online',
      fetch: f,
      pollMs: 200,
      minRetryMs: 500,
      log: (line) => console.log(line),
    })
    client = new TunnelClient({
      relay: RELAY_ORIGIN,
      macDomain: MAC_DOMAIN,
      macId: mac.macId,
      signer: signerFor(mac),
      binding: mac.binding,
      certificate: () => manager.certificate(),
      acmeChallenge: (name) => manager.challenge(name),
      listener: () => (socket) => {
        socket.on('secure', () =>
          socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'),
        )
      },
      connectUrl: `wss://relay.test:${rig.port}`,
      WebSocket: testWebSocket(rig.controlCert.pem),
      onStatus: (s) => {
        if (s.state === 'online') manager.kick()
      },
    })
    cleanup.push(() => {
      manager.stop()
      client?.stop()
    })
    await manager.start()
    client.start()
    await waitFor(() => manager.status.state === 'ready', 60_000)

    // Pebble's root signs a fresh intermediate on every start; trust the root it serves now.
    const root = await (await f(`https://localhost:${management}/roots/0`)).text()
    const served = await new Promise<X509Certificate>((resolve, reject) => {
      const req = httpsRequest(
        { host, port: rig.port, ca: root, lookup, agent: false, headers: { host } },
        (res) => {
          resolve((res.socket as TLSSocket).getPeerX509Certificate() as X509Certificate)
          res.resume()
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(served.checkHost(host)).toBe(host)
    // ARI answers for it.
    const { AcmeClient } = await import('@valet/acme')
    const ari = new AcmeClient({ directoryUrl, accountKey: generateP256(), fetch: f })
    const window = await ari.renewalWindow(ariCertId(served))
    expect(window?.start.getTime()).toBeLessThan(window?.end.getTime() as number)
  }, 120_000)
})
