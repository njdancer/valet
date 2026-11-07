// The smoke harness: an Electron main process that opens the adapter's tool partition through the
// real ElectronSessionDriver, under the real manifest's egress and request surface at purpose
// `read`, and runs the smoke reads (src/smoke.ts) on it. Each read is its own run, as each tool
// call is in the app, so the home page's own traffic can't spend a read's request ceiling.
//
// SMOKE_TARGET=fake (the default) starts the fake site over HTTPS on 127.0.0.1 and trusts only
// its certificate: the dry run, which CI runs. SMOKE_FAKE_DRIFT makes the fake drift (see below). SMOKE_TARGET=live goes to woolworths.com.au and is
// refused unless VALET_LIVE_SMOKE=1 is set too. Either way the profile is a fresh temporary one,
// so the run is anonymous: it never sees Nick's session.

import { X509Certificate } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronSessionDriver, hardenProcess, partitionName } from '@valet/browser-electron'
import type { AdapterManifest, BlockedRequest } from '@valet/core'
import { generateTestCertificate, startFakeWoolworths } from '@valet/fake-woolworths-site'
import { app, session } from 'electron'
import { createAdapter } from '../../src/adapter'
import { runSmoke } from '../../src/smoke'

hardenProcess(app)
app.setPath('userData', mkdtempSync(join(tmpdir(), 'valet-smoke-profile-')))
app.on('window-all-closed', () => {})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const FAKE_HOSTS = ['www.woolworths.test', 'auth.woolworths.test']
/** How long the home page gets to run its own scripts (and set Akamai's cookies) before the reads. */
const LIVE_SETTLE_MS = 8_000

type Target = 'fake' | 'live'

async function prepare(target: Target) {
  if (target === 'live') {
    if (process.env.VALET_LIVE_SMOKE !== '1') throw new Error('the live smoke run needs VALET_LIVE_SMOKE=1')
    const manifest = createAdapter().manifest
    return { manifest, options: {}, platform: {}, settleMs: LIVE_SETTLE_MS, close: async () => {} }
  }
  const tls = await generateTestCertificate(FAKE_HOSTS)
  const site = await startFakeWoolworths({ tls, hostname: 'www.woolworths.test' })
  // SMOKE_FAKE_DRIFT=renamed-field or changed-type: the fake changes shape, to prove the run says so.
  const drift = process.env.SMOKE_FAKE_DRIFT
  if (drift === 'renamed-field' || drift === 'changed-type') site.setShapeDrift(drift)
  const manifest = createAdapter({ origin: site.origin }).manifest
  const trusted = (pem: string) => {
    try {
      return new X509Certificate(pem).fingerprint256 === tls.fingerprint
    } catch {
      return false
    }
  }
  session.fromPartition(partitionName('tool', manifest.id)).setCertificateVerifyProc((request, callback) => {
    callback(trusted(request.certificate.data) ? 0 : -2)
  })
  return {
    manifest,
    options: { egressPorts: [site.port] },
    platform: {
      // The fake's hosts only, all on this machine.
      dial: (host: string, port: number) => {
        if (!host.endsWith('.woolworths.test')) throw new Error('the dry run never leaves the machine')
        return connect({ host: '127.0.0.1', port })
      },
    },
    settleMs: 0,
    close: () => site.close(),
  }
}

async function smoke(target: Target) {
  const prepared = await prepare(target)
  const manifest: AdapterManifest = prepared.manifest
  const refused: BlockedRequest[] = []
  const driver = await createElectronSessionDriver(manifest, prepared.options, prepared.platform)
  const policy = {
    egress: manifest.egress,
    requests: manifest.requests,
    maxPurpose: 'read' as const,
    ceiling: manifest.limits.requestsPerRun,
  }
  try {
    driver.beginRun(policy, (request) => refused.push(request))
    const page = await driver.toolPage()
    await sleep(prepared.settleMs)
    driver.endRun()
    const result = await runSmoke({
      gapMs: manifest.limits.minGapMs ?? 10_000,
      sleep: target === 'live' ? sleep : async () => {},
      fetch: async (path, init) => {
        driver.beginRun(policy, (request) => refused.push(request))
        try {
          return await page.fetch(path, init)
        } finally {
          driver.endRun()
        }
      },
    })
    return {
      target,
      at: new Date().toISOString(),
      electron: process.versions.electron,
      adapter: { id: manifest.id, version: manifest.version },
      result,
      // Counts only: the page's own refused requests are the site's business, not drift.
      refused: countRefused(refused),
    }
  } finally {
    await driver.close()
    await prepared.close()
  }
}

function countRefused(refused: readonly BlockedRequest[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const request of refused) {
    const key = `${request.initiator} ${request.reason} ${request.method} ${new URL(request.target).host}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

const ready = app.whenReady().then(() => ({
  run: () => smoke(process.env.SMOKE_TARGET === 'live' ? 'live' : 'fake'),
}))
;(globalThis as { smoke?: unknown }).smoke = ready
