// The placeholder main process package-smoke.mjs packages: it reports what the packaged app sees and
// exits. It opens no window: the smoke run checks packaging and fuses, not the renderer, and helper
// processes may not be able to start where the script runs (a sandboxed agent shell, CI).

const { app } = require('electron')
const fs = require('node:fs')

// Cookie encryption is on; the smoke run must not create or read a Keychain item.
app.commandLine.appendSwitch('use-mock-keychain')

const report = {
  name: app.getName(),
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  argv: process.argv.slice(1),
  preloadedByNodeOptions: globalThis.__smokeInjected === true,
}

app.whenReady().then(() => {
  const out = process.env.SITEADAPTER_SMOKE_REPORT
  if (out) fs.writeFileSync(out, JSON.stringify(report))
  app.exit(0)
})
