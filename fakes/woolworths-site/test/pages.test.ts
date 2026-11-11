import { describe, expect, it } from 'vitest'
import { findProduct } from '../src/catalogue'
import type { Product } from '../src/fixtures'
import {
  escapeHtml,
  homePage,
  loginFailedPage,
  myAccountPage,
  notLoggedInPage,
  searchPage,
} from '../src/pages'

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
    for (const html of [
      homePage(anonymous),
      notLoggedInPage(anonymous, '/auth/login'),
      loginFailedPage(anonymous),
    ]) {
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

describe('notLoggedInPage', () => {
  it('has no form, only a link that starts the login, as on the live site', () => {
    const html = notLoggedInPage(
      anonymous,
      '/auth/login?redirect_uri=https://www.woolworths.test/auth/callback&path=/',
    )
    expect(html).toContain("<h1>Oops! You're not logged in</h1>")
    expect(html).toContain(
      '<a id="securelogin-Login" class="button" href="/auth/login?redirect_uri=https://www.woolworths.test/auth/callback&amp;path=/">Login</a>',
    )
    expect(html).not.toContain('type="password"')
    expect(html.match(/<form/g)).toHaveLength(1) // the header search box only
  })
})

describe('loginFailedPage', () => {
  it('says the login failed, without any detail', () => {
    expect(loginFailedPage(anonymous)).toContain('<h1 id="login-Failed">')
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
    expect(html.match(/class="product-special"/g)).toHaveLength(1)
    expect(html).toContain('<span class="product-special">Save $0.50</span>')
    expect(html.match(/class="product-unavailable"/g)).toHaveLength(1)
  })

  it('escapes the search term in the heading and title', () => {
    const html = searchPage(anonymous, '<img src=x>', [])
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('Results for “&lt;img src=x&gt;”')
    expect(html).toContain('<title>&lt;img src=x&gt; | Gumleaf Grocer</title>')
  })
})
