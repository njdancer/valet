// Spike 2d (authorised by Nick): is the block keyed on the user agent? Fresh in-memory session,
// homepage only, once with Electron's default UA and once with a clean Chrome UA.
import { app, BrowserWindow, session } from 'electron'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function visit(label, ua) {
  const partition = `spike02d-${label}`
  const ses = session.fromPartition(partition)
  if (ua) ses.setUserAgent(ua, 'en-AU,en')
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { partition } })
  await win.loadURL('https://www.woolworths.com.au/').catch(() => {})
  await sleep(6000)
  const info = await win.webContents.executeJavaScript('({ title: document.title, ua: navigator.userAgent, visibility: document.visibilityState, focus: document.hasFocus() })')
  console.log(`[spike02d] ${label}: ${JSON.stringify(info)}`)
  win.destroy()
}
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const major = process.versions.chrome.split('.')[0]
  await visit('default', null)
  await sleep(3000)
  await visit('chrome', `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`)
  app.quit()
})
