// The Electron main process: decides the launch mode before ready, takes the single-instance lock,
// builds the service with Electron's ports, and puts the app in the menu bar.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createElectronSessionDriver, hardenProcess, type ManifestOptions } from '@valet/browser-electron'
import { messagesHelperSocketPath } from '@valet/credentials'
import { startEndpoint } from '@valet/mcp-server'
import { app, clipboard, dialog, Notification, protocol } from 'electron'
import { href } from '../../renderer/lib/routes'
import { builtinAdapters } from '../adapters'
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, createAppSchemeHandler } from '../core/app-scheme'
import { dataPaths, nativeNames } from '../core/constants'
import { checkOpBinary, defaultOpCheckDeps, realCredentials } from '../core/credentials'
import {
  afterCrash,
  createDiagnosticsLog,
  type DiagnosticsLog,
  processGoneLine,
} from '../core/diagnostics-log'
import { DEV_DATA_NAME, demoResolverRules, launchMode, rendererBase, userDataDir } from '../core/launch'
import { AppService } from '../core/service'
import type { BridgeCommand } from '../core/snippets'
import type { DemoSite } from './demo'
import { launchRefused } from './guard'
import { broadcast, registerIpc } from './ipc'
import { utilityToolProcess } from './tool-process'
import { type AppTray, createTray } from './tray'
import { bundleSignature, electronUpdates } from './updates'
import { AppWindows } from './windows'

const mode = launchMode(process.argv, process.env, {
  packaged: app.isPackaged,
  demoBuild: __VALET_DEMO_BUILD__,
})

/**
 * Before ready: where everything lives, the process-wide hardening, demo's host mapping, and the
 * app:// scheme the renderer is served from (it must be privileged before ready to be standard and
 * secure, so module scripts and the page's CSP 'self' work there).
 *
 * userData is named after the package (Valet Dev for a development package), so a
 * development build never shares the release app's data. An unpackaged run (`pnpm start`,
 * `electron .`) is development code too: it uses Valet Dev, never the release folder, so it
 * can't raise the release's version floor or write update-installed events into its audit log.
 */
function beforeReady(): void {
  app.setPath(
    'userData',
    userDataDir(mode, app.getPath('appData'), app.isPackaged ? app.getName() : DEV_DATA_NAME),
  )
  hardenProcess(app)
  if (mode.demo) app.commandLine.appendSwitch('host-resolver-rules', demoResolverRules(mode))
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }])
}

/** How long quitting may take to close the endpoint, the drivers and the demo site. */
const QUIT_BOUND_MS = 5_000

/** Set once the data directory is known; until then lines go to stderr only. */
let diagnostics: DiagnosticsLog | null = null

/** Fixed text and codes only: this goes to stderr and to the diagnostics log on disk. */
const log = (line: string) => {
  process.stderr.write(`valet: ${line}\n`)
  diagnostics?.write(line)
}

/**
 * What nothing caught. A menu-bar app has no terminal, so without this a crash leaves no trace, and
 * Electron's own dialog would show the message (which can quote a page) over whatever is on screen.
 * The error goes to the log by name and stack frames, never by message.
 */
function watchForCrashes(): void {
  const started = Date.now()
  process.on('uncaughtException', (error) => {
    process.stderr.write(`valet: uncaught exception${app.isPackaged ? '' : `: ${String(error)}`}\n`)
    diagnostics?.writeError('uncaught exception', error)
    // The process's state can't be trusted now. The attempt marker, the breaker and the audit
    // chain are all on disk, so stopping here is safe at any point in a run.
    if (afterCrash({ packaged: app.isPackaged, uptimeMs: Date.now() - started }) === 'relaunch') {
      diagnostics?.write('restarting after the crash')
      app.relaunch()
    }
    app.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`valet: unhandled rejection${app.isPackaged ? '' : `: ${String(reason)}`}\n`)
    diagnostics?.writeError('unhandled rejection', reason)
  })
  // A tool process is killed at the end of every call, and a window that closes exits cleanly:
  // only a process that died by itself is worth a line.
  const died = (reason: string): boolean => reason !== 'clean-exit' && reason !== 'killed'
  app.on('render-process-gone', (_event, _contents, details) => {
    if (died(details.reason)) log(processGoneLine('renderer', details.reason, details.exitCode))
  })
  app.on('child-process-gone', (_event, details) => {
    if (died(details.reason)) log(processGoneLine(details.type, details.reason, details.exitCode))
  })
}

/** The update feed, compiled in: empty in a dev, demo or unconfigured build (updates then stay off). */
const FEED_BASE_URL = __VALET_FEED_BASE_URL__
const FEED_PUBLIC_KEY = __VALET_FEED_PUBLIC_KEY__

/** The stdio bridge from the repo, until the app bundles it (packaging's job): tsx and its CLI. */
function bridgeCommand(): ((configPath: string) => BridgeCommand) | null {
  if (app.isPackaged) {
    // D60: the Swift bridge beside the app's own executable, covered by the app's signature.
    const bridge = join(dirname(process.execPath), 'valet-bridge')
    return existsSync(bridge) ? (configPath) => ({ command: bridge, args: [configPath] }) : null
  }
  const root = resolve(app.getAppPath(), '../..')
  const tsx = join(root, 'node_modules/.bin/tsx')
  const cli = join(root, 'packages/mcp-server/src/bridge-cli.ts')
  if (!existsSync(tsx) || !existsSync(cli)) return null
  return (configPath) => ({ command: tsx, args: [cli, configPath] })
}

/**
 * A native helper (swift-bridge): beside the app's executable when packaged, else the debug build in
 * the repo (`swift build --package-path swift-bridge`), or null when neither exists.
 */
function nativeHelper(name: string): string | null {
  const path = app.isPackaged
    ? join(dirname(process.execPath), name)
    : resolve(app.getAppPath(), '../../swift-bridge/.build/debug', name)
  return existsSync(path) ? path : null
}

async function main(): Promise<void> {
  // A menu-bar app: closing every window doesn't quit.
  app.on('window-all-closed', () => {})
  await app.whenReady()
  app.dock?.hide()

  const base = rendererBase(
    process.env['ELECTRON_RENDERER_URL'],
    { packaged: app.isPackaged, devServerBuild: __VALET_DEV_SERVER__ },
    join(import.meta.dirname, '../renderer'),
  )
  // The built renderer (inside app.asar when packaged; Electron's fs reads it there), on the default
  // session only, which only the app's windows use.
  if (base.kind === 'app')
    protocol.handle(
      APP_SCHEME,
      createAppSchemeHandler({ root: base.root, readFile: (path) => readFile(path) }),
    )
  const paths = dataPaths(app.getPath('userData'))
  diagnostics = createDiagnosticsLog({ path: paths.diagnosticsLog, now: () => Date.now() })
  log(
    `started: version ${app.getVersion()}${app.isPackaged ? '' : ' (unpackaged)'}${mode.demo ? ' (demo)' : ''}`,
  )
  let service: AppService | null = null
  let tray: AppTray | null = null
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
  if (__VALET_DEMO_BUILD__ && mode.demo) {
    const { exposeToE2e, startDemoSite, trustDemoCertificate } = await import('./demo')
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
  // The packaged app's name is "valet" for a release and "valet-dev" otherwise (electron-builder).
  const names = nativeNames(app.isPackaged && app.getName() === 'valet')
  const messagesBinary = app.isPackaged ? nativeHelper('valet-messages-helper') : null
  const credentialDeps = {
    ...opDeps,
    keychainHelper: nativeHelper('valet-keychain'),
    copyService: names.copyService,
    // Only a packaged app has the launch agent's plist for SMAppService; a dev build reads Messages
    // in process, with Full Disk Access on the app that runs it.
    messagesHelper:
      messagesBinary === null
        ? null
        : { binary: messagesBinary, socketPath: messagesHelperSocketPath(names.messagesHelperLabel) },
  }
  const signature = await bundleSignature()

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
    toolProcess: utilityToolProcess(join(import.meta.dirname, 'tool-process.js')),
    createDriver: (manifest, reporters) =>
      createElectronSessionDriver(
        manifest,
        { ...driverOptions, ...reporters },
        demoSite === null ? {} : { dial: demoSite.dial },
      ),
    credentials: demoSite === null ? realCredentials(credentialDeps) : demoSite.credentials,
    startEndpoint: (caller, clients, onSessionsChanged) =>
      startEndpoint({
        caller,
        clients,
        onSessionsChanged,
        // D41, D42: the bridge for every client, each with its own token. The port is kept (each
        // bridge reads it from its client's file) and tokens are new at every launch, so one
        // collected by whatever held the saved port while the app was down stops working at the
        // next start. The bridge follows on its own.
        // 'on-reset' waits for an HTTP-client setup that shows the token and states that risk.
        stablePort: true,
        tokenRotation: 'every-launch',
        info: { name: 'valet', version: app.getVersion() },
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
      showRemoteConsent: () => {
        // One notification and the one screen that lists every waiting request (relay.md).
        windows.openControlPanel(href.remote())
        if (Notification.isSupported()) {
          new Notification({
            title: 'A connector wants access to Valet',
            body: 'Type the code your browser shows. If you didn’t just add a connector, decline it.',
          }).show()
        }
      },
      // Only a packaged, normal launch registers itself; a dev or demo run would register Electron.
      setLaunchAtLogin: (enabled) => {
        if (app.isPackaged && !mode.demo) app.setLoginItemSettings({ openAtLogin: enabled })
      },
      quit: () => app.quit(),
    },
    emit: (event) => {
      broadcast(windows, event)
      if (event.type === 'app-changed') tray?.refresh()
    },
    bridge: bridgeCommand(),
    updates: electronUpdates({
      feed: { url: FEED_BASE_URL, publicKey: FEED_PUBLIC_KEY },
      demo: mode.demo,
      signature,
      log,
    }),
    checkOp: (path) => checkOpBinary(path, opDeps),
    diagnostics: (d) => log(`diagnostic: ${d.type}`),
  })
  const running = service

  registerIpc(running.api, windows, base, log)
  await running.start()
  tray = createTray(windows, running.api, mode.demo, running.remote)

  app.on('second-instance', () => windows.openControlPanel(null))
  let stopping = false
  app.on('will-quit', (event) => {
    if (stopping) return
    stopping = true
    log('stopping')
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

  // Until setup is finished or skipped, every launch opens it (AC2). Otherwise demo and e2e open the
  // control panel, as does anything waiting for the person.
  const setup = await running.api.setup.status()
  const attention = await running.api.attention.list()
  if (mode.setup && setup.completedAt === null) windows.openControlPanel(href.setup())
  else if (mode.demo || mode.e2e || attention.length > 0) windows.openControlPanel(null)

  // A smoke build only: the packaged main process loads what it loads lazily, and says so.
  if (__VALET_SMOKE_BUILD__) {
    const { smokeSelfCheck } = await import('./smoke')
    await smokeSelfCheck(app.getPath('userData'))
  }
}

function start(): void {
  beforeReady()
  watchForCrashes()
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  main().catch((error: unknown) => {
    // Only a development run prints the message: it can name local paths.
    process.stderr.write(
      `valet: could not start: ${app.isPackaged ? (error instanceof Error ? error.name : 'error') : String(error)}\n`,
    )
    diagnostics?.writeError('could not start', error)
    app.exit(1)
  })
}

// A refused launch (electron/guard.ts) is exiting: nothing here runs.
if (!launchRefused) start()
