// The placeholder main process package-smoke.mjs packages: it reports what the packaged app sees and
// exits. With VALET_SMOKE_WINDOW=1 it also loads the renderer page in two hidden windows, once
// from app:// through src/main/core/app-scheme.ts (as the real main process must) and once with
// loadFile, and reports each window's title: the page's module script sets it, so a title of
// 'module-ok' means the script ran. With grantFileProtocolExtraPrivileges off, only app:// should.

const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// Cookie encryption is on; the smoke run must not create or read a Keychain item.
app.commandLine.appendSwitch('use-mock-keychain')

const withWindow = process.env.VALET_SMOKE_WINDOW === '1'
// Before ready, synchronously; the report checks these equal app-scheme.ts's constants.
const SCHEME = 'app'
const PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true }
if (withWindow) protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: PRIVILEGES }])

const report = {
  name: app.getName(),
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  argv: process.argv.slice(1),
  preloadedByNodeOptions: globalThis.__smokeInjected === true,
  // Where this launch keeps its data: the smoke checks a temporary HOME moves them before it
  // launches the real app with one.
  paths: { home: app.getPath('home'), appData: app.getPath('appData'), userData: app.getPath('userData') },
}

/** Loads a URL in a hidden window and returns the title once the module script set it, or after 15 s. */
async function titleOf(load) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await load(window).catch(() => {})
    const deadline = Date.now() + 15_000
    while (window.webContents.getTitle() !== 'module-ok' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return window.webContents.getTitle()
  } finally {
    window.destroy()
  }
}

async function windows() {
  const scheme = await import('./app-scheme.mjs')
  const root = path.join(app.getAppPath(), 'out', 'renderer')
  protocol.handle(
    scheme.APP_SCHEME,
    scheme.createAppSchemeHandler({ root, readFile: (file) => fs.promises.readFile(file) }),
  )
  return {
    schemeMatches:
      scheme.APP_SCHEME === SCHEME &&
      JSON.stringify(scheme.APP_SCHEME_PRIVILEGES) === JSON.stringify(PRIVILEGES),
    appScheme: await titleOf((w) => w.loadURL(scheme.appPageUrl('index.html'))),
    loadFile: await titleOf((w) => w.loadFile(path.join(root, 'index.html'))),
  }
}

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  if (withWindow) {
    try {
      report.window = await windows()
    } catch (error) {
      report.window = { error: String(error?.name) }
    }
  }
  const out = process.env.VALET_SMOKE_REPORT
  if (out) fs.writeFileSync(out, JSON.stringify(report))
  app.exit(0)
})
