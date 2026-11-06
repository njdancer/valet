// The Electron main process: decides the launch mode before ready, takes the single-instance lock,
// builds the service with Electron's ports, and puts the app in the menu bar.

// Electron glue: covered by the smoke test (test/smoke) and the e2e suite, not by unit tests.
/* v8 ignore start */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  createElectronSessionDriver,
  hardenProcess,
  type ManifestOptions,
} from '@siteadapter/browser-electron'
import { startEndpoint } from '@siteadapter/mcp-server'
import { app, clipboard, dialog } from 'electron'
import { builtinAdapters } from '../adapters'
import { dataPaths } from '../core/constants'
import { checkOpBinary, defaultOpCheckDeps, realCredentials } from '../core/credentials'
import { demoResolverRules, launchMode, rendererBase, userDataDir } from '../core/launch'
import { AppService } from '../core/service'
import type { BridgeCommand } from '../core/snippets'
import type { DemoSite } from './demo'
import { broadcast, registerIpc } from './ipc'
import { partitionProbe } from './probe'
import { createTray } from './tray'
import { AppWindows } from './windows'

const mode = launchMode(process.argv, process.env, {
  packaged: app.isPackaged,
  demoBuild: __SITEADAPTER_DEMO_BUILD__,
})

// Before ready: where everything lives, the process-wide hardening, and demo's host mapping.
app.setPath('userData', userDataDir(mode, app.getPath('appData')))
hardenProcess(app)
if (mode.demo) app.commandLine.appendSwitch('host-resolver-rules', demoResolverRules(mode))

/** How long quitting may take to close the endpoint, the drivers and the demo site. */
const QUIT_BOUND_MS = 5_000

const log = (line: string) => process.stderr.write(`siteadapter: ${line}\n`)

/**
 * Where updates will be wired. TODO: call createUpdater from apps/desktop/src/main/updater (another
 * unit writes it) once it merges; until then this does nothing and updates.status says up to date.
 */
export function startUpdates(): void {}

/** The stdio bridge from the repo, until the app bundles it (packaging's job): tsx and its CLI. */
function bridgeCommand(configPath: string): BridgeCommand | null {
  if (app.isPackaged) return null
  const root = resolve(app.getAppPath(), '../..')
  const tsx = join(root, 'node_modules/.bin/tsx')
  const cli = join(root, 'packages/mcp-server/src/bridge-cli.ts')
  return existsSync(tsx) && existsSync(cli) ? { command: tsx, args: [cli, configPath] } : null
}

async function main(): Promise<void> {
  // A menu-bar app: closing every window doesn't quit.
  app.on('window-all-closed', () => {})
  await app.whenReady()
  app.dock?.hide()

  const base = rendererBase(
    process.env['ELECTRON_RENDERER_URL'],
    { packaged: app.isPackaged, devServerBuild: __SITEADAPTER_DEV_SERVER__ },
    join(import.meta.dirname, '../renderer'),
  )
  const paths = dataPaths(app.getPath('userData'))
  let service: AppService | null = null
  const windows = new AppWindows({
    base,
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    demo: mode.demo,
    e2e: mode.e2e,
    devTools: !app.isPackaged,
    onConfirmationArmed: (id) => service?.confirmationArmed(id),
  })
  windows.lockDefaultSession()

  let demo: DemoSite | null = null
  // The constant first, so a production build drops the import, and with it the demo chunk.
  if (__SITEADAPTER_DEMO_BUILD__ && mode.demo) {
    const { exposeToE2e, resetDemoPartitions, startDemoSite, trustDemoCertificate } = await import('./demo')
    await resetDemoPartitions('woolworths')
    demo = await startDemoSite(app.getPath('userData'))
    trustDemoCertificate('woolworths', demo.fingerprint)
    if (mode.e2e) exposeToE2e(demo)
    log(`demo: fake Woolworths at ${demo.site.origin}, signing in at ${demo.site.authOrigin}`)
  }
  const demoSite = demo
  const adapters = builtinAdapters(
    demoSite === null ? {} : { origin: demoSite.site.origin, authOrigin: demoSite.site.authOrigin },
  )
  const driverOptions: ManifestOptions = demoSite === null ? {} : { egressPorts: [demoSite.site.port] }
  const opDeps = defaultOpCheckDeps()

  service = new AppService({
    paths,
    version: app.getVersion(),
    demo: mode.demo,
    now: () => Date.now(),
    timers: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    adapters,
    createDriver: (manifest) =>
      createElectronSessionDriver(manifest, driverOptions, demoSite === null ? {} : { dial: demoSite.dial }),
    credentials: demoSite === null ? realCredentials(opDeps) : demoSite.credentials,
    startEndpoint: (caller, configPath) =>
      startEndpoint({
        caller,
        configPath,
        // D41: the bridge for every client. The port is kept (the bridge reads it from bridge.json)
        // and the token is new at every launch, so one collected by whatever held the saved port
        // while the app was down stops working at the next start. The bridge follows on its own.
        // 'on-reset' waits for an HTTP-client setup that shows the token and states that risk.
        stablePort: true,
        tokenRotation: 'every-launch',
        info: { name: 'siteadapter', version: app.getVersion() },
      }),
    ui: {
      writeClipboard: (text) => clipboard.writeText(text),
      chooseSaveFile: async (defaultName) => {
        const result = await dialog.showSaveDialog({ defaultPath: defaultName })
        return result.canceled || result.filePath === undefined ? null : result.filePath
      },
      chooseOpFile: async () => {
        const result = await dialog.showOpenDialog({
          title: 'Choose the 1Password CLI (op)',
          defaultPath: '/opt/homebrew/bin',
          properties: ['openFile'],
        })
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      openControlPanel: (route) => windows.openControlPanel(route),
      showConfirmation: (id) => windows.showConfirmation(id),
      closeConfirmation: (id) => windows.closeConfirmation(id),
      showNeedsUser: (adapterId) => windows.showNeedsUser(adapterId),
      closeNeedsUser: (adapterId) => windows.closeNeedsUser(adapterId),
      // Only a packaged, normal launch registers itself; a dev or demo run would register Electron.
      setLaunchAtLogin: (enabled) => {
        if (app.isPackaged && !mode.demo) app.setLoginItemSettings({ openAtLogin: enabled })
      },
      quit: () => app.quit(),
    },
    emit: (event) => broadcast(windows, event),
    probeFallback: (adapterId) => {
      const adapter = adapters.find((a) => a.definition.manifest.id === adapterId)
      return adapter === undefined ? null : partitionProbe(adapter.definition.manifest)
    },
    bridge: bridgeCommand(paths.bridgeConfig),
    checkOp: (path) => checkOpBinary(path, opDeps),
    diagnostics: (d) => log(`diagnostic: ${d.type}`),
  })
  const running = service

  registerIpc(running.api, windows, base, log)
  await running.start()
  createTray(windows, running.api, mode.demo)
  startUpdates()

  app.on('second-instance', () => windows.openControlPanel(null))
  let stopping = false
  app.on('will-quit', (event) => {
    if (stopping) return
    stopping = true
    event.preventDefault()
    // Pending confirmations are declined and the endpoint closed; a step that hangs doesn't keep
    // the app (and its endpoint port) alive past the bound.
    const done = () => {
      windows.closeAll()
      app.exit(0)
    }
    const bound = setTimeout(done, QUIT_BOUND_MS)
    void running
      .stop()
      .then(() => demoSite?.site.close())
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(bound)
        done()
      })
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => app.quit())

  // First run, demo and e2e: open the control panel, where the adapter waits for review.
  const attention = await running.api.attention.list()
  if (mode.demo || mode.e2e || attention.length > 0) windows.openControlPanel(null)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main().catch((error: unknown) => {
    // Only a development run prints the message: it can name local paths.
    log(
      `could not start: ${app.isPackaged ? (error instanceof Error ? error.name : 'error') : String(error)}`,
    )
    app.exit(1)
  })
}
/* v8 ignore stop */
