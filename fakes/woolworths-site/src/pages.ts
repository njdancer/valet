// Server-rendered HTML pages. The real site is a single-page app, but the auth interpreter only
// cares about the DOM it ends up with: a login form, a one-time-code form, and a header search box
// that must never receive a secret. Element ids are what auth-flow tests select on.

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
  ${sensorScript(context.sensorValue)}
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

export function loginPage(context: PageContext, error: string | null, action = '/auth/login'): string {
  const alert = error === null ? '' : `    <p class="login-error" role="alert">${escapeHtml(error)}</p>\n`
  return layout(
    'Log in | Woolworths',
    context,
    `    <h1>Log in or sign up</h1>
${alert}    <form id="loginForm" method="post" action="${escapeHtml(action)}">
      <label for="loginForm-Email">Email address</label>
      <input id="loginForm-Email" name="email" type="email" autocomplete="username" required>
      <label for="loginForm-Password">Password</label>
      <input id="loginForm-Password" name="password" type="password" autocomplete="current-password" required>
      <button id="loginForm-Submit" type="submit">Log in</button>
    </form>
    <a class="login-forgot" href="/shop/securelogin/forgotpassword">Forgot your password?</a>`,
  )
}

export function verifyPage(context: PageContext, error: string | null): string {
  const alert = error === null ? '' : `    <p class="login-error" role="alert">${escapeHtml(error)}</p>\n`
  return layout(
    'Verify it’s you | Woolworths',
    context,
    `    <h1>Verify it’s you</h1>
    <p>We sent a 6-digit code to your mobile.</p>
${alert}    <form id="verifyForm" method="post" action="/auth/verify">
      <label for="verify-Code">Verification code</label>
      <input id="verify-Code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
      <label><input id="verify-RememberDevice" name="rememberDevice" type="checkbox" value="true"> Remember this device</label>
      <button id="verify-Submit" type="submit">Verify</button>
    </form>`,
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
