// Spike 2b: login page structure (inputs anywhere, including shadow roots) and the
// login-status endpoints the site calls, anonymously. No values typed, nothing submitted.
import { app, BrowserWindow, session } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PARTITION = 'persist:spike02-anonymous'
const fetchJson = (path) => `(async () => { const r = await fetch(${JSON.stringify(path)}, { credentials: 'same-origin', headers: { accept: 'application/json' } }); const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = { nonJson: t.slice(0, 300) } } return { status: r.status, body: b } })()`
const DESCRIBE_INPUTS = `(() => {
  const out = []
  const walk = (root, depth) => {
    for (const el of root.querySelectorAll('input, button, form, [role=dialog]')) {
      out.push({ depth, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), id: el.id || null, name: el.getAttribute('name'),
        autocomplete: el.getAttribute('autocomplete'), formAction: el.form ? el.form.action : (el.tagName === 'FORM' ? el.action : null),
        ariaLabel: el.getAttribute('aria-label'), testId: el.getAttribute('data-testid'), cls: (el.className && el.className.baseVal === undefined ? String(el.className) : '').slice(0, 80),
        text: el.tagName === 'BUTTON' ? el.textContent.trim().slice(0, 60) : null, visible: !!(el.offsetWidth || el.offsetHeight) })
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot, depth + 1)
  }
  walk(document, 0)
  return { url: location.href, headings: [...document.querySelectorAll('h1,h2')].map((h) => h.textContent.trim().slice(0, 80)), elements: out }
})()`

async function run() {
  const ses = session.fromPartition(PARTITION)
  const calls = []
  const navs = []
  ses.webRequest.onCompleted({ urls: ['https://*.woolworths.com.au/*', 'https://*.woolworthsrewards.com.au/*', 'https://*.wowlabs.com.au/*'] }, (d) => {
    const u = new URL(d.url)
    if (d.resourceType === 'xhr' || d.resourceType === 'fetch' || d.resourceType === 'mainFrame' || d.resourceType === 'subFrame') calls.push(`${d.resourceType} ${d.method} ${u.host}${u.pathname} ${d.statusCode}`)
  })
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { partition: PARTITION } })
  win.webContents.on('did-navigate', (_e, url) => navs.push(url.split('?')[0]))
  win.webContents.on('did-navigate-in-page', (_e, url) => navs.push(`in-page ${url.split('?')[0]}`))
  await win.loadURL('https://www.woolworths.com.au/').catch(() => {})
  await sleep(5000)
  const out = {}
  out.bootstrap = await win.webContents.executeJavaScript(fetchJson('/api/ui/v2/bootstrap'))
  await sleep(2500)
  out.heartbeat = await win.webContents.executeJavaScript(fetchJson('/auth/heartbeat'))
  await sleep(2500)
  await win.loadURL('https://www.woolworths.com.au/shop/securelogin').catch(() => {})
  await sleep(10000)
  out.loginPage = await win.webContents.executeJavaScript(DESCRIBE_INPUTS)
  out.navigations = navs
  out.calls = [...new Set(calls)]
  await writeFile(join(import.meta.dirname, 'results', 'login.json'), JSON.stringify(out, null, 2))
  console.log('[spike02b] wrote results/login.json')
  win.destroy()
  app.quit()
}
app.on('window-all-closed', () => {})
app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1) })
