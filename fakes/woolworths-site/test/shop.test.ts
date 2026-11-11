// The shop a person sees: the made-up brand, trolley, checkout and order pages, the demo's test
// phone, and the house-brand swap in API answers.

import { afterEach, describe, expect, it } from 'vitest'
import { rebrandJson, STORE_NAME } from '../src/brand'
import { type FakeWoolworths, type FakeWoolworthsOptions, startFakeWoolworths } from '../src/server'
import { Client, type Reply } from './support/client'

const PLAIN = { username: 'plain@example.test', password: 'plain-password', firstName: 'Pat' }
const SMS = { username: 'sms@example.test', password: 'sms-password', otpCode: '135790', mfa: 'sms' as const }

const sites: FakeWoolworths[] = []
afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()))
})

async function start(options: FakeWoolworthsOptions = {}): Promise<FakeWoolworths> {
  const site = await startFakeWoolworths({ accounts: [PLAIN, SMS], ...options })
  sites.push(site)
  return site
}

function location(reply: Reply): string {
  const value = reply.headers.get('location')
  if (value === null) throw new Error(`expected a redirect, got ${reply.status}`)
  return value
}

/** A browser on www that has logged in as PLAIN (no MFA), back on www. */
async function loggedIn(site: FakeWoolworths): Promise<Client> {
  const www = new Client(site.origin)
  await www.visit('/')
  const auth = new Client(site.authOrigin)
  const authorize = location(await www.get(`/auth/login?redirect_uri=${site.origin}/auth/callback&path=/`))
  const identifier = location(await auth.get(authorize))
  const state = new URL(identifier, 'https://x.invalid').searchParams.get('state') ?? ''
  const toPassword = await auth.postForm(identifier, { state, username: PLAIN.username, action: 'default' })
  const callback = location(
    await auth.postForm(location(toPassword), { state, password: PLAIN.password, action: 'default' }),
  )
  await www.get(callback)
  return www
}

async function add(client: Client, stockcode: number, quantity: number): Promise<void> {
  const reply = await client.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode, quantity }] })
  expect(reply.status).toBe(200)
}

describe('the shop', () => {
  it('shows its own brand and specials, with a trolley count in the header', async () => {
    const site = await start()
    const client = new Client(site.origin)
    const home = await client.visit('/')
    expect(home.text).toContain(STORE_NAME)
    expect(home.text).toContain('<h2>Specials</h2>')
    expect(home.text).toContain('<span class="count">0</span>')
    await add(client, 88436, 2)
    expect((await client.get('/')).text).toContain('<span class="count">2</span>')
    const search = await client.get('/shop/search/products?searchTerm=milk')
    expect(search.text).toContain('2 in trolley')
    expect(search.text).toContain('data-stockcode="88436" data-quantity="2"')
  })

  it('lists the trolley, holds checkout until the minimum spend, and offers it after', async () => {
    const site = await start()
    const client = new Client(site.origin)
    await client.visit('/')
    expect((await client.get('/shop/cart')).text).toContain('Your trolley is empty.')
    await add(client, 88436, 1)
    const short = await client.get('/shop/cart')
    expect(short.text).toContain('Dairy Farmers Full Cream Milk 2L')
    expect(short.text).toContain('Add $45.80 more to check out.')
    expect(short.text).not.toContain('id="trolley-Checkout"')
    await add(client, 900604, 2)
    const enough = await client.get('/shop/cart')
    expect(enough.text).toContain('id="trolley-Checkout"')
    expect(enough.text).toContain('<span id="trolley-Total">$74.20</span>')
  })

  it('asks an anonymous visitor to log in before checkout, back to checkout after', async () => {
    const site = await start()
    const client = new Client(site.origin)
    await client.visit('/')
    const reply = await client.get('/shop/checkout')
    expect(reply.text).toContain("Oops! You're not logged in")
    expect(reply.text).toContain('path=/shop/checkout')
  })

  it('places an order from checkout, empties the trolley, and shows the order to its shopper only', async () => {
    const site = await start()
    const www = await loggedIn(site)
    await add(www, 900604, 2)
    const checkout = await www.get('/shop/checkout')
    expect(checkout.text).toContain('id="checkout-PlaceOrder"')
    expect(checkout.text).toContain('<span id="checkout-Total">$70.00</span>')
    const placed = await www.postJson('/api/v3/ui/checkout/order', {})
    const { OrderId } = JSON.parse(placed.text) as { OrderId: number }
    expect(site.trolleyFor(PLAIN.username)).toEqual([])
    const order = await www.get(`/shop/order/${OrderId}`)
    expect(order.status).toBe(200)
    expect(order.text).toContain('Thanks, Pat! Your order is placed.')
    expect(order.text).toContain('Lavazza Qualita Oro Coffee Beans 1kg')
    const stranger = new Client(site.origin)
    await stranger.visit('/')
    expect((await stranger.get(`/shop/order/${OrderId}`)).status).toBe(404)
    expect((await www.get('/shop/order/1')).status).toBe(404)
  })

  it('checks out at the store another session of the account chose, branded with the shop', async () => {
    const site = await start({ houseBrand: 'Gumleaf' })
    // Valet's tool session chooses the store; the person checks out in their own browser.
    const tools = await loggedIn(site)
    const stores = await tools.get('/api/v3/ui/fulfilment/stores?postcode=2000')
    expect(stores.text).toContain('Gumleaf Grocer Town Hall')
    expect(stores.text).not.toMatch(/\bWoolworths\b/)
    expect(
      (await tools.postJson('/api/v3/ui/fulfilment', { addressId: 9001201, fulfilmentMethod: 'Pickup' }))
        .status,
    ).toBe(200)
    const browser = await loggedIn(site)
    await add(browser, 900604, 2)
    const checkout = await browser.get('/shop/checkout')
    expect(checkout.text).toContain('Gumleaf Grocer Town Hall')
    expect(checkout.text).toContain('Cnr Park &amp; George Streets, Sydney NSW')
    const placed = await browser.postJson('/api/v3/ui/checkout/order', {})
    const { OrderId } = JSON.parse(placed.text) as { OrderId: number }
    expect((await browser.get(`/shop/order/${OrderId}`)).text).toContain('at Gumleaf Grocer Town Hall.')
  })

  it('shows the shop’s default store when no session chose one', async () => {
    const site = await start()
    const www = await loggedIn(site)
    await add(www, 900604, 2)
    expect((await www.get('/shop/checkout')).text).toContain(`${STORE_NAME} Surry Hills`)
  })

  it('serves the test phone only when asked for, with the codes the fake sent by SMS', async () => {
    const off = await start()
    expect((await new Client(off.origin).get('/_demo/phone')).status).toBe(404)
    const site = await start({ demoPhone: true })
    const phone = new Client(site.origin)
    expect((await phone.get('/_demo/phone')).text).toContain('No messages yet.')
    const www = new Client(site.origin)
    await www.visit('/')
    const auth = new Client(site.authOrigin)
    const authorize = location(await www.get(`/auth/login?redirect_uri=${site.origin}/auth/callback&path=/`))
    const identifier = location(await auth.get(authorize))
    const state = new URL(identifier, 'https://x.invalid').searchParams.get('state') ?? ''
    const toPassword = await auth.postForm(identifier, { state, username: SMS.username, action: 'default' })
    await auth.postForm(location(toPassword), { state, password: SMS.password, action: 'default' })
    const text = (await phone.get('/_demo/phone')).text
    expect(text).toContain('Your Gumleaf Grocer verification code is 135790.')
  })

  it('swaps the captured house brand in API answers only when told to', async () => {
    const plain = await start()
    const client = new Client(plain.origin)
    await client.visit('/')
    expect((await client.get('/apis/ui/product/detail/888137')).text).toContain(
      'Woolworths Full Cream Milk 2L',
    )
    const branded = await start({ houseBrand: 'Gumleaf' })
    const other = new Client(branded.origin)
    await other.visit('/')
    const text = (await other.get('/apis/ui/product/detail/888137')).text
    expect(text).toContain('Gumleaf Full Cream Milk 2L')
    expect(text).not.toMatch(/\bWoolworths\b/)
    // Keys and lower-case host names are left as they are.
    expect(
      rebrandJson({ WoolworthsTotal: 'Woolworths', url: 'https://cdn0.woolworths.media/x' }, 'G'),
    ).toEqual({
      WoolworthsTotal: 'G',
      url: 'https://cdn0.woolworths.media/x',
    })
  })
})
