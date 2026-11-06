// A smoke build's self-check (electron/app.ts imports this only when __SITEADAPTER_SMOKE_BUILD__):
// once the app is up, the packaged main process loads what a normal launch loads only lazily, the
// 1Password SDK (resolved and imported from app.asar, wasm included) and the bundled
// electron-updater, and writes what happened to userData/smoke-report.json for
// scripts/smoke/real-app.mjs. A plain build has none of this.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SMOKE_BUILD_MARKER, SMOKE_REPORT_FILE } from '../core/smoke'

async function attempt(run: () => Promise<boolean>): Promise<string> {
  try {
    return (await run()) ? 'ok' : 'missing'
  } catch (error) {
    return `failed: ${String(error).slice(0, 300)}`
  }
}

export async function smokeSelfCheck(userData: string): Promise<void> {
  const report = {
    build: SMOKE_BUILD_MARKER,
    sdkResolves: await attempt(async () => import.meta.resolve('@1password/sdk').includes('app.asar')),
    sdk: await attempt(async () => typeof (await import('@1password/sdk')).createClient === 'function'),
    updater: await attempt(async () => 'autoUpdater' in (await import('electron-updater'))),
  }
  await writeFile(join(userData, SMOKE_REPORT_FILE), JSON.stringify(report), { mode: 0o600 })
}
