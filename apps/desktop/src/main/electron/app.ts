// The Electron main process: decides the launch mode before ready, takes the single-instance lock,
// builds the service with Electron's ports, and puts the app in the menu bar.

import { execFile, spawn } from 'node:child_process'
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
  trialPartitionName,
} from '@valet/browser-electron'
import { type AdapterManifest, DEFAULT_SANDBOX, rawEndpoints } from '@valet/core'
import { KeychainHelper, KeychainTokenSource, messagesHelperSocketPath } from '@valet/credentials'
import { EgressBroker, type OpenTunnels } from '@valet/egress'
import { startEndpoint } from '@valet/mcp-server'
import { HelperEventKit } from '@valet/native-calendar'
import { HelperMailFiles, MailDrafts, MailOrganizer, pdfText, renderPictures } from '@valet/native-mail'
import { diskTarballStore, loadDependencies, nodeRuntimeProcess } from '@valet/node-runtime'
import {
  HostMailReader,
  imapBackend,
  type ProtocolHostOptions,
  sftpBackend,
  smtpBackend,
} from '@valet/protocols'
import { createLocalAccess } from '@valet/sandbox'
import { app, BrowserWindow, clipboard, dialog, powerMonitor, protocol, session, shell } from 'electron'
import { href } from '../../renderer/lib/routes'
import type { HashRoute } from '../../shared/api'
import { builtinPackages } from '../adapters'
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, createAppSchemeHandler } from '../core/app-scheme'
import { ANCHOR_SERVICE, guardPrompts, macApprovalKeys, type PromptGuard } from '../core/approvals'
import {
  approverWanted,
  blindRelaySetup,
  fileCertificateStore,
  keychainCertificateStore,
} from '../core/blind-tunnel'
import { cloudflaredFromEnv, fileTunnelStore, keychainTunnelStore } from '../core/cloudflare-remote'
import {
  dataPaths,
  FEEDBACK_KEYCHAIN_ACCOUNT,
  feedbackRepo,
  KEYCHAIN_SERVICE,
  MCP_SERVER_NAME,
  nativeNames,
} from '../core/constants'
import { checkOpBinary, defaultOpCheckDeps, realCredentials } from '../core/credentials'
import { setDevLoginAgent } from '../core/dev-login-agent'
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
import { ghCliToken } from '../core/feedback'
import {
  DEV_DATA_NAME,
  demoResolverRules,
  launchMode,
  RELEASE_DATA_NAME,
  rendererBase,
  userDataDir,
} from '../core/launch'
import { agentReader, bundleReader, type ReaderControl } from '../core/mail'
import { devHelperPath } from '../core/native-helpers'
import { addOwnPort, ownPorts, recordOwnPorts } from '../core/own-ports'
import { macName } from '../core/phones'
import { protocolHostScript, sftpHostScript } from '../core/protocol-host'
import { nodeRuntimeBinary, rawPaths } from '../core/raw-runtime'
import { AppService } from '../core/service'
import { SHOWCASE_BUILD_MARKER } from '../core/showcase'
import type { BridgeCommand } from '../core/snippets'
import { setAppMenu } from './app-menu'
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
  if (mode.demo) {
    // The evals' own sites (eval/README.md) on this machine's port 443, for the windows that
    // resolve names themselves (the sign-in window); the proxied partitions use VALET_E2E_SITES.
    const evalHosts =
      __VALET_DEMO_BUILD__ && mode.e2e
        ? (process.env['VALET_E2E_SITES'] ?? '')
            .split(',')
            .map((pair) => /^([a-z0-9.-]+\.test)=127\.0\.0\.1:443$/.exec(pair.trim())?.[1])
            .filter((host): host is string => host !== undefined)
        : []
    const rules = [demoResolverRules(mode), ...evalHosts.map((host) => `MAP ${host} 127.0.0.1`)]
    app.commandLine.appendSwitch('host-resolver-rules', rules.join(', '))
  }
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
  if (app.isPackaged) {
    const path = join(dirname(process.execPath), name)
    return existsSync(path) ? path : null
  }
  const bridge = resolve(app.getAppPath(), '../../swift-bridge/.build')
  return devHelperPath(name, bridge, existsSync)
}

/**
 * The Mail reader on this Mac: the packaged app's launch agent, or in a development build the
 * "Valet Reader" bundle swift-bridge/build-helper-apps.sh makes. Null on other systems or without one.
 */
function macMailReader(label: string, packagedBinary: string | null): ReaderControl | null {
  if (process.platform !== 'darwin') return null
  const socketPath = messagesHelperSocketPath(label)
  if (app.isPackaged) return packagedBinary === null ? null : agentReader(packagedBinary, socketPath)
  const bundle = resolve(app.getAppPath(), '../../swift-bridge/.build/apps/Debug/Valet Reader.app')
  return existsSync(bundle) ? bundleReader(bundle, label, socketPath) : null
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

/** Why Valet is quitting, set by whatever asked first; logged on the way out. */
let quitReason: string | null = null

async function main(): Promise<void> {
  // A menu-bar app: closing every window doesn't quit.
  app.on('window-all-closed', () => {})
  await app.whenReady()
  // In the menu bar only, until the control panel opens (windows.ts shows the Dock icon then).
  app.dock?.hide()
  setAppMenu(!app.isPackaged)

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
  // The scratch browser's and live trials' upstream connections: public addresses only, and the
  // private ones the person allowed. A demo build may send them through a proxy for the evals.
  type AuthoringDial = (
    allowPrivate: (address: string, port: number) => boolean,
  ) => ReturnType<typeof publicOnlyDial>
  // The evals' installed adapters (other than the demo shop) dial the same way, minus private ones.
  let evalDial: ReturnType<typeof publicOnlyDial> | null = null
  let authoringDial: AuthoringDial = (allowPrivate) => publicOnlyDial(undefined, allowPrivate)
  const upstreamProxy = process.env['VALET_E2E_UPSTREAM_PROXY']
  if (__VALET_DEMO_BUILD__ && mode.demo && upstreamProxy !== undefined && upstreamProxy !== '') {
    const { evalSites, upstreamProxyDial } = await import('./upstream-dial')
    const sites = evalSites(process.env['VALET_E2E_SITES'])
    authoringDial = (allowPrivate) => upstreamProxyDial(upstreamProxy, allowPrivate, sites)
    evalDial = upstreamProxyDial(upstreamProxy, () => false, sites)
    log('demo: drafts reach sites through an upstream proxy')
  }
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
  // The Node runtime for raw adapters (docs/node-runtime.md): its own signed binary, never Electron.
  // Without it, raw adapters don't load and their calls are unavailable.
  const nodeBinary = nodeRuntimeBinary({
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    e2e: mode.e2e,
    env: process.env,
    exists: existsSync,
  })
  log(
    nodeBinary === null ? 'raw adapters: no Node runtime in this build' : 'raw adapters: Node runtime found',
  )
  // A raw adapter's stderr stays on this Mac: it can hold anything the adapter printed, so it is
  // never shown to an agent; only that there was some is logged.
  const rawStderr = () => undefined
  const tarballs = diskTarballStore(join(paths.dir, 'npm-tarballs'))
  const rawProcess = (
    manifest: Pick<AdapterManifest, 'sandbox' | 'endpoints' | 'privateHosts'>,
    openTunnels: OpenTunnels,
  ) =>
    nodeRuntimeProcess({
      nodeBinary: nodeBinary as string,
      endpoints: rawEndpoints(manifest),
      openTunnels,
      home,
      ...rawPaths(manifest, home),
      // Valet's own data folder is never readable, whatever a path resolves to.
      alsoForbidden: [paths.dir],
      onStderr: rawStderr,
    })
  const noTunnels: OpenTunnels = async () => ({
    ports: new Map<string, number>(),
    close: () => undefined,
    restrict: () => undefined,
  })
  // The protocol host behind protocol adapters' ctx.imap and sign-in mail (docs/imap.md): the Node
  // runtime's signed binary (the raw adapters' own), sandboxed, running Valet's own bundled client.
  // Without the binary or the script, those calls end not-granted.
  const hostScript = protocolHostScript({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: import.meta.dirname,
    exists: existsSync,
  })
  const protocolHost: ProtocolHostOptions | null =
    nodeBinary === null || hostScript === null
      ? null
      : {
          nodeBinary,
          hostScript,
          home,
          // Only its first line, and only in a development run: it may echo mail it choked on.
          onStderr: (text) => {
            if (!app.isPackaged) log(`protocol host: ${text.split('\n')[0]?.slice(0, 200) ?? ''}`)
          },
        }
  log(`protocol adapters: ${protocolHost === null ? 'unavailable (no Node runtime)' : 'ready'}`)
  // The SFTP host (docs/sftp.md#the-protocol-host) runs the same way from its own bundle, which
  // carries ssh2. Its stderr is never logged: it could echo a file name the server sent.
  const sftpScript = sftpHostScript({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: import.meta.dirname,
    exists: existsSync,
  })
  const sftpHost: ProtocolHostOptions | null =
    nodeBinary === null || sftpScript === null ? null : { nodeBinary, hostScript: sftpScript, home }
  log(`SFTP adapters: ${sftpHost === null ? 'unavailable' : 'ready'}`)
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
    keyService: names.keyService,
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
  // The blind relay (docs/blind-relay.md): Valet's own, unless a development build names another
  // (or a demo or e2e run names one at all). Its certificate's keys go in Valet's own Keychain
  // item, or a file in this data folder when there's no helper (a dev or e2e run).
  const blindSetup = blindRelaySetup(process.env, { release: strictApprovals, test: mode.demo || mode.e2e })
  const blindRelay =
    blindSetup === null
      ? null
      : {
          setup: blindSetup,
          store:
            keychainHelper === null || mode.demo || mode.e2e
              ? fileCertificateStore(join(paths.dir, 'relay-certificate.json'))
              : keychainCertificateStore(
                  new KeychainHelper({ helperPath: keychainHelper }),
                  blindSetup.macDomain,
                ),
          // The other name's certificate (BlindRelaySetup.tag), kept the same way under its own name.
          ...(blindSetup.tag === undefined
            ? {}
            : {
                taggedStore:
                  keychainHelper === null || mode.demo || mode.e2e
                    ? fileCertificateStore(join(paths.dir, `relay-certificate-${blindSetup.tag}.json`))
                    : keychainCertificateStore(
                        new KeychainHelper({ helperPath: keychainHelper }),
                        `${blindSetup.macDomain}#${blindSetup.tag}`,
                      ),
              }),
        }
  // "My Cloudflare account" (docs/cloudflare-tunnel.md): offered when this build has cloudflared, the
  // copy a release ships beside the app's binary. A development build may name one, and an e2e run
  // a stand-in Cloudflare API; a release does neither.
  const bundledCloudflared = app.isPackaged ? nativeHelper('cloudflared') : null
  const cloudflaredPath = app.isPackaged
    ? bundledCloudflared === null
      ? null
      : { file: bundledCloudflared }
    : cloudflaredFromEnv(process.env['VALET_CLOUDFLARED'])
  const cloudflareApi = strictApprovals ? undefined : process.env['VALET_CLOUDFLARE_API']
  const cloudflare =
    cloudflaredPath === null
      ? null
      : {
          binary: cloudflaredPath,
          store:
            keychainHelper === null || mode.demo || mode.e2e
              ? fileTunnelStore(join(paths.dir, 'cloudflare-tunnel.json'))
              : keychainTunnelStore(new KeychainHelper({ helperPath: keychainHelper })),
          ...(cloudflareApi !== undefined && /^https?:\/\/127\.0\.0\.1:\d+(\/[\w/.-]*)?$/.test(cloudflareApi)
            ? { apiBase: cloudflareApi }
            : {}),
        }
  const approverKeys = await macApprovalKeys({
    packaged: strictApprovals,
    approverPath: approverWanted({ release: strictApprovals, env: process.env })
      ? nativeHelper('valet-approver')
      : null,
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
  // A Touch ID prompt takes Valet's place in front; the window the person approved from comes back
  // when it closes. The end-to-end suite can stand another app in for the prompt.
  const e2ePrompt = { stealFocus: false }
  const promptGuard: PromptGuard = (prompt) =>
    windows.throughPrompt(async () => {
      if (mode.e2e && e2ePrompt.stealFocus) await anotherAppInFront()
      return prompt()
    })
  const approvalKeys = { ...approverKeys, signer: guardPrompts(approverKeys.signer, promptGuard) }
  if (mode.e2e)
    Object.defineProperty(globalThis, '__valetE2ePrompt', {
      value: Object.freeze({
        stealFocus: (on: boolean) => {
          e2ePrompt.stealFocus = on
        },
      }),
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

  // Mail on this Mac (docs/mail.md): read through the reader helper, which alone has Full Disk Access.
  const mailReader = macMailReader(names.messagesHelperLabel, messagesBinary)
  log(`Mail reader: ${mailReader === null ? 'none in this build' : 'present'}`)
  service = new AppService({
    paths,
    mail:
      mailReader === null
        ? null
        : {
            reader: mailReader,
            files: new HelperMailFiles({ socketPath: mailReader.socketPath }),
            drafts: new MailDrafts(),
            organizer: new MailOrganizer(),
            pdfText: (bytes) => pdfText(bytes),
            render: (bytes, request) => renderPictures(bytes, request),
          },
    // Calendar and Reminders (docs/calendar.md): EventKit in the same reader helper.
    eventKit: mailReader === null ? null : new HelperEventKit({ socketPath: mailReader.socketPath }),
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
      runtime: {
        prelude: toolLibrary,
        start: sandboxes.oneShot(),
        // A raw adapter is described in the Node runtime, with no network at all.
        ...(nodeBinary === null
          ? {}
          : {
              raw: {
                dependencies: (lock) => loadDependencies(lock, tarballs),
                start: rawProcess({}, noTunnels),
              },
            }),
      },
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
    // The broker an http adapter reaches the network through: its manifest's exact endpoints, the
    // broker's own DNS, and never this Mac's own addresses (docs/adapter-kinds.md#f1-the-egress-broker).
    egress: (endpoints) =>
      new EgressBroker({
        egress: endpoints.egress,
        privateHosts: endpoints.privateHosts ?? [],
        endpoints: endpoints.endpoints ?? [],
      }),
    // A raw adapter's calls: one Node process each, under its own profile, reaching only its tunnels.
    // Each tunnel is a server in this process, so own-ports.ts records its port as Valet's own while
    // it listens: no local-service exception or other adapter can reach it.
    ...(nodeBinary === null ? {} : { raw: { start: rawProcess } }),
    // Protocol adapters' ctx.imap and ctx.smtp, and sign-in mail (docs/imap.md#email-sign-in) in the account a
    // grant names, both through the protocol host.
    ...(protocolHost === null
      ? {}
      : {
          imap: (protocol) => imapBackend({ protocol, host: protocolHost }),
          smtp: (protocol) => smtpBackend({ protocol, host: protocolHost }),
          mailReader: (account) => new HostMailReader({ host: protocolHost, account }),
        }),
    // Protocol adapters' ctx.sftp, through the SFTP host, its server's host key pinned.
    ...(sftpHost === null ? {} : { sftp: (protocol) => sftpBackend({ protocol, host: sftpHost }) }),
    // Demo mode keeps only the shop on this machine: the other built-ins (no login, public data)
    // reach their real sites.
    createDriver: (manifest, reporters) =>
      demoSite !== null && manifest.id === 'woolworths'
        ? createElectronSessionDriver(manifest, { ...driverOptions, ...reporters }, { dial: demoSite.dial })
        : createElectronSessionDriver(
            manifest,
            { ...reporters },
            evalDial === null ? {} : { dial: evalDial },
          ),
    credentials: demoSite === null ? realCredentials(credentialDeps) : demoSite.credentials,
    approvalKeys,
    blindRelay,
    cloudflare,
    // Agents' reports to the Valet team (docs/feedback.md), filed with a token only the Keychain
    // holds. None in demo mode or e2e runs: nothing a test does may reach GitHub.
    feedback:
      demoSite !== null || mode.e2e
        ? null
        : {
            repo: feedbackRepo(process.env['VALET_FEEDBACK_REPO']),
            // The Keychain item if the person added one, else their own GitHub CLI's sign-in.
            token: async () =>
              (await new KeychainTokenSource({
                service: KEYCHAIN_SERVICE,
                account: FEEDBACK_KEYCHAIN_ACCOUNT,
              })
                .token()
                .catch(() => null)) ?? (await ghCliToken().catch(() => null)),
          },
    macName: macName(process.env),
    // Each open its own in-memory partition, so nothing a page left behind is there the next time.
    scratch: (draftId, rules, allowPrivate) =>
      openElectronScratchBrowser({
        partition: `scratch:${draftId}:${++scratchOpens}`,
        rules,
        dial: authoringDial(allowPrivate),
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
    // In demo mode a trial reaches the fake shop too, on its own port, as the installed one does.
    trialDriver: (manifest, label, allowPrivate, session) =>
      createElectronSessionDriver(
        manifest,
        {
          trialLabel: label,
          ...(session === null ? {} : { trialSession: session }),
          ...(demoSite === null ? {} : { egressPorts: [443, demoSite.site.port] }),
        },
        {
          dial:
            demoSite === null
              ? authoringDial(allowPrivate)
              : demoSite.forTrial(
                  [trialPartitionName('tool', label), trialPartitionName('auth', label)],
                  authoringDial(allowPrivate),
                ),
        },
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
      // A packaged, normal launch registers itself as a login item. A development run would register
      // bare Electron, so it writes a LaunchAgent that starts this same run instead. Demo and e2e
      // runs never start at login.
      setLaunchAtLogin: (enabled) => {
        if (mode.demo || mode.e2e) return
        if (app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: enabled })
          return
        }
        const home = app.getPath('home')
        void setDevLoginAgent(enabled, {
          home,
          electron: process.execPath,
          appPath: app.getAppPath(),
          logFile: join(home, 'Library', 'Logs', 'Valet', 'valet-dev-unpackaged.log'),
          path: process.env['PATH'],
        })
          .then(() => log(`start at login ${enabled ? 'on' : 'off'} (LaunchAgent)`))
          .catch((error: unknown) => diagnostics?.writeError('start at login', error))
      },
      quit: () => {
        quitReason ??= 'Quit chosen in Valet'
        app.quit()
      },
      relaunch: () => {
        quitReason ??= 'relaunching'
        app.relaunch()
        app.quit()
      },
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
      clearSiteData: async (adapterId: string) => {
        for (const role of ['auth', 'tool'] as const) {
          const s = session.fromPartition(partitionName(role, adapterId))
          await s.clearStorageData().catch(() => undefined)
          await s.clearCache().catch(() => undefined)
        }
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
    // The end-to-end suite never writes the developer's real Claude Desktop config.
    claudeDesktopConfig: mode.e2e
      ? join(app.getPath('userData'), 'e2e-claude', 'claude_desktop_config.json')
      : join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json'),
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
  // And opens the control panel as a notification's click does, from no window of Valet's.
  if (mode.e2e)
    Object.defineProperty(globalThis, '__valetE2eWindows', {
      value: Object.freeze({ openControlPanel: (route: HashRoute) => windows.openControlPanel(route) }),
    })

  if (__VALET_DEMO_BUILD__ && mode.demo && mode.e2e)
    Object.defineProperty(globalThis, '__valetE2eRequests', { value: Object.freeze(running.e2eRequests()) })

  app.on('second-instance', () => windows.openControlPanel(null))
  // A click on the Dock icon, which shows while the control panel is open.
  app.on('activate', () => windows.openControlPanel(null))
  let stopping = false
  app.on('will-quit', (event) => {
    if (stopping) return
    stopping = true
    // Every quit says why, so one nobody expected can be traced. A quit macOS asks for (logout,
    // restart, shutdown, Force Quit's polite quit, Cmd-Q) arrives with no reason of Valet's own.
    log(
      `stopping: ${quitReason ?? 'asked to quit by macOS or the app menu (Cmd-Q, logout, restart or an update)'}`,
    )
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
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      quitReason ??= `${signal} from another process`
      app.quit()
    })
  // Fires on macOS before a logout, restart or shutdown quits the app.
  powerMonitor.on('shutdown', () => {
    quitReason ??= 'the Mac is logging out, restarting or shutting down'
  })

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

/**
 * The end-to-end suite's stand-in for a Touch ID prompt: Finder comes to the front, as the
 * prompt's own window does, and Valet waits until it is no longer the active app.
 */
async function anotherAppInFront(): Promise<void> {
  await new Promise<void>((done) => {
    execFile('osascript', ['-e', 'tell application "Finder" to activate'], () => done())
  })
  const until = Date.now() + 5_000
  while (BrowserWindow.getFocusedWindow() !== null && Date.now() < until) {
    await new Promise((wait) => setTimeout(wait, 50))
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
