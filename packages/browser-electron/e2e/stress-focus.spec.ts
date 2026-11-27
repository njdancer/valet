// TEMPORARY: diagnostics for the focus flake on macOS CI. Not for merge.
import { expect, test } from '@playwright/test'
import { launchHarness, scenario } from './launch'

test('focus stress', async () => {
  test.setTimeout(1_500_000)
  const app = await launchHarness()
  await app.evaluate(({ app: electronApp, BrowserWindow, webContents }) => {
    const g = globalThis as unknown as { focusLog: string[]; t0: number }
    g.focusLog = []
    g.t0 = Date.now()
    const log = (s: string) => {
      g.focusLog.push(`${Date.now() - g.t0} ${s}`)
      if (g.focusLog.length > 400) g.focusLog.shift()
    }
    ;(globalThis as unknown as { flog: (s: string) => void }).flog = log
    const watch = (wc: Electron.WebContents) => {
      wc.on('focus', () => log(`wc${wc.id} focus`))
      wc.on('blur', () => log(`wc${wc.id} blur`))
      wc.on('frame-created', (_e, d) => log(`wc${wc.id} frame-created ${d.frame?.url}`))
      wc.on('did-frame-navigate', (_e, url, _c, _s, isMain) => log(`wc${wc.id} frame-nav main=${isMain} ${url}`))
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
    // Poll focusedFrame of every webContents and log changes.
    const last = new Map<number, string>()
    setInterval(() => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue
        const f = wc.focusedFrame
        const now = f === null || f === undefined ? 'null' : `${f.url}`
        if (last.get(wc.id) !== now) {
          last.set(wc.id, now)
          log(`wc${wc.id} focusedFrame=${now} focused=${wc.isFocused()} winVisible=${BrowserWindow.fromWebContents(wc)?.isVisible()}`)
        }
      }
    }, 5)
  })
  const n = Number(process.env.STRESS_N ?? 30)
  const failures: string[] = []
  for (let i = 0; i < n; i++) {
    for (const name of ['typeSecretInSameOriginFrame', 'typeSecretWithFullKeys', 'typeInMainFrame', 'secretSiblingReloads']) {
      await app.evaluate((_e, s) => (globalThis as unknown as { flog: (s: string) => void }).flog(`--- start ${s}`), `${i} ${name}`)
      try {
        await scenario(app, name)
      } catch (error) {
        const log = await app.evaluate(() => {
          const g = globalThis as unknown as { focusLog: string[] }
          return g.focusLog.slice(-60)
        })
        failures.push(`${i} ${name}: ${String(error).split('\n')[0]}\n    ${log.join('\n    ')}`)
      }
    }
  }
  await app.close()
  console.log(`FAILURES ${failures.length}\n${failures.join('\n')}`)
  expect(failures).toEqual([])
})
