// Launches the harness in Electron and runs its scenarios. Each spec file gets its own app, so
// partitions start empty and process-wide switches can differ between files.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { _electron, type ElectronApplication } from '@playwright/test'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as unknown as string

export type Scenarios = Record<string, () => Promise<unknown>>

export function launchHarness(env: Record<string, string> = {}): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: electronPath,
    args: [join(import.meta.dirname, 'harness', 'main.mjs')],
    env: { ...process.env, ...env } as Record<string, string>,
  })
}

/** Runs one harness scenario in the main process and returns its plain-data result. */
export function scenario(app: ElectronApplication, name: string): Promise<Record<string, unknown>> {
  return app.evaluate(async (_electron, which) => {
    const harness = await (globalThis as { harness?: Promise<Scenarios> }).harness
    const run = harness?.[which]
    if (run === undefined) throw new Error(`no scenario ${which}`)
    return (await run()) as Record<string, unknown>
  }, name)
}
