// Demo mode's local Woolworths: the fake site in-process over TLS, on www.woolworths.test and
// auth.woolworths.test (mapped to 127.0.0.1 by a host resolver rule set before ready). Its
// certificate is trusted for exactly those two hosts, on exactly the adapter's two partitions;
// everything else keeps Chromium's own verification. Loaded only in demo mode.

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
import { DEMO_ACCOUNT, outboxOtpReader } from '../core/demo'

export const DEMO_HOSTS = ['www.woolworths.test', 'auth.woolworths.test'] as const

export interface DemoSite {
  readonly site: FakeWoolworths
  readonly fingerprint: string
  readonly otpReader: ReturnType<typeof outboxOtpReader>
  /** The tool partition's proxy dial: only the demo's hosts, all on this machine. */
  readonly dial: (host: string, port: number) => ReturnType<typeof connect>
}

export async function startDemoSite(): Promise<DemoSite> {
  // Needs the openssl CLI; the certificate lives as long as this launch.
  const tls = await generateTestCertificate([...DEMO_HOSTS])
  const site = await startFakeWoolworths({ tls, hostname: DEMO_HOSTS[0], accounts: [DEMO_ACCOUNT] })
  return {
    site,
    fingerprint: tls.fingerprint,
    otpReader: outboxOtpReader(
      () => site.outbox,
      MESSAGES_SENDER,
      () => Date.now(),
    ),
    dial: (host, port) => {
      if (!(DEMO_HOSTS as readonly string[]).includes(host))
        throw new Error('demo mode stays on this machine')
      return connect({ host: '127.0.0.1', port })
    },
  }
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
