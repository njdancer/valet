// The relay as it runs on Fly (docs/blind-relay.md, "Running it"). Settings come from the
// environment; the only state is the relay's own certificate for its control host, kept on a
// volume so a restart doesn't ask Let's Encrypt again.
//
//   RELAY_CONTROL_HOST  relay.valet.dncr.me   where Macs dial in
//   RELAY_MAC_DOMAIN    valet.dncr.me         Macs are <macId>.<this>
//   RELAY_PORT          8443                  Fly maps public 443 to it
//   RELAY_HOST          ::                    the address to listen on (both families)
//   RELAY_DATA          /data                 the control host's certificate and ACME account
//   RELAY_ACME          Let's Encrypt         an ACME directory URL (staging for a trial)
//   RELAY_DENIED        (empty)               macIds refused, comma separated
//   RELAY_VERSION       (git sha)             shown on /healthz

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CertificateManager, LETS_ENCRYPT, type StoredCertificate } from '@valet/acme'
import { startBlindRelay } from './relay'

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

const controlHost = env('RELAY_CONTROL_HOST').toLowerCase()
const macDomain = env('RELAY_MAC_DOMAIN').toLowerCase()
const data = env('RELAY_DATA', '/data')
const denied = new Set(
  (process.env['RELAY_DENIED'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
)
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

await mkdir(data, { recursive: true })
const file = join(data, 'control-certificate.json')
const certificates = new CertificateManager({
  name: controlHost,
  directoryUrl: env('RELAY_ACME', LETS_ENCRYPT),
  // The relay answers its own TLS-ALPN-01 challenge on the port it listens on.
  reachable: () => true,
  store: {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as StoredCertificate
      } catch {
        return null
      }
    },
    async save(state) {
      await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
      await rename(`${file}.tmp`, file)
    },
  },
  onStatus: (status) => log(`certificate ${status.state}`),
  log,
})

const relay = await startBlindRelay({
  controlHost,
  macDomain,
  controlCertificate: () => certificates.certificate(),
  controlAcmeChallenge: (name) => certificates.challenge(name),
  port: Number(env('RELAY_PORT', '8443')),
  host: env('RELAY_HOST', '::'),
  denied: () => denied,
  version: process.env['RELAY_VERSION'] ?? 'dev',
  log,
})
await certificates.start()

const shutdown = () => {
  certificates.stop()
  void relay.close().then(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
