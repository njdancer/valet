import { describe, expect, it } from 'vitest'
import { findProduct } from '../src/catalogue'
import type { Product } from '../src/fixtures'
import { escapeHtml, homePage, loginPage, myAccountPage, searchPage, verifyPage } from '../src/pages'

const anonymous = { sensorValue: 'SENSOR~0~-1~-1', shopper: null }
const loggedIn = { sensorValue: 'SENSOR~0~-1~-1', shopper: 'Sam' }

describe('escapeHtml', () => {
  it('escapes every markup character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })
})

describe('layout', () => {
  it('carries the sensor script and the decoy header search box on every page', () => {
    for (const html of [homePage(anonymous), loginPage(anonymous, null), verifyPage(anonymous, null)]) {
      expect(html).toContain('_abck=SENSOR~0~-1~-1')
      expect(html).toContain('<input id="headerSearch-Input" type="search" name="searchTerm"')
      expect(html).toContain('action="/shop/search/products" method="get"')
    }
  })

  it('links to log in when anonymous and greets the shopper when logged in', () => {
    expect(homePage(anonymous)).toContain('id="header-Login"')
    expect(homePage(loggedIn)).toContain('<a id="header-Account" href="/shop/myaccount">Hi Sam</a>')
    expect(homePage(loggedIn)).not.toContain('id="header-Login"')
  })

  it('escapes the shopper name', () => {
    expect(homePage({ ...anonymous, shopper: '<b>' })).toContain('Hi &lt;b&gt;')
  })
})

describe('loginPage', () => {
  it('has the login form the auth flow fills', () => {
    const html = loginPage(anonymous, null)
    expect(html).toContain('<form id="loginForm" method="post" action="/auth/login">')
    expect(html).toContain(
      '<input id="loginForm-Email" name="email" type="email" autocomplete="username" required>',
    )
    expect(html).toContain(
      '<input id="loginForm-Password" name="password" type="password" autocomplete="current-password" required>',
    )
    expect(html).toContain('<button id="loginForm-Submit" type="submit">')
    expect(html).not.toContain('login-error')
  })

  it('shows an error when given one', () => {
    expect(loginPage(anonymous, 'Nope & no')).toContain(
      '<p class="login-error" role="alert">Nope &amp; no</p>',
    )
  })
})

describe('verifyPage', () => {
  it('has a one-time-code input and a remember-device checkbox in a form posting to /auth/verify', () => {
    const html = verifyPage(anonymous, null)
    expect(html).toContain('<form id="verifyForm" method="post" action="/auth/verify">')
    expect(html).toMatch(/<input id="verify-Code"[^>]* inputmode="numeric" autocomplete="one-time-code"/)
    expect(html).toContain(
      '<input id="verify-RememberDevice" name="rememberDevice" type="checkbox" value="true">',
    )
    expect(html).toContain('<button id="verify-Submit" type="submit">')
  })

  it('shows an error when given one', () => {
    expect(verifyPage(anonymous, 'Wrong code')).toContain(
      '<p class="login-error" role="alert">Wrong code</p>',
    )
  })
})

describe('myAccountPage', () => {
  it('greets the shopper', () => {
    expect(myAccountPage(loggedIn)).toContain('<h1 id="myaccount-Greeting">Hi Sam</h1>')
  })
})

describe('searchPage', () => {
  const products = [findProduct(88436), findProduct(888137), findProduct(900303)] as Product[]

  it('renders a tile per product with stockcode, price and cup price', () => {
    const html = searchPage(anonymous, 'milk', products)
    expect(html).toContain('<article class="product-tile" data-stockcode="88436">')
    expect(html).toContain('<span class="product-price">$4.20</span>')
    expect(html).toContain('<span class="product-cup">$2.10 / 1L</span>')
    expect(html).toContain('<p class="search-count">3 products</p>')
  })

  it('flags specials and unavailable products', () => {
    const html = searchPage(anonymous, 'milk', products)
    expect(html.match(/product-special/g)).toHaveLength(1)
    expect(html).toContain('<span class="product-special">Save $0.50</span>')
    expect(html.match(/product-unavailable/g)).toHaveLength(1)
  })

  it('escapes the search term in the heading and title', () => {
    const html = searchPage(anonymous, '<img src=x>', [])
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('Results for “&lt;img src=x&gt;”')
    expect(html).toContain('<title>&lt;img src=x&gt; | Woolworths</title>')
  })
})
