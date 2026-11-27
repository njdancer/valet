// Launches the harness in Electron and runs its scenarios. Each spec file gets its own app, so
// partitions start empty and process-wide switches can differ between files.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { _electron, type ElectronApplication } from '@playwright/test'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as unknown as string

export type Scenarios = Record<string, () => Promise<unknown>>

const TRACE = process.env.E2E_FOCUS_TRACE !== undefined

export async function launchHarness(env: Record<string, string> = {}): Promise<ElectronApplication> {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(import.meta.dirname, 'harness', 'main.mjs')],
    env: { ...process.env, ...env } as Record<string, string>,
  })
  if (TRACE) {
    // TEMPORARY diagnostics.
    await app.evaluate(({ app: electronApp, BrowserWindow, webContents }) => {
      const g = globalThis as unknown as { focusLog: string[]; flog: (s: string) => void }
      g.focusLog = []
      const t0 = Date.now()
      g.flog = (s: string) => {
        g.focusLog.push(`${Date.now() - t0} ${s}`)
        if (g.focusLog.length > 300) g.focusLog.shift()
      }
      const log = g.flog
      const watch = (wc: Electron.WebContents) => {
        wc.on('focus', () => log(`wc${wc.id} focus`))
        wc.on('blur', () => log(`wc${wc.id} blur`))
        wc.on('did-frame-navigate', (_e, url, _c, _s, isMain) => log(`wc${wc.id} nav main=${isMain} ${url}`))
        wc.on('destroyed', () => log(`wc${wc.id} destroyed`))
      }
      for (const wc of webContents.getAllWebContents()) watch(wc)
      electronApp.on('web-contents-created', (_e, wc) => {
        log(`wc${wc.id} created`)
        watch(wc)
      })
      electronApp.on('browser-window-focus', (_e, w) => log(`win${w.id} focus visible=${w.isVisible()}`))
      electronApp.on('browser-window-blur', (_e, w) => log(`win${w.id} blur`))
      electronApp.on('did-become-active', () => log('app active'))
      electronApp.on('did-resign-active', () => log('app resign'))
      const last = new Map<number, string>()
      setInterval(() => {
        for (const wc of webContents.getAllWebContents()) {
          if (wc.isDestroyed()) continue
          const f = wc.focusedFrame
          const now = f === null || f === undefined ? 'null' : f.url
          const state = `${now} focused=${wc.isFocused()} visible=${BrowserWindow.fromWebContents(wc)?.isVisible()}`
          if (last.get(wc.id) !== state) {
            last.set(wc.id, state)
            log(`wc${wc.id} focusedFrame=${state}`)
          }
        }
      }, 10)
    })
  }
  return app
}

/** Runs one harness scenario in the main process and returns its plain-data result. */
export async function scenario(app: ElectronApplication, name: string): Promise<Record<string, unknown>> {
  if (TRACE) await app.evaluate((_e, s) => (globalThis as unknown as { flog: (s: string) => void }).flog(`--- ${s}`), name)
  try {
    return await app.evaluate(async (_electron, which) => {
      const harness = await (globalThis as { harness?: Promise<Scenarios> }).harness
      const run = harness?.[which]
      if (run === undefined) throw new Error(`no scenario ${which}`)
      return (await run()) as Record<string, unknown>
    }, name)
  } catch (error) {
    if (TRACE) {
      const log = await app.evaluate(() => (globalThis as unknown as { focusLog: string[] }).focusLog.slice(-80))
      console.log(`FOCUSTRACE ${name}: ${String(error).split('\n')[0]}\n  ${log.join('\n  ')}`)
    }
    throw error
  }
}
