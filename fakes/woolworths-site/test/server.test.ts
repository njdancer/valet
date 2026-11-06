import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeWoolworths, startFakeWoolworths } from '../src/server'
import { Client, sensorValueIn } from './support/client'

const sites: FakeWoolworths[] = []
afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()))
})

async function start(options: Parameters<typeof startFakeWoolworths>[0] = {}): Promise<FakeWoolworths> {
  const site = await startFakeWoolworths(options)
  sites.push(site)
  return site
}

/** A client that has loaded the homepage, so it holds the sensor cookie like a real browser would. */
async function browsing(site: FakeWoolworths): Promise<Client> {
  const client = new Client(site.origin)
  await client.visit('/')
  return client
}

type Group = { Products: { Stockcode: number }[] }

describe('startFakeWoolworths', () => {
  it('serves plain HTTP on a free port and reports 127.0.0.1 by default', async () => {
    const site = await start()
    expect(site.port).toBeGreaterThan(0)
    expect(site.origin).toBe(`http://127.0.0.1:${site.port}`)
    expect((await fetch(`${site.origin}/`)).status).toBe(200)
  })

  it('reports the hostname it is given, still listening on 127.0.0.1', async () => {
    const site = await start({ hostname: 'www.woolworths.test' })
    expect(site.origin).toBe(`http://www.woolworths.test:${site.port}`)
    expect((await fetch(`http://127.0.0.1:${site.port}/`)).status).toBe(200)
  })

  it('stops accepting connections once closed, and closing twice is harmless', async () => {
    const site = await startFakeWoolworths()
    await site.close()
    await site.close()
    await expect(fetch(`${site.origin}/`)).rejects.toThrow()
  })

  it('fails to start on a port that is taken', async () => {
    const site = await start()
    await expect(startFakeWoolworths({ port: site.port })).rejects.toThrow()
  })

  it('refuses two accounts with the same username', async () => {
    const accounts = [
      { username: 'a@example.test', password: 'one' },
      { username: 'a@example.test', password: 'two' },
    ]
    await expect(startFakeWoolworths({ accounts })).rejects.toThrow('duplicate fake account')
  })
})

describe('the homepage', () => {
  it('runs a sensor script that sets a non-httpOnly _abck from page script', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/')
    expect(reply.status).toBe(200)
    expect(reply.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(sensorValueIn(reply.text)).toMatch(/^[0-9A-F]{48}~0~-1~-1$/)
    // The server never sets _abck itself, so it can't be httpOnly.
    expect(reply.setCookies.some((line) => line.startsWith('_abck='))).toBe(false)
  })

  it('gives every new visitor an httpOnly wow-auth-token, as the live site does for anonymous visitors', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/')
    expect(reply.setCookies).toHaveLength(1)
    expect(reply.setCookies[0]).toMatch(/^wow-auth-token=[\w-]+; Path=\/; SameSite=Lax; HttpOnly$/)
  })

  it('does not reissue the token to a returning visitor', async () => {
    const site = await start()
    const client = await browsing(site)
    expect((await client.get('/')).setCookies).toEqual([])
  })

  it('issues a fresh token for an unknown one', async () => {
    const site = await start()
    const client = new Client(site.origin)
    client.cookies.set('wow-auth-token', 'made-up')
    const reply = await client.get('/')
    expect(reply.setCookies).toHaveLength(1)
    expect(client.cookies.get('wow-auth-token')).not.toBe('made-up')
  })
})

describe('bot protection', () => {
  it('denies an API request with no sensor cookie with the Akamai page', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/apis/ui/Trolley')
    expect(reply.status).toBe(403)
    expect(reply.headers.get('server')).toBe('AkamaiGHost')
    expect(reply.headers.get('content-type')).toBe('text/html')
    expect(reply.text).toMatch(/^<HTML><HEAD>\n<TITLE>Access Denied<\/TITLE>/)
    expect(reply.text).toContain('&#47;apis&#47;ui&#47;Trolley')
    expect(reply.setCookies).toEqual([])
  })

  it('denies every /api and /apis path without the sensor cookie', async () => {
    const site = await start()
    const client = new Client(site.origin)
    for (const path of ['/api/ui/v2/bootstrap', '/apis/ui/Search/products?searchTerm=milk', '/api/nothing']) {
      expect((await client.get(path)).status).toBe(403)
    }
    expect((await client.postJson('/api/v3/ui/trolley/update', { items: [] })).status).toBe(403)
  })

  it('denies a forged sensor cookie the site never issued', async () => {
    const site = await start()
    const client = new Client(site.origin)
    client.cookies.set('_abck', 'A'.repeat(48).concat('~0~-1~-1'))
    expect((await client.get('/apis/ui/Trolley')).status).toBe(403)
  })

  it('allows API requests once the sensor cookie is set', async () => {
    const site = await start()
    const client = await browsing(site)
    expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
  })

  it('accepts a sensor cookie issued by any page, not just the homepage', async () => {
    const site = await start()
    const client = new Client(site.origin)
    await client.visit('/shop/securelogin')
    expect((await client.get('/api/ui/v2/bootstrap')).status).toBe(200)
  })

  it('accepts the sensor cookie from another client, as when cookies are copied between partitions', async () => {
    const site = await start()
    const auth = await browsing(site)
    const tool = new Client(site.origin)
    for (const [name, value] of auth.cookies) tool.cookies.set(name, value)
    expect((await tool.get('/apis/ui/Trolley')).status).toBe(200)
  })

  it('does not gate pages on the sensor cookie', async () => {
    const site = await start()
    const client = new Client(site.origin)
    expect((await client.get('/shop/securelogin')).status).toBe(200)
  })
})

describe('the rate limit', () => {
  const rateLimit = { maxRequests: 3, windowMs: 10_000, cooldownMs: 60_000 }

  it('blocks a session that makes more API requests than allowed, pages included', async () => {
    let now = 0
    const site = await start({ rateLimit, now: () => now })
    const client = await browsing(site)
    for (let i = 0; i < 3; i++) {
      now += 1000
      expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
    }
    now += 1000
    const blocked = await client.get('/apis/ui/Trolley')
    expect(blocked.status).toBe(403)
    expect(blocked.text).toContain('<H1>Access Denied</H1>')
    expect((await client.get('/')).status).toBe(403)
    expect((await client.get('/shop/securelogin')).status).toBe(403)
  })

  it('does not count page loads', async () => {
    const site = await start({ rateLimit, now: () => 0 })
    const client = await browsing(site)
    for (let i = 0; i < 10; i++) await client.get('/')
    expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
  })

  it('leaves other sessions alone', async () => {
    const site = await start({ rateLimit, now: () => 0 })
    const greedy = await browsing(site)
    const polite = await browsing(site)
    for (let i = 0; i < 4; i++) await greedy.get('/apis/ui/Trolley')
    expect((await greedy.get('/apis/ui/Trolley')).status).toBe(403)
    expect((await polite.get('/apis/ui/Trolley')).status).toBe(200)
  })

  it('lifts the block after the cool-down', async () => {
    let now = 0
    const site = await start({ rateLimit, now: () => now })
    const client = await browsing(site)
    for (let i = 0; i < 4; i++) await client.get('/apis/ui/Trolley')
    now = 59_999
    expect((await client.get('/apis/ui/Trolley')).status).toBe(403)
    now = 60_000
    expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
  })

  it('cannot be escaped by fetching a new sensor cookie while blocked', async () => {
    const site = await start({ rateLimit, now: () => 0 })
    const client = await browsing(site)
    for (let i = 0; i < 4; i++) await client.get('/apis/ui/Trolley')
    const home = await client.visit('/')
    expect(home.status).toBe(403)
    expect(sensorValueIn(home.text)).toBeNull()
  })

  it('can be changed or turned off while running', async () => {
    const site = await start({ now: () => 0 })
    const client = await browsing(site)
    site.setRateLimit({ maxRequests: 1, windowMs: 1000, cooldownMs: 1000 })
    expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
    expect((await client.get('/apis/ui/Trolley')).status).toBe(403)
    site.setRateLimit(null)
    for (let i = 0; i < 5; i++) expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
  })
})

describe('blockAll', () => {
  it('denies every request until switched off', async () => {
    const site = await start()
    const client = await browsing(site)
    site.blockAll(true)
    expect((await client.get('/')).status).toBe(403)
    expect((await client.get('/apis/ui/Trolley')).status).toBe(403)
    expect((await client.postForm('/auth/login', { email: 'x', password: 'y' })).status).toBe(403)
    site.blockAll(false)
    expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
  })
})

describe('GET /api/ui/v2/bootstrap', () => {
  it('reports an anonymous shopper as logged out', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.get('/api/ui/v2/bootstrap')
    expect(reply.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(JSON.parse(reply.text)).toEqual({ ShopperDetails: { IsLoggedIn: false, FirstName: null } })
  })
})

describe('search', () => {
  it('answers the POST body the site sends with the real response shape', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.postJson('/apis/ui/Search/products', {
      SearchTerm: 'coffee',
      PageSize: 2,
      PageNumber: 1,
      SortType: 'PriceAsc',
      IsSpecial: false,
    })
    expect(reply.status).toBe(200)
    const body = JSON.parse(reply.text)
    expect(body.SearchResultsCount).toBe(4)
    expect((body.Products as Group[]).map((g) => g.Products[0]?.Stockcode)).toEqual([900603, 900601])
    expect(body).toHaveProperty('Aggregations')
    expect(body).toHaveProperty('Corrections', null)
    expect(body).toHaveProperty('SuggestedTerm', null)
  })

  it('answers the GET form with the same shape', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.get('/apis/ui/Search/products?searchTerm=coffee&pageSize=2&sortType=PriceAsc')
    const body = JSON.parse(reply.text)
    expect(body.SearchResultsCount).toBe(4)
    expect((body.Products as Group[]).map((g) => g.Products[0]?.Stockcode)).toEqual([900603, 900601])
  })

  it('filters to specials', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.postJson('/apis/ui/Search/products', { SearchTerm: 'coffee', IsSpecial: true })
    expect((JSON.parse(reply.text).Products as Group[]).map((g) => g.Products[0]?.Stockcode)).toEqual([
      900601, 900604,
    ])
  })

  it('treats the path case-insensitively, like the real site', async () => {
    const site = await start()
    const client = await browsing(site)
    expect((await client.get('/APIS/UI/search/PRODUCTS?searchTerm=milk')).status).toBe(200)
  })

  it('rejects malformed JSON and bodies without SearchTerm', async () => {
    const site = await start()
    const client = await browsing(site)
    const malformed = await client.request('POST', '/apis/ui/Search/products', { raw: '{"SearchTerm":' })
    expect(malformed.status).toBe(400)
    expect(JSON.parse(malformed.text)).toEqual({ Message: 'The request is invalid.' })
    expect((await client.postJson('/apis/ui/Search/products', { term: 'milk' })).status).toBe(400)
    expect((await client.get('/apis/ui/Search/products')).status).toBe(400)
  })

  it('renders an HTML search page for the header search box', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/shop/search/products?searchTerm=tim+tam')
    expect(reply.status).toBe(200)
    expect(reply.text).toContain('<article class="product-tile" data-stockcode="900801">')
    expect(reply.text).toContain('Results for “tim tam”')
  })

  it('renders an empty HTML search page with no term', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/shop/search/products')
    expect(reply.text).toContain('<p class="search-count">0 products</p>')
  })
})

describe('GET /apis/ui/product/detail/:stockcode', () => {
  it('returns the detail envelope for a product', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.get('/apis/ui/product/detail/88436')
    expect(reply.status).toBe(200)
    const body = JSON.parse(reply.text)
    expect(body.Product.Stockcode).toBe(88436)
    expect(body.PrimaryCategory).toMatchObject({ Department: 'dairy', Aisle: 'full cream milk' })
    expect(Object.keys(body)).toContain('Nutrition')
  })

  it('returns 404 with an empty envelope for an unknown or malformed stockcode', async () => {
    const site = await start()
    const client = await browsing(site)
    for (const code of ['1', 'abc', '88436x', '1234567890123']) {
      const reply = await client.get(`/apis/ui/product/detail/${code}`)
      expect(reply.status).toBe(404)
      expect(JSON.parse(reply.text).Product).toBeNull()
    }
  })
})

describe('the trolley', () => {
  it('starts empty for an anonymous visitor, in the captured shape', async () => {
    const site = await start()
    const client = await browsing(site)
    const body = JSON.parse((await client.get('/apis/ui/Trolley')).text)
    expect(body).toMatchObject({ AvailableItems: [], UnavailableItems: [], TrolleyItemCount: 0 })
    expect(body.Errors[0].Type).toBe('InvalidSubtotal')
  })

  it('updates and returns the updated trolley', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.postJson('/api/v3/ui/trolley/update', {
      items: [
        { stockcode: 88436, quantity: 2 },
        { stockcode: 900303, quantity: 1 },
      ],
    })
    expect(reply.status).toBe(200)
    const body = JSON.parse(reply.text)
    expect(body.AvailableItems.map((i: { Stockcode: number }) => i.Stockcode)).toEqual([88436])
    expect(body.UnavailableItems.map((i: { Stockcode: number }) => i.Stockcode)).toEqual([900303])
    expect(body.TotalTrolleyItemQuantity).toBe(3)
    const again = JSON.parse((await client.get('/apis/ui/Trolley')).text)
    expect(again.Totals.SubTotal).toBe(8.4)
  })

  it('removes an item set to quantity 0', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 88436, quantity: 2 }] })
    const reply = await client.postJson('/api/v3/ui/trolley/update', {
      items: [{ stockcode: 88436, quantity: 0 }],
    })
    expect(JSON.parse(reply.text).AvailableItems).toEqual([])
  })

  it('keeps each anonymous visitor in their own trolley', async () => {
    const site = await start()
    const first = await browsing(site)
    const second = await browsing(site)
    await first.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 88436, quantity: 1 }] })
    expect(JSON.parse((await second.get('/apis/ui/Trolley')).text).TrolleyItemCount).toBe(0)
    expect(JSON.parse((await first.get('/apis/ui/Trolley')).text).TrolleyItemCount).toBe(1)
  })

  it('rejects an invalid update without changing the trolley', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 88436, quantity: 1 }] })
    const bad = await client.postJson('/api/v3/ui/trolley/update', {
      items: [
        { stockcode: 88436, quantity: 9 },
        { stockcode: 999, quantity: 1 },
      ],
    })
    expect(bad.status).toBe(400)
    expect(JSON.parse((await client.get('/apis/ui/Trolley')).text).TotalTrolleyItemQuantity).toBe(1)
    expect((await client.request('POST', '/api/v3/ui/trolley/update', { raw: 'not json' })).status).toBe(400)
  })

  it('shows trolley quantities in search results', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 900801, quantity: 3 }] })
    const body = JSON.parse((await client.get('/apis/ui/Search/products?searchTerm=tim+tam')).text)
    expect(body.Products[0].Products[0]).toMatchObject({ QuantityInTrolley: 3, IsInTrolley: true })
  })
})

describe('POST /api/v3/ui/checkout/order', () => {
  it('exists, places an order and empties the trolley, so a test can see if anything reached it', async () => {
    const site = await start()
    const client = await browsing(site)
    await client.postJson('/api/v3/ui/trolley/update', { items: [{ stockcode: 88436, quantity: 1 }] })
    const first = await client.postJson('/api/v3/ui/checkout/order', {})
    expect(first.status).toBe(200)
    expect(JSON.parse(first.text)).toEqual({ OrderId: 100000001 })
    expect(JSON.parse((await client.postJson('/api/v3/ui/checkout/order', {})).text)).toEqual({
      OrderId: 100000002,
    })
    expect(JSON.parse((await client.get('/apis/ui/Trolley')).text).TrolleyItemCount).toBe(0)
  })
})

describe('unknown paths', () => {
  it('answer API paths with a JSON 404', async () => {
    const site = await start()
    const client = await browsing(site)
    const reply = await client.get('/apis/ui/nothing-here')
    expect(reply.status).toBe(404)
    expect(JSON.parse(reply.text)).toEqual({
      Message: 'No HTTP resource was found that matches the request URI.',
    })
    expect((await client.request('DELETE', '/apis/ui/Trolley')).status).toBe(404)
  })

  it('answer pages with an HTML 404 that still carries the sensor script', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/shop/nowhere')
    expect(reply.status).toBe(404)
    expect(sensorValueIn(reply.text)).not.toBeNull()
  })
})

describe('request recording', () => {
  it('records every request with method, host, path, query, headers, body and time', async () => {
    let now = 1_000
    const site = await start({ now: () => now })
    const client = await browsing(site)
    now = 2_000
    await client.postJson('/apis/ui/Search/products?debug=1', { SearchTerm: 'milk' })
    expect(site.requests).toHaveLength(2)
    expect(site.requests[0]).toMatchObject({ method: 'GET', path: '/', at: 1_000 })
    expect(site.requests[1]).toMatchObject({
      method: 'POST',
      host: '127.0.0.1',
      path: '/apis/ui/Search/products',
      query: { debug: '1' },
      body: '{"SearchTerm":"milk"}',
      at: 2_000,
    })
    expect(site.requests[1]?.headers['content-type']).toBe('application/json')
    expect(site.requests[1]?.headers['cookie']).toContain('_abck=')
  })

  it('records denied requests too', async () => {
    const site = await start()
    await new Client(site.origin).postJson('/api/v3/ui/checkout/order', { secret: 'canary-123' })
    expect(site.requests).toHaveLength(1)
    expect(site.requests[0]).toMatchObject({
      path: '/api/v3/ui/checkout/order',
      body: '{"secret":"canary-123"}',
    })
  })

  it('records the Host header the client sent, as when e2e maps www.woolworths.test to 127.0.0.1', async () => {
    const site = await start({ hostname: 'www.woolworths.test' })
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: site.port,
          path: '/',
          headers: { host: `www.woolworths.test:${site.port}` },
        },
        (res) => {
          res.resume()
          res.on('end', resolve)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(site.requests[0]?.host).toBe('www.woolworths.test')
  })

  it('refuses a body over the size limit but still records the request', async () => {
    const site = await start()
    const reply = await new Client(site.origin).request('POST', '/auth/login', { raw: 'x'.repeat(1_000_001) })
    expect(reply.status).toBe(413)
    expect(site.requests[0]?.body).toHaveLength(1_000_000)
  })
})
