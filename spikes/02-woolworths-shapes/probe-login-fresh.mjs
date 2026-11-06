// Spike 2c: a fresh in-memory session visits the homepage and then the login page as a normal
// visitor would, with no scripted API calls. Records the login form's structure (no values), the
// navigation chain, the endpoints the page itself calls, and a screenshot. Nothing is typed or submitted.
import { app, BrowserWindow, session } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DESCRIBE = `(() => {
  const out = []
  const walk = (root, depth) => {
    for (const el of root.querySelectorAll('input, button, form, select, [role=dialog], iframe')) {
      out.push({ depth, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), id: el.id || null, name: el.getAttribute('name'),
        autocomplete: el.getAttribute('autocomplete'), inputmode: el.getAttribute('inputmode'),
        formAction: el.tagName === 'FORM' ? el.action : (el.form ? el.form.action : null), formId: el.form ? (el.form.id || null) : null,
        ariaLabel: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'), testId: el.getAttribute('data-testid'),
        src: el.tagName === 'IFRAME' ? el.src : null,
        text: el.tagName === 'BUTTON' ? el.textContent.trim().slice(0, 60) : null, visible: !!(el.offsetWidth || el.offsetHeight) })
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot, depth + 1)
  }
  walk(document, 0)
  return { url: location.href, title: document.title, headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.textContent.trim().slice(0, 80)), elements: out }
})()`

async function run() {
  const ses = session.fromPartition('spike02c-fresh') // no "persist:" prefix: in memory only
  const calls = []
  const navs = []
  ses.webRequest.onCompleted((d) => {
    if (!/woolworths|wowlabs|woolies/i.test(new URL(d.url).host)) return
    if (['xhr', 'fetch', 'mainFrame', 'subFrame'].includes(d.resourceType)) {
      const u = new URL(d.url)
      calls.push(`${d.resourceType} ${d.method} ${u.host}${u.pathname} ${d.statusCode}`)
    }
  })
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { partition: 'spike02c-fresh' } })
  win.webContents.on('did-navigate', (_e, url) => navs.push(url.split('?')[0]))
  win.webContents.on('did-navigate-in-page', (_e, url) => navs.push(`in-page ${url.split('?')[0]}`))
  await win.loadURL('https://www.woolworths.com.au/').catch(() => {})
  await sleep(9000)
  const home = await win.webContents.executeJavaScript('({ title: document.title, url: location.href })')
  await win.loadURL('https://www.woolworths.com.au/shop/securelogin').catch(() => {})
  await sleep(12000)
  const login = await win.webContents.executeJavaScript(DESCRIBE)
  const shot = await win.webContents.capturePage()
  await writeFile(join(import.meta.dirname, 'results', 'login-fresh.png'), shot.toPNG())
  await writeFile(join(import.meta.dirname, 'results', 'login-fresh.json'), JSON.stringify({ home, login, navigations: navs, calls: [...new Set(calls)] }, null, 2))
  console.log('[spike02c] wrote results/login-fresh.json and .png')
  win.destroy()
  app.quit()
}
app.on('window-all-closed', () => {})
app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1) })
