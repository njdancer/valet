// Demo mode's local Woolworths: the fake site in-process over TLS, on www.woolworths.test and
// auth.woolworths.test (mapped to 127.0.0.1 by a host resolver rule set before ready). Its
// certificate is trusted for exactly those two hosts, on exactly the adapter's two partitions;
// everything else keeps Chromium's own verification. Loaded only in demo mode, and bundled only
// into a demo build: app.ts imports it behind __SITEADAPTER_DEMO_BUILD__, which a production build
// sets to false, so this chunk, the fake site, its certificate generator and the test account are
// left out of it.

import { X509Certificate } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { MESSAGES_SENDER } from '@siteadapter/adapter-woolworths'
import { partitionName } from '@siteadapter/browser-electron'
import {
  type FakeWoolworths,
  generateTestCertificate,
  startFakeWoolworths,
} from '@siteadapter/fake-woolworths-site'
import { session } from 'electron'
import type { Credentials } from '../core/credentials'
import {
  DEMO_ACCOUNT,
  DEMO_PORTS_FILE,
  type DemoPorts,
  demoCredentials,
  outboxOtpReader,
  savedDemoPorts,
} from '../core/demo'

export const DEMO_HOSTS = ['www.woolworths.test', 'auth.woolworths.test'] as const

export interface DemoSite {
  readonly site: FakeWoolworths
  readonly fingerprint: string
  readonly otpReader: ReturnType<typeof outboxOtpReader>
  /** The tool partition's proxy dial: only the demo's hosts, all on this machine. */
  readonly dial: (host: string, port: number) => ReturnType<typeof connect>
  /** The test provider with the fake's account, and codes from its outbox. */
  readonly credentials: Credentials
}

/**
 * Starts the fake on the ports the last demo launch used (kept in `userData`), so the adapter's
 * origins, and with them its hash, its approval and its grants, survive a restart. Ports taken by
 * something else: new ones, and the adapter waits for review again.
 */
export async function startDemoSite(userData: string): Promise<DemoSite> {
  // Needs the openssl CLI; the certificate lives as long as this launch.
  const tls = await generateTestCertificate([...DEMO_HOSTS])
  const portsFile = join(userData, DEMO_PORTS_FILE)
  const saved = savedDemoPorts(await readFile(portsFile, 'utf8').catch(() => null))
  const options = { tls, hostname: DEMO_HOSTS[0], accounts: [DEMO_ACCOUNT] }
  const site =
    saved === null
      ? await startFakeWoolworths(options)
      : await startFakeWoolworths({ ...options, ...saved }).catch(() => startFakeWoolworths(options))
  const ports: DemoPorts = { port: site.port, authPort: site.authPort }
  await writeFile(portsFile, `${JSON.stringify(ports)}\n`, { mode: 0o600 }).catch(() => undefined)
  const otpReader = outboxOtpReader(
    () => site.outbox,
    MESSAGES_SENDER,
    () => Date.now(),
  )
  return {
    site,
    fingerprint: tls.fingerprint,
    otpReader,
    credentials: demoCredentials(otpReader),
    dial: (host, port) => {
      if (!(DEMO_HOSTS as readonly string[]).includes(host))
        throw new Error('demo mode stays on this machine')
      return connect({ host: '127.0.0.1', port })
    },
  }
}

/**
 * What the end-to-end suite may do to the fake site from Playwright's `app.evaluate` (the main
 * process's global scope): make it block every request (the site's Access Denied page), read the
 * demo account's trolley as the site holds it, and turn on the fake's hostile page beacon (every www
 * page then carries the site's own script sending its cookies to `target`; null turns it off). Set
 * only in an e2e launch of a demo build: this chunk isn't in a production build at all, and no
 * renderer can reach the main process's globals.
 */
export interface DemoE2eHook {
  blockAll(on: boolean): void
  trolley(): readonly { readonly stockcode: number; readonly quantity: number }[]
  pageBeacon(target: { readonly host: string; readonly port: number } | null): void
}

export function exposeToE2e(demo: DemoSite): void {
  const hook: DemoE2eHook = {
    blockAll: (on) => demo.site.blockAll(on === true),
    trolley: () => demo.site.trolleyFor(DEMO_ACCOUNT.username).map((l) => ({ ...l })),
    pageBeacon: (target) =>
      demo.site.setPageBeacon(target === null ? null : { host: target.host, port: target.port }),
  }
  Object.defineProperty(globalThis, '__siteadapterE2e', { value: Object.freeze(hook) })
}

/** Trusts the demo certificate for the demo hosts on the adapter's partitions. Call before any load. */
export function trustDemoCertificate(adapterId: string, fingerprint: string): void {
  for (const role of ['auth', 'tool'] as const) {
    session.fromPartition(partitionName(role, adapterId)).setCertificateVerifyProc((request, callback) => {
      if (!(DEMO_HOSTS as readonly string[]).includes(request.hostname)) {
        callback(-3) // Chromium's own verification
        return
      }
      let matches = false
      try {
        matches = new X509Certificate(request.certificate.data).fingerprint256 === fingerprint
      } catch {
        matches = false
      }
      callback(matches ? 0 : -2)
    })
  }
}
