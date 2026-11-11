// Server-rendered www pages: a small supermarket under the fake's own made-up brand (brand.ts). The
// real site is a single-page app, but a browser driver only cares about the DOM it ends up with.
// Signing in happens on the auth origin (auth-pages.ts); www has only the "not logged in" page that
// links there, and a header search box that must never receive a secret.
//
// The element ids and classes an adapter or test selects on (header-Login, headerSearch-Input,
// securelogin-Login, .product-tile[data-stockcode], .product-price, …) are kept as they were. No
// page makes a request by itself on load: the trolley count is rendered here, and the only scripts
// beyond the sensor run on a click (add to trolley, place order).

import { sensorScript } from './akamai'
import { BASE_CSS, HOUSE_BRAND, LOGO_SVG, rebrandText, STORE_NAME } from './brand'
import { money } from './catalogue'
import type { Product } from './fixtures'

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export interface PageContext {
  /** The `_abck` value the sensor script sets if the browser has none yet. */
  readonly sensorValue: string
  /** First name of the logged-in shopper, or null when anonymous. */
  readonly shopper: string | null
  /** Extra markup for the head, from a hostile variant (beacon.ts). Empty or absent normally. */
  readonly pageScript?: string
  /** Items in the visitor's trolley and their total, for the header. Absent: an empty trolley. */
  readonly trolley?: { readonly count: number; readonly total: number }
}

/** A product's name as the shop shows it: its own house brand, not the captured one. */
export function shopName(name: string): string {
  return rebrandText(name, HOUSE_BRAND)
}

const PAGE_CSS = `
.header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:20px;padding:12px 28px;background:var(--leaf);color:#fff}
.header-logo{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-weight:800;font-size:20px;letter-spacing:-.2px;white-space:nowrap}
.header-logo .logo-mark rect{fill:#fff}.header-logo .logo-mark path:last-child{stroke:#fff}
.header-search{flex:1;display:flex;max-width:620px;background:#fff;border-radius:999px;overflow:hidden}
.header-search input{flex:1;border:0;padding:11px 18px;font:inherit;outline:none}
.header-search button{border:0;background:var(--wattle);color:var(--ink);font-weight:700;padding:0 20px;cursor:pointer}
.header-account{display:flex;align-items:center;gap:16px;margin-left:auto;white-space:nowrap}
.header-account a{color:#fff;text-decoration:none;font-weight:600}
.header-trolley{display:flex;align-items:center;gap:8px;background:var(--leaf-dark);padding:8px 14px;border-radius:999px}
.header-trolley .count{background:var(--wattle);color:var(--ink);border-radius:999px;min-width:22px;text-align:center;font-size:13px;padding:1px 6px}
.subnav{display:flex;gap:22px;padding:10px 28px;background:#fff;border-bottom:1px solid var(--line);font-weight:600;font-size:14px}
.subnav a{text-decoration:none;color:var(--ink)}
main{max-width:1180px;margin:0 auto;padding:26px 28px 60px}
h1{font-size:28px;letter-spacing:-.3px;margin:6px 0 14px}
.hero{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;margin-bottom:26px}
.hero-main{background:linear-gradient(120deg,var(--leaf),#2f8f6f);color:#fff;border-radius:18px;padding:34px}
.hero-main h1{font-size:34px;margin:0 0 8px}.hero-main p{margin:0 0 18px;opacity:.9}
.hero-main .button{background:var(--wattle);color:var(--ink)}
.hero-side{background:#fff4d6;border-radius:18px;padding:26px;display:flex;flex-direction:column;justify-content:center}
.hero-side strong{font-size:22px}
.departments{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:0 0 30px}
.departments a{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;text-align:center;text-decoration:none;color:var(--ink);font-weight:600}
.departments span{display:block;font-size:30px}
.product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
.product-tile{position:relative;display:flex;flex-direction:column;gap:4px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.product-art{height:120px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:58px;margin-bottom:6px}
.product-title{font-size:15px;font-weight:600;margin:0;min-height:42px}
.product-price{font-size:22px;font-weight:800}
.product-cup{color:var(--muted);font-size:13px}
.product-special{position:absolute;top:10px;left:10px;background:var(--sale);color:#fff;font-size:12px;font-weight:700;border-radius:6px;padding:3px 8px}
.product-unavailable{color:var(--sale);font-weight:600;font-size:13px}
.product-tile .add{margin-top:8px}
.product-tile .add[disabled]{background:#c9d2cf;cursor:default}
.product-tile .in-trolley{color:var(--leaf);font-weight:700;font-size:13px}
.search-count{color:var(--muted);margin-top:-8px}
.panel{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px}
.trolley-layout{display:grid;grid-template-columns:1fr 400px;gap:22px;align-items:start}
.trolley-line{display:grid;grid-template-columns:64px 1fr auto auto;gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.trolley-line:last-child{border-bottom:0}
.trolley-line .product-art{height:56px;width:64px;font-size:30px;margin:0}
.trolley-line .qty{color:var(--muted)}.trolley-line .line-total{font-weight:700;min-width:70px;text-align:right}
.summary-row{display:flex;justify-content:space-between;margin:8px 0}.summary-row.total{font-size:20px;font-weight:800;border-top:1px solid var(--line);padding-top:12px}
.notice{background:#fff4d6;border-radius:10px;padding:10px 14px;margin:10px 0;font-size:14px}
.empty{color:var(--muted)}
.choice{display:flex;gap:12px;align-items:center;border:1.5px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0}
.choice.selected{border-color:var(--leaf);background:#eef6f3}
.order-done{text-align:center;padding:40px}
.order-done .tick{font-size:56px}
.order-number{font-size:22px;font-weight:800;letter-spacing:.5px}
footer{color:var(--muted);font-size:12px;text-align:center;padding:20px}
`

/** A picture for a product without an image request: an emoji on a department colour. */
export function productArt(product: Pick<Product, 'DisplayName'>): string {
  const name = product.DisplayName.toLowerCase()
  const art: [RegExp, string, string][] = [
    [/milk/, '🥛', '#e8f1fb'],
    [/bread/, '🍞', '#fbf0e0'],
    [/egg/, '🥚', '#fdf6e7'],
    [/banana/, '🍌', '#fdf8d8'],
    [/apple/, '🍎', '#fde8e6'],
    [/cheese|parmesan/, '🧀', '#fff3d1'],
    [/coffee/, '☕', '#efe6df'],
    [/butter/, '🧈', '#fff8dc'],
    [/biscuit|tim tam/, '🍪', '#f3e9e0'],
    [/cereal|corn flakes/, '🥣', '#fdeedd'],
  ]
  const [, emoji, colour] = art.find(([pattern]) => pattern.test(name)) ?? [/./, '🛒', '#eef2f0']
  return `<div class="product-art" style="background:${colour}" aria-hidden="true">${emoji}</div>`
}

/** Clicking "Add" posts the site's own trolley update, then reloads to show the new count. */
const ADD_SCRIPT = `<script>
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button.add[data-stockcode]')
  if (!button) return
  button.disabled = true
  button.textContent = 'Adding…'
  const stockcode = Number(button.dataset.stockcode)
  const quantity = Number(button.dataset.quantity || 0) + 1
  const response = await fetch('/api/v3/ui/trolley/update', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ stockcode, quantity }] }),
  })
  if (response.ok) location.reload()
  else { button.textContent = 'Try again'; button.disabled = false }
})
</script>`

function layout(title: string, context: PageContext, main: string, extraHead = ''): string {
  const trolley = context.trolley ?? { count: 0, total: 0 }
  const account =
    context.shopper === null
      ? '<a id="header-Login" href="/shop/securelogin">Log in</a>'
      : `<a id="header-Account" href="/shop/myaccount">Hi ${escapeHtml(context.shopper)}</a>
      <a id="header-Logout" href="/auth/logout">Log out</a>`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  ${sensorScript(context.sensorValue)}${context.pageScript ?? ''}
  <style>${BASE_CSS}${PAGE_CSS}</style>${extraHead}
</head>
<body>
  <header class="header">
    <a class="header-logo" href="/">${LOGO_SVG}${STORE_NAME}</a>
    <form id="headerSearch" class="header-search" role="search" action="/shop/search/products" method="get">
      <input id="headerSearch-Input" type="search" name="searchTerm" placeholder="Search products, recipes &amp; ideas" aria-label="Search products" autocomplete="off">
      <button id="headerSearch-Submit" type="submit">Search</button>
    </form>
    <nav class="header-account">
      ${account}
      <a class="header-trolley" id="header-Trolley" href="/shop/trolley">🛒 ${money(trolley.total)} <span class="count">${trolley.count}</span></a>
    </nav>
  </header>
  <nav class="subnav">${DEPARTMENTS.map(([label, term]) => `<a href="/shop/search/products?searchTerm=${term}">${label}</a>`).join('')}</nav>
  <main>
${main}
  </main>
  <footer>${STORE_NAME} is a made-up shop for testing. Nothing here is for sale.</footer>
</body>
</html>
`
}

const DEPARTMENTS: readonly (readonly [string, string, string])[] = [
  ['Milk', 'milk', '🥛'],
  ['Bread', 'bread', '🍞'],
  ['Eggs', 'eggs', '🥚'],
  ['Fruit', 'bananas', '🍌'],
  ['Cheese', 'cheese', '🧀'],
  ['Coffee', 'coffee', '☕'],
]

export function homePage(context: PageContext, featured: readonly Product[] = []): string {
  const departments = DEPARTMENTS.map(
    ([label, term, emoji]) =>
      `<a href="/shop/search/products?searchTerm=${term}"><span>${emoji}</span>${label}</a>`,
  ).join('')
  return layout(
    `${STORE_NAME} - Buy Groceries Online`,
    context,
    `    <section class="hero">
      <div class="hero-main">
        <h1>${STORE_NAME}</h1>
        <p class="home-intro">Shop groceries online. Pick up in store today.</p>
        <a class="button" href="/shop/search/products?searchTerm=milk">Start shopping</a>
      </div>
      <div class="hero-side"><strong>Half price this week</strong><span>Tim Tams, coffee and more</span></div>
    </section>
    <section class="departments">${departments}</section>${
      featured.length === 0
        ? ''
        : `
    <h2>Specials</h2>
    <section class="product-grid">
${featured.map((product) => productTile(product, 0)).join('\n')}
    </section>`
    }`,
    featured.length === 0 ? '' : ADD_SCRIPT,
  )
}

/** www.woolworths.com.au/shop/securelogin, as seen live: no form, only a link that starts the login. */
export function notLoggedInPage(context: PageContext, loginHref: string): string {
  return layout(
    `Log in | ${STORE_NAME}`,
    context,
    `    <section class="panel">
    <h1>Oops! You're not logged in</h1>
    <p>Log in to see your trolley and check out.</p>
    <a id="securelogin-Login" class="button" href="${escapeHtml(loginHref)}">Login</a>
    </section>`,
  )
}

/** What www's callback shows when the state or code doesn't match a pending login. */
export function loginFailedPage(context: PageContext): string {
  return layout(
    `Log in | ${STORE_NAME}`,
    context,
    `    <h1 id="login-Failed">Sorry, we couldn't log you in</h1>
    <p>Please try again.</p>`,
  )
}

export function myAccountPage(context: PageContext): string {
  return layout(
    `My Account | ${STORE_NAME}`,
    context,
    `    <h1 id="myaccount-Greeting">Hi ${escapeHtml(context.shopper ?? '')}</h1>
    <p>Welcome to your account.</p>
    <p><a class="button" href="/shop/trolley">View trolley</a></p>`,
  )
}

function productTile(product: Product, inTrolley: number): string {
  const add = product.IsAvailable
    ? `\n        <button class="primary add" type="button" data-stockcode="${product.Stockcode}" data-quantity="${inTrolley}">Add to trolley</button>`
    : ''
  return `      <article class="product-tile" data-stockcode="${product.Stockcode}">
        ${productArt(product)}
        <h3 class="product-title">${escapeHtml(shopName(product.DisplayName))}</h3>
        <span class="product-price">${money(product.Price)}</span>
        <span class="product-cup">${escapeHtml(product.CupString)}</span>${
          product.IsOnSpecial
            ? `\n        <span class="product-special">Save ${money(product.WasPrice - product.Price)}</span>`
            : ''
        }${product.IsAvailable ? '' : '\n        <span class="product-unavailable">Unavailable</span>'}${
          inTrolley > 0 ? `\n        <span class="in-trolley">${inTrolley} in trolley</span>` : ''
        }${add}
      </article>`
}

export function searchPage(
  context: PageContext,
  term: string,
  products: readonly Product[],
  inTrolley: (stockcode: number) => number = () => 0,
): string {
  const tiles = products.map((product) => productTile(product, inTrolley(product.Stockcode))).join('\n')
  return layout(
    `${term} | ${STORE_NAME}`,
    context,
    `    <h1 class="search-heading">Results for “${escapeHtml(term)}”</h1>
    <p class="search-count">${products.length} products</p>
    <section class="product-grid">
${tiles}
    </section>`,
    ADD_SCRIPT,
  )
}

/** One trolley line, with the product it is for. */
export interface ShopLine {
  readonly product: Product
  readonly quantity: number
}

function lineTotal(line: ShopLine): number {
  return line.product.IsAvailable ? line.product.Price * line.quantity : 0
}

function linesHtml(lines: readonly ShopLine[]): string {
  return lines
    .map(
      (line) => `      <div class="trolley-line" data-stockcode="${line.product.Stockcode}">
        ${productArt(line.product)}
        <div><strong>${escapeHtml(shopName(line.product.DisplayName))}</strong><br><span class="qty">${money(line.product.Price)} each${line.product.IsAvailable ? '' : ' · unavailable'}</span></div>
        <span class="qty">× ${line.quantity}</span>
        <span class="line-total">${money(lineTotal(line))}</span>
      </div>`,
    )
    .join('\n')
}

export function trolleyPage(context: PageContext, lines: readonly ShopLine[], minimumSpend: number): string {
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0)
  const short = minimumSpend - total
  return layout(
    `Trolley | ${STORE_NAME}`,
    context,
    `    <h1>Your trolley</h1>
    <div class="trolley-layout">
      <section class="panel" id="trolley-Lines">
${lines.length === 0 ? '        <p class="empty">Your trolley is empty.</p>' : linesHtml(lines)}
      </section>
      <aside class="panel">
        <div class="summary-row"><span>Items</span><span>${lines.reduce((n, l) => n + l.quantity, 0)}</span></div>
        <div class="summary-row total"><span>Total</span><span id="trolley-Total">${money(total)}</span></div>${
          short > 0 && lines.length > 0
            ? `\n        <p class="notice">Pick up has a ${money(minimumSpend)} minimum spend. Add ${money(short)} more to check out.</p>`
            : ''
        }
        ${
          lines.length > 0 && short <= 0
            ? '<a class="button" id="trolley-Checkout" href="/shop/checkout">Checkout</a>'
            : '<a class="button secondary" href="/">Keep shopping</a>'
        }
      </aside>
    </div>`,
  )
}

/** Places the order through the site's own endpoint, then shows its confirmation. */
const ORDER_SCRIPT = `<script>
document.addEventListener('click', async (event) => {
  const button = event.target.closest('#checkout-PlaceOrder')
  if (!button) return
  button.disabled = true
  button.textContent = 'Placing order…'
  const response = await fetch('/api/v3/ui/checkout/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const body = response.ok ? await response.json() : null
  if (body && body.OrderId) location.href = '/shop/order/' + body.OrderId
  else { button.textContent = 'Something went wrong, try again'; button.disabled = false }
})
</script>`

export function checkoutPage(context: PageContext, lines: readonly ShopLine[]): string {
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0)
  return layout(
    `Checkout | ${STORE_NAME}`,
    context,
    `    <h1>Checkout</h1>
    <div class="trolley-layout">
      <section>
        <div class="panel">
          <h2>Pick up</h2>
          <div class="choice selected">🏪 <div><strong>${STORE_NAME} Surry Hills</strong><br><span class="qty">12 Example Street, Surry Hills NSW</span></div></div>
          <h2>Time</h2>
          <div class="choice selected">🕔 <div><strong>Today, 5:00 pm – 6:00 pm</strong><br><span class="qty">Free pick up</span></div></div>
          <h2>Payment</h2>
          <div class="choice selected">💳 <div><strong>Test card ending 4242</strong><br><span class="qty">Nothing is charged: this shop is made up</span></div></div>
        </div>
      </section>
      <aside class="panel">
        <h2>Order summary</h2>
${linesHtml(lines)}
        <div class="summary-row total"><span>Total</span><span id="checkout-Total">${money(total)}</span></div>
        <button class="primary" id="checkout-PlaceOrder" type="button" style="width:100%;margin-top:12px">Place order</button>
      </aside>
    </div>`,
    ORDER_SCRIPT,
  )
}

export function orderPage(context: PageContext, orderId: number, lines: readonly ShopLine[]): string {
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0)
  return layout(
    `Order ${orderId} | ${STORE_NAME}`,
    context,
    `    <section class="panel order-done">
      <div class="tick">✅</div>
      <h1 id="order-Confirmed">Thanks${context.shopper === null ? '' : `, ${escapeHtml(context.shopper)}`}! Your order is placed.</h1>
      <p>Order number</p>
      <p class="order-number" id="order-Number">${orderId}</p>
      <p>Pick up today, 5:00 pm – 6:00 pm at ${STORE_NAME} Surry Hills. Total ${money(total)}.</p>
    </section>
    <section class="panel" style="margin-top:18px">
${linesHtml(lines)}
    </section>`,
  )
}

export function notFoundPage(context: PageContext): string {
  return layout(`Page not found | ${STORE_NAME}`, context, '    <h1>Sorry, we can’t find that page</h1>')
}

/**
 * Demo only (`demoPhone`): the test account's phone, showing the texts the fake "sent", so a person
 * watching a demo can sign in on the shop's own pages. Never served unless asked for.
 */
export function phonePage(messages: readonly { readonly text: string; readonly at: number }[]): string {
  const bubbles = [...messages]
    .reverse()
    .map(
      (m) =>
        `<div class="sms"><div class="from">${escapeHtml(STORE_NAME)}</div>${escapeHtml(rebrandText(m.text, STORE_NAME))}<div class="at">${new Date(m.at).toLocaleTimeString('en-AU')}</div></div>`,
    )
    .join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Test phone</title><meta http-equiv="refresh" content="3">
<style>${BASE_CSS}
body{background:#20262a;display:flex;justify-content:center;padding:30px}
.phone{width:340px;min-height:560px;background:#fff;border-radius:36px;padding:26px 18px;border:10px solid #000}
h1{font-size:17px;text-align:center;margin:0 0 16px}
.sms{background:#e9e9eb;border-radius:18px;padding:10px 14px;margin:10px 0;font-size:15px}
.from{font-weight:700;font-size:12px;color:var(--muted)}.at{font-size:11px;color:var(--muted);text-align:right}
</style></head>
<body><div class="phone"><h1>📱 Messages (test phone)</h1>${bubbles === '' ? '<p class="empty">No messages yet.</p>' : bubbles}</div></body></html>
`
}
