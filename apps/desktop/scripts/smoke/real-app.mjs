// The second half of package-smoke.mjs: the real app, from the real out/ build, packaged the way
// `package` packages it, then launched with a window to see that the control panel renders.
//
// out/ must be a smoke build (`electron-vite build --mode smoke`, which package:smoke runs): a plain
// one, as a release, refuses every argv but the normal shapes (src/main/core/argv.ts), the smoke's
// own included. A smoke build accepts exactly SMOKE_ARGV as well (src/main/core/smoke.ts), and
// writes a self-check report under userData once it is up: the 1Password SDK resolved and imported
// from app.asar, and the bundled electron-updater imported. electron-builder.config.ts refuses to
// package a release from a smoke build.
//
// The launch must not touch the real userData folder, the real Keychain or the person's own
// session state. So the child gets a temporary HOME (and CFFIXED_USER_HOME, which CoreFoundation
// reads for the home directory), Chromium's mock keychain, and none of the caller's CSC_*, APPLE_*,
// VALET_*, ELECTRON_* or NODE_OPTIONS variables. package-smoke.mjs first launches the
// placeholder the same way and refuses to go on unless app.getPath('appData') moved under the
// temporary HOME; afterwards this checks that the app's data did land there, and that the real
// ~/Library/Application Support/valet(-dev) folders are as they were.
//
// The control panel is read over the DevTools protocol: --remote-debugging-port=0, the port taken
// from Chromium's "DevTools listening on" line. Playwright's Electron launcher needs --inspect,
// which the NodeCliInspect fuse turns off. Only the smoke build takes the DevTools switch; the smoke
// also launches it with other argv and environments and checks each is refused (exit 64), with no
// control panel and none of the app's data written.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SMOKE_ARGV, SMOKE_BUILD_MARKER, SMOKE_REPORT_FILE } from '../../src/main/core/smoke.ts'
import { APP_DIR, appPath, asarFiles, cleanEnv, mainBundle, plist, runBuilder } from '../packaging.mjs'

/** How long the real app has to show a rendered control panel. */
const RENDER_TIMEOUT_MS = 45_000

/**
 * A launch environment with only a temporary home: what both the placeholder and the app get. No
 * NODE_* either: the packaged app refuses most of them.
 */
export function homeEnv(home, extra = {}) {
  const env = cleanEnv({ HOME: home, CFFIXED_USER_HOME: home })
  for (const name of Object.keys(env)) if (name.startsWith('NODE_')) delete env[name]
  return { ...env, ...extra }
}

/** True when `path` is `dir` or inside it. */
export function inside(path, dir) {
  return typeof path === 'string' && (path === dir || path.startsWith(`${dir}/`))
}

/**
 * What the real folders look like now, to compare after the launch: every entry under each, by
 * path, with its size and mtime (stat only; nothing is opened). A write to a file that already
 * exists changes its own mtime, not the folder's.
 */
function realFolders() {
  const support = join(homedir(), 'Library', 'Application Support')
  const state = {}
  for (const name of ['Valet', 'Valet Dev', 'valet', 'valet-dev', 'siteadapter', 'siteadapter-dev'])
    state[name] = snapshot(join(support, name))
  return state
}

function snapshot(dir) {
  try {
    statSync(dir)
  } catch {
    return null
  }
  const entries = {}
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()) {
    try {
      const s = statSync(join(dir, name))
      entries[name] = `${s.size} ${s.mtimeMs}`
    } catch {
      entries[name] = 'gone'
    }
  }
  return entries
}

/** Every file the packaged app must carry, by pattern, and nothing else. */
export const ASAR_ALLOWED = [
  /^package\.json$/,
  /^out\/main\/index\.js$/,
  /^out\/main\/tool-process\.js$/,
  /^out\/main\/chunks\/[\w-]+\.js$/,
  /^out\/preload\/index\.cjs$/,
  // The sandbox renderer's preload and QuickJS (docs/sandbox.md).
  /^out\/preload\/(sandbox\.cjs|quickjs\.wasm)$/,
  /^out\/renderer\/(index|tray)\.html$/,
  /^out\/renderer\/assets\/[\w-]+\.(js|css|svg|png|woff2)$/,
  /^node_modules\/@1password\/sdk\/(package\.json|dist\/[\w]+\.js)$/,
  /^node_modules\/@1password\/sdk-core\/(package\.json|nodejs\/core\.js|nodejs\/core_bg\.wasm)$/,
  // The adapter compiler (docs/adapter-packages.md): esbuild-wasm's browser build, run in a worker.
  /^node_modules\/esbuild-wasm\/(package\.json|lib\/browser\.js|esbuild\.wasm)$/,
]

/** Waits for Chromium's DevTools line on the child's stderr. */
function devtoolsPort(child, timeoutMs) {
  return new Promise((done) => {
    let text = ''
    const timer = setTimeout(() => done(null), timeoutMs)
    child.stderr.on('data', (chunk) => {
      text += chunk
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)
      if (match !== null) {
        clearTimeout(timer)
        done(Number(match[1]))
      }
    })
  })
}

/** One DevTools protocol command on a target's socket. */
function cdp(socket, id, method, params = {}) {
  return new Promise((done, fail) => {
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      if (message.error) fail(new Error(message.error.message))
      else done(message.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** The control panel's state, read in its page: where it is, and what it shows. */
const READ_PANEL = `JSON.stringify({
  href: location.href,
  title: document.title,
  rootChildren: document.getElementById('root')?.childElementCount ?? 0,
  text: (document.body?.innerText ?? '').slice(0, 4000),
  api: typeof window.valet,
  node: typeof process,
})`

async function readControlPanel(port, deadline) {
  let last = null
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find(
        (t) => t.type === 'page' && String(t.url).startsWith('app://renderer/index.html'),
      )
      if (page !== undefined) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((ready, fail) => {
          socket.addEventListener('open', ready, { once: true })
          socket.addEventListener('error', fail, { once: true })
        })
        try {
          const result = await cdp(socket, 1, 'Runtime.evaluate', {
            expression: READ_PANEL,
            returnByValue: true,
          })
          last = JSON.parse(result.result.value)
          if (last.rootChildren > 0 && /Woolworths/.test(last.text)) {
            const shot = await cdp(socket, 2, 'Page.captureScreenshot', { format: 'png' })
            return { ...last, screenshot: shot.data, targets: targets.map((t) => `${t.type} ${t.url}`) }
          }
        } finally {
          socket.close()
        }
      }
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return last
}

/** Waits for the smoke build's self-check report under `userData`. */
async function smokeReport(userData, deadline) {
  const path = join(userData, SMOKE_REPORT_FILE)
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        // Still being written.
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

/** Runs the packaged app until the panel renders (or the deadline), then quits it. */
async function launchReal(app, home, userData) {
  const executable = join(
    app,
    'Contents',
    'MacOS',
    plist(join(app, 'Contents', 'Info.plist')).CFBundleExecutable,
  )
  // The smoke build's own argv: no host but loopback resolves, so the real adapter never reaches its
  // site from a smoke run.
  const child = spawn(executable, [...SMOKE_ARGV], {
    env: homeEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => {
    output += d
  })
  child.stderr.on('data', (d) => {
    output += d
  })
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })))
  const port = await devtoolsPort(child, 20_000)
  const panel = port === null ? null : await readControlPanel(port, Date.now() + RENDER_TIMEOUT_MS)
  const report = panel === null ? null : await smokeReport(userData, Date.now() + 15_000)
  // The app's own quit path (SIGTERM → app.quit, bounded at 5 s), then a kill if it hangs.
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  const exit = await exited
  clearTimeout(timer)
  return { port, panel, report, exit, output }
}

/** How long a refused launch may take to exit. */
export const REFUSE_TIMEOUT_MS = 10_000

/**
 * Launches the packaged app with argv or an environment it must refuse: it must exit with status 64
 * within REFUSE_TIMEOUT_MS, show no page of the app, and write none of the app's data. Whether a
 * DevTools listener came up first (Chromium parses its switches before main runs) is recorded.
 */
export async function launchRefused(app, home, args, extraEnv = {}, { userDataName = 'Valet Dev' } = {}) {
  const executable = join(
    app,
    'Contents',
    'MacOS',
    plist(join(app, 'Contents', 'Info.plist')).CFBundleExecutable,
  )
  const child = spawn(executable, args, { env: homeEnv(home, extraEnv), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => {
    output += d
  })
  child.stderr.on('data', (d) => {
    output += d
  })
  const started = Date.now()
  const exit = await new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ code: null, signal: 'SIGKILL', timedOut: true })
    }, REFUSE_TIMEOUT_MS)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      done({ code, signal, timedOut: false })
    })
  })
  const userData = join(home, 'Library', 'Application Support', userDataName)
  const written = existsSync(userData)
    ? readdirSync(userData).filter((name) =>
        ['audit.jsonl', 'bridge.json', 'versions.json', 'settings.json', SMOKE_REPORT_FILE].includes(name),
      )
    : []
  return {
    exit,
    ms: Date.now() - started,
    refusedMessage:
      output.includes('valet: refused to start') || output.includes('bridge mode is not built yet'),
    devtoolsListened: /DevTools listening on/.test(output),
    written,
  }
}

/** Argv and environments the packaged app must refuse, even a smoke build. */
const REFUSALS = [
  { name: 'a DevTools port alone', args: ['--remote-debugging-port=0'] },
  { name: 'a single-dash DevTools port', args: ['-remote-debugging-port=0'] },
  { name: 'the smoke argv and one more', args: [...SMOKE_ARGV, '--proxy-server=127.0.0.1:9'] },
  { name: 'the smoke argv reordered', args: [...SMOKE_ARGV].reverse() },
  { name: 'a host resolver rule', args: ['--host-resolver-rules=MAP * 127.0.0.1'] },
  { name: 'a relative bridge config', args: ['--mcp-bridge', 'bridge.json'] },
  { name: 'ELECTRON_ENABLE_LOGGING', args: [...SMOKE_ARGV], env: { ELECTRON_ENABLE_LOGGING: '1' } },
  // NODE_EXTRA_CA_CERTS isn't here: Electron removes it (and NODE_OPTIONS) from the environment
  // itself when the NodeOptions fuse is off, so main never sees it.
  { name: 'NODE_TLS_REJECT_UNAUTHORIZED', args: [...SMOKE_ARGV], env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
]

/**
 * Packages the real out/ build into `work`, checks it, and launches it under `home`. `expectEqual`
 * records failures. Returns the summary.
 */
export async function smokeRealApp({ work, arch, dist, home, expectEqual, expectedFuses, fuses }) {
  const bundle = mainBundle()
  if (bundle === null)
    throw new Error('no out/main/index.js: run `electron-vite build --mode smoke` first (package:smoke does)')
  if (!bundle.includes(SMOKE_BUILD_MARKER))
    throw new Error('out/ is not a smoke build: run `electron-vite build --mode smoke` (package:smoke does)')
  const output = join(work, 'real')
  runBuilder({ projectDir: APP_DIR, output, targets: ['dir'], arch, dist, env: cleanEnv() })
  const app = appPath(output, arch)
  const info = plist(join(app, 'Contents', 'Info.plist'))
  const resources = join(app, 'Contents', 'Resources')
  const files = asarFiles(join(resources, 'app.asar'))
  const unexpected = files.filter((f) => !ASAR_ALLOWED.some((pattern) => pattern.test(f)))

  expectEqual('real: CFBundleIdentifier', info.CFBundleIdentifier, 'me.dncr.valet.dev')
  expectEqual('real: CFBundleName', info.CFBundleName, 'Valet Dev')
  expectEqual('real: LSUIElement', info.LSUIElement, true)
  expectEqual('real: ElectronAsarIntegrity', Object.keys(info.ElectronAsarIntegrity ?? {}), [
    'Resources/app.asar',
  ])
  expectEqual('real: fuses', { ...fuses(app), version: undefined, fuse8: undefined }, { ...expectedFuses })
  expectEqual('real: Resources/app folder', existsSync(join(resources, 'app')), false)
  expectEqual('real: default_app.asar', existsSync(join(resources, 'default_app.asar')), false)
  expectEqual('real: asar holds only the build and the SDK', unexpected, [])
  for (const needed of [
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/preload/sandbox.cjs',
    'out/preload/quickjs.wasm',
    'out/renderer/index.html',
    'out/renderer/tray.html',
    'node_modules/@1password/sdk/dist/sdk.js',
    'node_modules/@1password/sdk-core/nodejs/core_bg.wasm',
    'node_modules/esbuild-wasm/lib/browser.js',
    'node_modules/esbuild-wasm/esbuild.wasm',
  ])
    expectEqual(`real: asar has ${needed}`, files.includes(needed), true)
  // A demo build's code and fixtures never ship.
  expectEqual(
    'real: no demo chunk or fixtures',
    files.filter((f) => /demo|fixtures/.test(f)),
    [],
  )

  const before = realFolders()
  const userData = join(home, 'Library', 'Application Support', 'Valet Dev')
  const launch = await launchReal(app, home, userData)
  const refusals = {}
  for (const [i, refusal] of REFUSALS.entries()) {
    const result = await launchRefused(app, makeHome(work, `refused-${i}`), refusal.args, refusal.env)
    refusals[refusal.name] = result
    expectEqual(
      `real: refuses ${refusal.name}`,
      { code: result.exit.code, message: result.refusedMessage },
      { code: 64, message: true },
    )
    expectEqual(`real: refusing ${refusal.name} wrote no app data`, result.written, [])
  }
  const after = realFolders()
  const panel = launch.panel
  if (panel?.screenshot)
    writeFileSync(join(work, 'control-panel.png'), Buffer.from(panel.screenshot, 'base64'))

  expectEqual('real: DevTools port read', launch.port !== null, true)
  expectEqual(
    'real: control panel on app://renderer',
    String(panel?.href ?? '').startsWith('app://renderer/index.html'),
    true,
  )
  expectEqual('real: control panel rendered', (panel?.rootChildren ?? 0) > 0, true)
  expectEqual(
    'real: control panel shows Woolworths waiting for review',
    /Woolworths/.test(panel?.text ?? ''),
    true,
  )
  expectEqual('real: the preload API is there', panel?.api, 'object')
  expectEqual('real: no Node in the renderer', panel?.node, 'undefined')
  expectEqual('real: quit cleanly', launch.exit.code, 0)
  expectEqual(
    'real: the 1Password SDK and electron-updater load in the packaged main process',
    {
      build: launch.report?.build,
      sdkResolves: launch.report?.sdkResolves,
      sdk: launch.report?.sdk,
      updater: launch.report?.updater,
    },
    { build: SMOKE_BUILD_MARKER, sdkResolves: 'ok', sdk: 'ok', updater: 'ok' },
  )
  expectEqual(
    'real: data under the temporary HOME',
    existsSync(join(userData, 'versions.json')) && existsSync(join(userData, 'bridge.json')),
    true,
  )
  expectEqual('real: real data folders untouched', after, before)

  return {
    app: app.replace(work, '<tmp>'),
    infoPlist: { CFBundleIdentifier: info.CFBundleIdentifier, CFBundleName: info.CFBundleName },
    asarFiles: files.length,
    unexpected,
    panel:
      panel === null
        ? null
        : { href: panel.href, title: panel.title, text: String(panel.text).slice(0, 300) },
    exit: launch.exit,
    selfCheck: launch.report,
    refusals: Object.fromEntries(
      Object.entries(refusals).map(([name, r]) => [
        name,
        { code: r.exit.code, ms: r.ms, devtoolsListened: r.devtoolsListened },
      ]),
    ),
    output: launch.output.split('\n').filter((l) => l.startsWith('valet:')),
  }
}

/** A fresh, empty home for a launch. */
export function makeHome(work, name) {
  const home = join(work, `home-${name}`)
  mkdirSync(home, { recursive: true })
  return home
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
