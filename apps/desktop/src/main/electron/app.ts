// The Electron main process: decides the launch mode before ready, takes the single-instance lock,
// builds the service with Electron's ports, and puts the app in the menu bar.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import toolLibrary from 'virtual:valet-tool-library'
import { buildRecord, readPackageFolder } from '@valet/adapter-store'
import {
  createElectronSessionDriver,
  hardenProcess,
  type ManifestOptions,
  openElectronFixtureBrowser,
  openElectronScratchBrowser,
  partitionName,
  startEgressProxy,
} from '@valet/browser-electron'
import { DEFAULT_SANDBOX } from '@valet/core'
import { KeychainHelper, messagesHelperSocketPath } from '@valet/credentials'
import { startEndpoint } from '@valet/mcp-server'
import { createLocalAccess } from '@valet/sandbox'
import { app, clipboard, dialog, protocol, session, shell } from 'electron'
import { href } from '../../renderer/lib/routes'
import { builtinPackages } from '../adapters'
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, createAppSchemeHandler } from '../core/app-scheme'
import { ANCHOR_SERVICE, macApprovalKeys } from '../core/approvals'
import { dataPaths, MCP_SERVER_NAME, nativeNames } from '../core/constants'
import { checkOpBinary, defaultOpCheckDeps, realCredentials } from '../core/credentials'
import {
  afterCrash,
  createDiagnosticsLog,
  type DiagnosticsLog,
  processGoneLine,
} from '../core/diagnostics-log'
import {
  appBundlePath,
  type EraseReport,
  eraseDialog,
  eraseFailedDetail,
  leftoverPaths,
  sweepCommand,
} from '../core/erase'
import {
  DEV_DATA_NAME,
  demoResolverRules,
  launchMode,
  RELEASE_DATA_NAME,
  rendererBase,
  userDataDir,
} from '../core/launch'
import { addOwnPort, ownPorts, recordOwnPorts } from '../core/own-ports'
import { macName, relayFromEnv } from '../core/phones'
import { AppService } from '../core/service'
import { SHOWCASE_BUILD_MARKER } from '../core/showcase'
import type { BridgeCommand } from '../core/snippets'
import type { DemoSite } from './demo'
import { launchRefused } from './guard'
import { broadcast, registerIpc } from './ipc'
import { systemNotifications } from './notifications'
import { publicOnlyDial } from './public-dial'
import { SandboxPool } from './sandbox'
import { utilityToolProcess } from './tool-process'
import { type AppTray, createTray } from './tray'
import { bundleSignature, electronUpdates } from './updates'
import { AppWindows } from './windows'

const mode = launchMode(process.argv, process.env, {
  packaged: app.isPackaged,
  demoBuild: __VALET_DEMO_BUILD__,
  showcaseBuild: __VALET_SHOWCASE_BUILD__,
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
  // Before any server starts: a local-service exception may never reach one of them (docs/sandbox.md).
  recordOwnPorts()
  const debugging = Number(app.commandLine.getSwitchValue('remote-debugging-port'))
  if (debugging > 0) addOwnPort(debugging)
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

/**
 * The last step of a reset or an uninstall, once the service has erased everything: say what
 * couldn't be removed, then restart as new, or move the app to the Trash and quit. app.exit skips
 * will-quit, whose work (stopping the service) the erase has already done.
 */
async function finishErase(report: EraseReport, windows: AppWindows, userData: string): Promise<void> {
  windows.closeAll()
  const failed = eraseFailedDetail(report)
  if (failed !== null) {
    await dialog
      .showMessageBox({
        type: 'warning',
        message:
          report.kind === 'reset' ? 'Valet was reset, with exceptions' : 'Valet was erased, with exceptions',
        detail: failed,
        buttons: ['OK'],
      })
      .catch(() => undefined)
  }
  if (report.kind === 'reset') {
    log(`reset: data erased${report.failed.length === 0 ? '' : ` (failed: ${report.failed.join(', ')})`}`)
    app.relaunch()
    app.exit(0)
    return
  }
  // Nothing more is written to the data folder, which the sweep below removes for good.
  diagnostics = null
  const bundle = app.isPackaged ? appBundlePath(process.execPath) : null
  if (bundle !== null) await shell.trashItem(bundle).catch(() => undefined)
  const sweep = sweepCommand(process.pid, userData)
  if (sweep !== null) {
    try {
      spawn(sweep.command, [...sweep.args], {
        detached: true,
        stdio: 'ignore',
        env: { PATH: '/usr/bin:/bin' },
        cwd: '/',
      }).unref()
    } catch {
      // The app's own delete has run; only Chromium's last few files stay behind.
    }
  }
  app.exit(0)
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
  })
  windows.lockDefaultSession()

  let demo: DemoSite | null = null
  // The constant first, so a production build drops the import, and with it the demo chunk.
  if (__VALET_DEMO_BUILD__ && mode.demo) {
    const { exposeToE2e, showKeyholdPrompts, startDemoSite, trustDemoCertificate } = await import('./demo')
    demo = await startDemoSite(app.getPath('userData'), { showcase: __VALET_SHOWCASE_BUILD__ })
    trustDemoCertificate('woolworths', demo.fingerprint)
    showKeyholdPrompts(demo, { e2e: mode.e2e })
    if (mode.e2e) exposeToE2e(demo)
    log(`demo: fake Woolworths at ${demo.site.origin}, signing in at ${demo.site.authOrigin}`)
    log(`demo: fake 1Password (Keyhold) at ${demo.keyhold.url}`)
    if (__VALET_SHOWCASE_BUILD__) log(`showcase build (${SHOWCASE_BUILD_MARKER})`)
  }
  const demoSite = demo
  // The demo's Woolworths is a built-in of its own, made for the fake site; demo mode has its own
  // data folder (launch.ts), so it never meets the real one's versions or approvals.
  const builtins = builtinPackages(
    demoSite === null ? {} : { origin: demoSite.site.origin, authOrigin: demoSite.site.authOrigin },
  )
  const toolProcess = utilityToolProcess(join(import.meta.dirname, 'tool-process.js'))
  // The adapter sandbox (docs/sandbox.md): anything that slips past a sandbox window's request
  // filter meets a proxy that refuses every host.
  const sandboxProxy = await startEgressProxy({ allow: () => false })
  let scratchOpens = 0
  let fixtureOpens = 0
  const sandboxes = new SandboxPool({
    preload: join(import.meta.dirname, '../preload/sandbox.cjs'),
    wasm: join(import.meta.dirname, '../preload/quickjs.wasm'),
    proxyUrl: sandboxProxy.url,
    log,
  })
  if (mode.e2e)
    Object.defineProperty(globalThis, '__valetE2eSandbox', {
      value: Object.freeze({
        escaped: (key: string, source: string, world: 'preload' | 'main') =>
          sandboxes.escapedForE2e(key, source, world),
        windows: () => sandboxes.size,
      }),
    })
  const home = app.getPath('home')
  const driverOptions: ManifestOptions = demoSite === null ? {} : { egressPorts: [demoSite.site.port] }
  const opDeps = defaultOpCheckDeps()
  // The packaged app's name is "Valet" for a release and "Valet Dev" otherwise (electron-builder's
  // productName, which app.getName() returns; launch.ts names the data folder by it too).
  const release = app.isPackaged && app.getName() === RELEASE_DATA_NAME
  const names = nativeNames(release)
  const messagesBinary = app.isPackaged ? nativeHelper('valet-messages-helper') : null
  const credentialDeps = {
    ...opDeps,
    keychainHelper: nativeHelper('valet-keychain'),
    copyService: names.copyService,
    // The token's Keychain item is shared by every build, so only the release app's erase removes it.
    ownsToken: release,
    // Only a packaged app has the launch agent's plist for SMAppService; a dev build reads Messages
    // in process, with Full Disk Access on the app that runs it.
    messagesHelper:
      messagesBinary === null
        ? null
        : { binary: messagesBinary, socketPath: messagesHelperSocketPath(names.messagesHelperLabel) },
  }
  // The Mac's approval keys: the Secure Enclave helper and a Keychain anchor in a release build,
  // nothing weaker. A build that carries demo mode is never a release (launch.ts).
  const strictApprovals = app.isPackaged && !mode.demo
  const keychainHelper = credentialDeps.keychainHelper
  // A relay for paired phones (docs/phone-channel.md): the one in Settings › Devices. A dev build
  // can name a local one in the environment instead, and then signs in software.
  const devRelay = strictApprovals ? null : relayFromEnv(process.env)
  const approvalKeys = await macApprovalKeys({
    packaged: strictApprovals,
    approverPath: devRelay === null ? nativeHelper('valet-approver') : null,
    // A demo launch keeps its anchor in its own data folder, never the Keychain.
    keychain:
      keychainHelper === null || mode.demo ? null : new KeychainHelper({ helperPath: keychainHelper }),
    anchorService: release ? ANCHOR_SERVICE : 'valet.dev.anchor',
    devKeysPath: paths.devApprovalKeys,
    devAnchorPath: paths.devAnchor,
    // A dev build signing in software asks in a native dialog of the main process, where the
    // Touch ID prompt would be; the end-to-end suite answers yes.
    devPresent: async (reason) => {
      if (mode.e2e) return true
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `Valet is trying to ${reason}.`,
        detail: 'Development build: this dialog stands in for Touch ID.',
        buttons: ['Cancel', 'Approve'],
        defaultId: 0,
        cancelId: 0,
      })
      return response === 1
    },
    log,
  })
  log(
    `approvals: signing with ${approvalKeys.kind === 'software' ? 'software keys (dev build)' : 'the Secure Enclave'}`,
  )
  const signature = await bundleSignature()
  const notifications = systemNotifications((target) => {
    // A click only ever opens the window the notification was about, if it is still waiting.
    if (target.kind === 'confirmation') {
      if (service?.confirmationPending(target.id)) windows.focusConfirmation(target.id)
    } else if (target.kind === 'needs-user') {
      if (service?.hasHandoff(target.adapterId)) void service.api.openLoginWindow(target.adapterId)
    } else windows.openControlPanel(target.route)
  }, mode.e2e)

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
    adapters: [],
    packages: {
      builtins,
      // Describing and checking anything new runs in a sandbox window of its own: no code that isn't
      // approved yet runs anywhere else (docs/sandbox.md#lifting-cs-guard).
      runtime: { prelude: toolLibrary, start: sandboxes.oneShot() },
      build: buildRecord(app.getVersion(), toolLibrary),
      // Development builds only: a packaged app installs from drafts once the sandbox exists.
      ...(app.isPackaged
        ? {}
        : {
            folders: {
              pick: async () => {
                // The e2e suite can't drive the native picker: it names the folder at launch instead.
                const named = mode.e2e ? process.env['VALET_E2E_INSTALL_FOLDER'] : undefined
                if (named !== undefined) return readPackageFolder(named)
                const result = await dialog.showOpenDialog({
                  title: 'Install an adapter from a folder',
                  properties: ['openDirectory'],
                })
                const folder = result.canceled ? undefined : result.filePaths[0]
                return folder === undefined ? null : readPackageFolder(folder)
              },
            },
          }),
    },
    toolProcess,
    sandbox: {
      forAdapter: (hash) => sandboxes.forAdapter(hash),
      local: (manifest) =>
        createLocalAccess(manifest.sandbox ?? DEFAULT_SANDBOX, 'declared', { home, refusedPorts: ownPorts }),
    },
    // Demo mode keeps only the shop on this machine: the other built-ins (no login, public data)
    // reach their real sites.
    createDriver: (manifest, reporters) =>
      demoSite !== null && manifest.id === 'woolworths'
        ? createElectronSessionDriver(manifest, { ...driverOptions, ...reporters }, { dial: demoSite.dial })
        : createElectronSessionDriver(manifest, { ...reporters }),
    credentials: demoSite === null ? realCredentials(credentialDeps) : demoSite.credentials,
    approvalKeys,
    relay: devRelay,
    macName: macName(process.env),
    // Each open its own in-memory partition, so nothing a page left behind is there the next time.
    scratch: (draftId, rules, allowPrivate) =>
      openElectronScratchBrowser({
        partition: `scratch:${draftId}:${++scratchOpens}`,
        rules,
        dial: publicOnlyDial(undefined, allowPrivate),
      }),
    // A live trial: the same driver a real call uses, in partitions of its own that live in memory,
    // through the dial that refuses private addresses (docs/authoring-tools.md#live-trials).
    // A case's pages: in memory, a new partition each case, nothing sent anywhere.
    fixtureBrowser: async (pages, egress) => {
      const browser = await openElectronFixtureBrowser({
        partition: `fixture:${++fixtureOpens}`,
        pages,
        egress,
      })
      return { page: browser.page, close: () => browser.close() }
    },
    trialDriver: (manifest, label, allowPrivate, session) =>
      createElectronSessionDriver(
        manifest,
        { trialLabel: label, ...(session === null ? {} : { trialSession: session }) },
        { dial: publicOnlyDial(undefined, allowPrivate) },
      ),
    startEndpoint: (caller, clients, onSessionsChanged, admin, authoring) =>
      startEndpoint({
        caller,
        clients,
        onSessionsChanged,
        // Valet's own read-only tools, for local clients (docs/admin-tools.md).
        admin,
        // The draft tools agents write adapters with, for local clients (docs/authoring-tools.md).
        ...(authoring === null ? {} : { authoring }),
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
      openExternal: (url) => {
        if (new URL(url).protocol === 'https:') void shell.openExternal(url)
      },
      // Only a draft's folder under Valet's own data (the service names it), never a path from a page.
      showFolder: (path) => void shell.openPath(path),
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
      focusConfirmation: (id) => windows.focusConfirmation(id),
      closeConfirmation: (id) => windows.closeConfirmation(id),
      showNeedsUser: (adapterId) => windows.showNeedsUser(adapterId),
      closeNeedsUser: (adapterId) => windows.closeNeedsUser(adapterId),
      // Only a packaged, normal launch registers itself; a dev or demo run would register Electron.
      setLaunchAtLogin: (enabled) => {
        if (app.isPackaged && !mode.demo) app.setLoginItemSettings({ openAtLogin: enabled })
      },
      quit: () => app.quit(),
      notify: (notification) => notifications.show(notification),
      closeNotification: (key) => notifications.close(key),
      confirmErase: async (kind) => {
        const wording = eraseDialog(kind, {
          demo: mode.demo,
          serverName: mode.demo ? `${MCP_SERVER_NAME}-demo` : MCP_SERVER_NAME,
        })
        // A menu-bar app has no Dock icon to bring it forward: without this the dialog can open
        // behind whatever the person is using.
        app.focus({ steal: true })
        // Cancel is the default and the Escape key: a stray Return never erases.
        const result = await dialog.showMessageBox({
          type: 'warning',
          message: wording.message,
          detail: wording.detail,
          buttons: ['Cancel', wording.confirm],
          defaultId: 0,
          cancelId: 0,
        })
        if (result.response !== 1) return false
        // No window is left to ask for anything while the data goes.
        windows.closeAll()
        return true
      },
      clearBrowserData: async () => {
        const sessions = (service?.adapterIds() ?? []).flatMap((id) =>
          (['auth', 'tool'] as const).map((role) => session.fromPartition(partitionName(role, id))),
        )
        for (const s of [...sessions, session.defaultSession]) {
          await s.clearStorageData().catch(() => undefined)
          await s.clearCache().catch(() => undefined)
        }
      },
      finishErase: (report) => void finishErase(report, windows, app.getPath('userData')),
    },
    // Only a packaged, normal launch has caches under its own bundle id and a helper's folder.
    leftovers:
      app.isPackaged && !mode.demo
        ? [...leftoverPaths(names.bundleId), dirname(messagesHelperSocketPath(names.messagesHelperLabel))]
        : [],
    emit: (event) => {
      broadcast(windows, event)
      if (event.type === 'app-changed' || event.type === 'attention-changed') tray?.refresh()
    },
    bridge: bridgeCommand(),
    claudeDesktopConfig: join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json'),
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
  // The e2e suite opens the popover as a click on the icon would; there is no icon to click headless.
  if (mode.e2e)
    Object.defineProperty(globalThis, '__valetE2eTray', {
      value: Object.freeze({ toggle: () => windows.toggleTray({ x: 900, y: 0, width: 24, height: 22 }) }),
    })

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
      sandboxes.closeAll()
      app.exit(0)
    }
    const bound = setTimeout(done, QUIT_BOUND_MS)
    void running
      .stop()
      .then(() => Promise.all([demoSite?.site.close(), demoSite?.keyhold.close()]))
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
  // P8a: on Needs you when something waits, otherwise on Sites.
  else if (attention.length > 0) windows.openControlPanel(href.needsYou())
  else if (mode.demo || mode.e2e) windows.openControlPanel(null)

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
