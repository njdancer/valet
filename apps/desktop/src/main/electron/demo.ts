// Demo mode's local Woolworths: the fake site in-process over TLS, on www.woolworths.test and
// auth.woolworths.test (mapped to 127.0.0.1 by a host resolver rule set before ready). Its
// certificate is trusted for exactly those two hosts, on exactly the adapter's two partitions;
// everything else keeps Chromium's own verification. Loaded only in demo mode, and bundled only
// into a demo build: app.ts imports it behind __SITEADAPTER_DEMO_BUILD__, which a production build
// sets to false, so this chunk, the fake site, its certificate generator and the test account are
// left out of it.

// Electron glue: covered by the smoke test (test/smoke) and the e2e suite, not by unit tests.
/* v8 ignore start */

import { X509Certificate } from 'node:crypto'
import { connect } from 'node:net'
import { MESSAGES_SENDER } from '@siteadapter/adapter-woolworths'
import { partitionName } from '@siteadapter/browser-electron'
import {
  type FakeWoolworths,
  generateTestCertificate,
  startFakeWoolworths,
} from '@siteadapter/fake-woolworths-site'
import { session } from 'electron'
import type { Credentials } from '../core/credentials'
import { DEMO_ACCOUNT, demoCredentials, outboxOtpReader } from '../core/demo'

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

export async function startDemoSite(): Promise<DemoSite> {
  // Needs the openssl CLI; the certificate lives as long as this launch.
  const tls = await generateTestCertificate([...DEMO_HOSTS])
  const site = await startFakeWoolworths({ tls, hostname: DEMO_HOSTS[0], accounts: [DEMO_ACCOUNT] })
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
 * process's global scope): make it block every request (the site's Access Denied page), and read the
 * demo account's trolley as the site holds it. Set only in an e2e launch of a demo build: this chunk
 * isn't in a production build at all, and no renderer can reach the main process's globals.
 */
export interface DemoE2eHook {
  blockAll(on: boolean): void
  trolley(): readonly { readonly stockcode: number; readonly quantity: number }[]
}

export function exposeToE2e(demo: DemoSite): void {
  const hook: DemoE2eHook = {
    blockAll: (on) => demo.site.blockAll(on === true),
    trolley: () => demo.site.trolleyFor(DEMO_ACCOUNT.username).map((l) => ({ ...l })),
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
/* v8 ignore stop */
