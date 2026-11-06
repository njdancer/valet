// Spike 2: record the shapes of Woolworths' public API responses and the structure of its login
// form, anonymously, so the fake site and adapter fixtures match reality. No login, no cart
// writes, a handful of paced requests. Cookie values are never recorded.
//
// Run: pnpm start   (writes results/*.json)

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'

const ORIGIN = 'https://www.woolworths.com.au'
const PARTITION = 'persist:spike02-anonymous'
const GAP_MS = 2500
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const resultsDir = join(import.meta.dirname, 'results')

async function navigate(win, url) {
  try {
    await win.loadURL(url)
  } catch (error) {
    if (!String(error).includes('ERR_ABORTED')) throw error
    await new Promise((resolve) => win.webContents.once('did-stop-loading', resolve))
  }
}

const inPage = (win, code) => win.webContents.executeJavaScript(code)

const fetchJson = (path, init = {}) => `(async () => {
  const response = await fetch(${JSON.stringify(path)}, { credentials: 'same-origin', headers: { accept: 'application/json', ...(${JSON.stringify(init.headers ?? {})}) }, method: ${JSON.stringify(init.method ?? 'GET')}, ${init.body ? `body: ${JSON.stringify(JSON.stringify(init.body))},` : ''} })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { nonJson: text.slice(0, 300) } }
  return { status: response.status, contentType: response.headers.get('content-type'), body }
})()`

// Describes the structure of a login form without touching any values.
const DESCRIBE_FORMS = `(() => [...document.querySelectorAll('form')].map((form) => ({
  id: form.id || null,
  name: form.getAttribute('name'),
  action: form.action || null,
  method: form.method,
  fields: [...form.querySelectorAll('input, button, select')].map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    id: el.id || null,
    name: el.getAttribute('name'),
    autocomplete: el.getAttribute('autocomplete'),
    inputmode: el.getAttribute('inputmode'),
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    dataTestId: el.getAttribute('data-testid'),
    text: el.tagName === 'BUTTON' ? el.textContent.trim().slice(0, 60) : null,
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  })),
})))()`

async function run() {
  const ses = session.fromPartition(PARTITION)
  const apiCalls = []
  ses.webRequest.onCompleted({ urls: ['https://*.woolworths.com.au/*'] }, (details) => {
    const url = new URL(details.url)
    if (
      /^\/(apis?|api\/v\d)\//i.test(url.pathname) ||
      details.resourceType === 'xhr' ||
      details.resourceType === 'fetch'
    ) {
      apiCalls.push({
        method: details.method,
        host: url.host,
        path: url.pathname,
        status: details.statusCode,
        type: details.resourceType,
      })
    }
  })
  const hosts = new Set()
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      hosts.add(new URL(details.url).host)
    } catch {}
    callback({})
  })

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { partition: PARTITION },
  })
  const out = { at: new Date().toISOString(), electron: process.versions.electron, steps: {} }

  await navigate(win, `${ORIGIN}/`)
  await sleep(6000)
  out.steps.home = { title: await inPage(win, 'document.title'), url: win.webContents.getURL() }
  out.cookieNamesAfterHome = (await ses.cookies.get({}))
    .map((c) => `${c.domain} ${c.name}${c.httpOnly ? ' (httpOnly)' : ''}`)
    .sort()

  const probes = [
    [
      'search',
      '/apis/ui/Search/products',
      {
        method: 'POST',
        body: {
          SearchTerm: 'milk',
          PageSize: 3,
          PageNumber: 1,
          SortType: 'TraderRelevance',
          Location: '/shop/search/products?searchTerm=milk',
          Filters: [],
          IsSpecial: false,
          isMobile: false,
          IsHideEverydayMarketProducts: false,
          IsRegisteredRewardCardPromotion: null,
          ExcludeSearchTypes: ['UntraceableVendors'],
          GpBoost: 0,
          GroupEdmVariants: true,
          EnableAdReRanking: false,
          flags: { EnableProductBoostExperiment: false },
        },
        headers: { 'content-type': 'application/json' },
      },
    ],
    ['searchGet', '/apis/ui/Search/products?searchTerm=milk&pageSize=3&pageNumber=1', {}],
    ['trolley', '/apis/ui/Trolley', {}],
  ]
  for (const [name, path, init] of probes) {
    out.steps[name] = await inPage(win, fetchJson(path, init)).catch((error) => ({ error: String(error) }))
    await sleep(GAP_MS)
  }

  const firstStockcode = findStockcode(out.steps.search?.body) ?? findStockcode(out.steps.searchGet?.body)
  if (firstStockcode) {
    out.steps.productDetail = await inPage(win, fetchJson(`/apis/ui/product/detail/${firstStockcode}`)).catch(
      (error) => ({ error: String(error) }),
    )
    await sleep(GAP_MS)
  }

  await navigate(win, `${ORIGIN}/shop/securelogin`)
  await sleep(8000)
  out.steps.login = {
    url: win.webContents.getURL(),
    title: await inPage(win, 'document.title'),
    forms: await inPage(win, DESCRIBE_FORMS),
    iframes: await inPage(win, `[...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean)`),
  }

  out.apiCallsSeen = apiCalls
  out.hostsContacted = [...hosts].sort()
  await mkdir(resultsDir, { recursive: true })
  await writeFile(join(resultsDir, 'shapes.json'), JSON.stringify(out, null, 2))
  console.log(`[spike02] wrote ${join(resultsDir, 'shapes.json')}`)
  win.destroy()
  app.quit()
}

function findStockcode(body) {
  const seen = new Set()
  const visit = (value) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return null
    seen.add(value)
    if (typeof value.Stockcode === 'number') return value.Stockcode
    for (const child of Object.values(value)) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  return visit(body)
}

app.on('window-all-closed', () => {})
app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error('[spike02] failed:', error)
    app.exit(1)
  })
