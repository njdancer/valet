// The second half of package-smoke.mjs: the real app, from the real out/ build, packaged the way
// `package` packages it, then launched with a window to see that the control panel renders.
//
// The launch must not touch the real userData folder, the real Keychain or the person's own
// session state. So the child gets a temporary HOME (and CFFIXED_USER_HOME, which CoreFoundation
// reads for the home directory), Chromium's mock keychain, and none of the caller's CSC_*, APPLE_*,
// SITEADAPTER_*, ELECTRON_* or NODE_OPTIONS variables. package-smoke.mjs first launches the
// placeholder the same way and refuses to go on unless app.getPath('appData') moved under the
// temporary HOME; afterwards this checks that the app's data did land there, and that the real
// ~/Library/Application Support/siteadapter(-dev) folders are as they were.
//
// The control panel is read over the DevTools protocol: --remote-debugging-port=0, the port taken
// from Chromium's "DevTools listening on" line. Playwright's Electron launcher needs --inspect,
// which the NodeCliInspect fuse turns off; Chromium's own switch still works, which is the gap
// docs/release-and-updates.md describes under "Command-line switches".

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_DIR, appPath, asarFiles, cleanEnv, plist, runBuilder } from '../packaging.mjs'

/** How long the real app has to show a rendered control panel. */
const RENDER_TIMEOUT_MS = 45_000

/** A launch environment with only a temporary home: what both the placeholder and the app get. */
export function homeEnv(home, extra = {}) {
  return cleanEnv({ HOME: home, CFFIXED_USER_HOME: home, ...extra })
}

/** True when `path` is `dir` or inside it. */
export function inside(path, dir) {
  return typeof path === 'string' && (path === dir || path.startsWith(`${dir}/`))
}

/** What the real folders look like now, to compare after the launch: existence and mtimes. */
function realFolders() {
  const support = join(homedir(), 'Library', 'Application Support')
  const state = {}
  for (const name of ['siteadapter', 'siteadapter-dev']) {
    const dir = join(support, name)
    try {
      const s = statSync(dir)
      state[name] = { exists: true, mtimeMs: s.mtimeMs }
    } catch {
      state[name] = { exists: false }
    }
  }
  return state
}

/** Every file the packaged app must carry, by pattern, and nothing else. */
const ASAR_ALLOWED = [
  /^package\.json$/,
  /^out\/main\/index\.js$/,
  /^out\/main\/chunks\/[\w-]+\.js$/,
  /^out\/preload\/index\.cjs$/,
  /^out\/renderer\/(index|tray)\.html$/,
  /^out\/renderer\/assets\/[\w-]+\.(js|css|svg|png|woff2)$/,
  /^node_modules\/@1password\/sdk\/(package\.json|dist\/[\w]+\.js)$/,
  /^node_modules\/@1password\/sdk-core\/(package\.json|nodejs\/core\.js|nodejs\/core_bg\.wasm)$/,
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
  api: typeof window.siteadapter,
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

/** Runs the packaged app until the panel renders (or the deadline), then quits it. */
async function launchReal(app, home) {
  const executable = join(
    app,
    'Contents',
    'MacOS',
    plist(join(app, 'Contents', 'Info.plist')).CFBundleExecutable,
  )
  // No host but loopback resolves: the real adapter must never reach its site from a smoke run.
  const args = [
    '--use-mock-keychain',
    '--remote-debugging-port=0',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  ]
  const child = spawn(executable, args, {
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
  // The app's own quit path (SIGTERM → app.quit, bounded at 5 s), then a kill if it hangs.
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  const exit = await exited
  clearTimeout(timer)
  return { port, panel, exit, output }
}

/**
 * Packages the real out/ build into `work`, checks it, and launches it under `home`. `expectEqual`
 * records failures. Returns the summary.
 */
export async function smokeRealApp({ work, arch, dist, home, expectEqual, expectedFuses, fuses }) {
  if (!existsSync(join(APP_DIR, 'out', 'main', 'index.js')))
    throw new Error('no out/main/index.js: run `electron-vite build` first (package:smoke does)')
  const output = join(work, 'real')
  runBuilder({ projectDir: APP_DIR, output, targets: ['dir'], arch, dist, env: cleanEnv() })
  const app = appPath(output, arch)
  const info = plist(join(app, 'Contents', 'Info.plist'))
  const resources = join(app, 'Contents', 'Resources')
  const files = asarFiles(join(resources, 'app.asar'))
  const unexpected = files.filter((f) => !ASAR_ALLOWED.some((pattern) => pattern.test(f)))

  expectEqual('real: CFBundleIdentifier', info.CFBundleIdentifier, 'me.dncr.siteadapter.dev')
  expectEqual('real: CFBundleName', info.CFBundleName, 'siteadapter-dev')
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
    'out/renderer/index.html',
    'out/renderer/tray.html',
    'node_modules/@1password/sdk/dist/sdk.js',
    'node_modules/@1password/sdk-core/nodejs/core_bg.wasm',
  ])
    expectEqual(`real: asar has ${needed}`, files.includes(needed), true)
  // A demo build's code and fixtures never ship.
  expectEqual(
    'real: no demo chunk or fixtures',
    files.filter((f) => /demo|fixtures/.test(f)),
    [],
  )

  const before = realFolders()
  const launch = await launchReal(app, home)
  const after = realFolders()
  const userData = join(home, 'Library', 'Application Support', 'siteadapter-dev')
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
    output: launch.output.split('\n').filter((l) => l.startsWith('siteadapter:')),
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
