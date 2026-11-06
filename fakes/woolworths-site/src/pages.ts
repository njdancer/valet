// Server-rendered www pages. The real site is a single-page app, but a browser driver only cares
// about the DOM it ends up with. Signing in happens on the auth origin (auth-pages.ts); www has
// only the "not logged in" page that links there, and a header search box that must never receive
// a secret.

import { sensorScript } from './akamai'
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
}

function layout(title: string, context: PageContext, main: string): string {
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
</head>
<body>
  <header class="header">
    <a class="header-logo" href="/">Woolworths</a>
    <form id="headerSearch" class="header-search" role="search" action="/shop/search/products" method="get">
      <input id="headerSearch-Input" type="search" name="searchTerm" placeholder="Search products, recipes &amp; ideas" aria-label="Search products" autocomplete="off">
      <button id="headerSearch-Submit" type="submit">Search</button>
    </form>
    <nav class="header-account">
      ${account}
    </nav>
  </header>
  <main>
${main}
  </main>
</body>
</html>
`
}

export function homePage(context: PageContext): string {
  return layout(
    'Woolworths Supermarket - Buy Groceries Online',
    context,
    `    <h1>Woolworths Supermarket</h1>
    <p class="home-intro">Shop groceries online.</p>`,
  )
}

/** www.woolworths.com.au/shop/securelogin, as seen live: no form, only a link that starts the login. */
export function notLoggedInPage(context: PageContext, loginHref: string): string {
  return layout(
    'Log in | Woolworths',
    context,
    `    <h1>Oops! You're not logged in</h1>
    <a id="securelogin-Login" class="button" href="${escapeHtml(loginHref)}">Login</a>`,
  )
}

/** What www's callback shows when the state or code doesn't match a pending login. */
export function loginFailedPage(context: PageContext): string {
  return layout(
    'Log in | Woolworths',
    context,
    `    <h1 id="login-Failed">Sorry, we couldn't log you in</h1>
    <p>Please try again.</p>`,
  )
}

export function myAccountPage(context: PageContext): string {
  return layout(
    'My Account | Woolworths',
    context,
    `    <h1 id="myaccount-Greeting">Hi ${escapeHtml(context.shopper ?? '')}</h1>
    <p>Welcome to your account.</p>`,
  )
}

export function searchPage(context: PageContext, term: string, products: readonly Product[]): string {
  const tiles = products
    .map(
      (product) => `      <article class="product-tile" data-stockcode="${product.Stockcode}">
        <h3 class="product-title">${escapeHtml(product.DisplayName)}</h3>
        <span class="product-price">${money(product.Price)}</span>
        <span class="product-cup">${escapeHtml(product.CupString)}</span>${
          product.IsOnSpecial
            ? `\n        <span class="product-special">Save ${money(product.WasPrice - product.Price)}</span>`
            : ''
        }${product.IsAvailable ? '' : '\n        <span class="product-unavailable">Unavailable</span>'}
      </article>`,
    )
    .join('\n')
  return layout(
    `${term} | Woolworths`,
    context,
    `    <h1 class="search-heading">Results for “${escapeHtml(term)}”</h1>
    <p class="search-count">${products.length} products</p>
    <section class="product-grid">
${tiles}
    </section>`,
  )
}

export function notFoundPage(context: PageContext): string {
  return layout('Page not found | Woolworths', context, '    <h1>Sorry, we can’t find that page</h1>')
}
