import { ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { searchProducts } from '../src/products'
import { FakeToolContext, json, loadFixture } from './fake-context'

const SEARCH = '/apis/ui/Search/products'

function run(ctx: FakeToolContext, input: unknown) {
  return searchProducts.run(ctx, searchProducts.input.parse(input))
}

describe('search_products mapping', () => {
  it('maps a special with its was-price', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    const result = await run(ctx, { query: 'milk' })
    expect(result.products[0]).toEqual({
      stockcode: 88436,
      name: 'Dairy Farmers Full Cream Milk 2L',
      brand: 'Dairy Farmers',
      size: '2L',
      price: 4.2,
      cupPrice: '$2.10 / 1L',
      wasPrice: 4.7,
      onSpecial: true,
      available: true,
      imageUrl: 'https://cdn0.woolworths.media/content/wowproductimages/medium/088436.jpg',
    })
  })

  it('gives no was-price for a product that is not on special', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    const result = await run(ctx, { query: 'milk' })
    const pauls = result.products.find((p) => p.stockcode === 204746)
    expect(pauls).toMatchObject({ price: 4.95, wasPrice: null, onSpecial: false })
  })

  it('flattens every variant group and reports the site total', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    const result = await run(ctx, { query: 'milk' })
    expect(result.total).toBe(2621)
    expect(result.suggestedQuery).toBeNull()
    expect(result.products.map((p) => p.stockcode)).toEqual([88436, 64746, 204746, 888140, 888137])
  })

  it('returns only the clean fields, never raw Woolworths keys', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    const result = await run(ctx, { query: 'milk' })
    expect(Object.keys(result).sort()).toEqual(['products', 'suggestedQuery', 'total'])
    expect(JSON.stringify(result)).not.toMatch(/Barcode|Diagnostics|CentreTag|SupplyLimitMessage/)
    expect(searchProducts.output.parse(result)).toEqual(result)
  })

  it('maps a missing price to null and keeps the was-price of a special', async () => {
    const body = loadFixture('search-milk.json')
    body.Products[0].Products[0].Price = null
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'milk' })
    expect(result.products[0]).toMatchObject({ price: null, wasPrice: 4.7, onSpecial: true })
  })

  it('drops a was-price that is not above the price, even on special', async () => {
    const body = loadFixture('search-milk.json')
    body.Products[0].Products[0].WasPrice = 4.2
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'milk' })
    expect(result.products[0]).toMatchObject({ price: 4.2, wasPrice: null, onSpecial: true })
  })

  it('marks an unavailable product', async () => {
    const body = loadFixture('search-milk.json')
    body.Products[1].Products[0].IsAvailable = false
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'milk' })
    expect(result.products[1]).toMatchObject({ stockcode: 64746, available: false })
  })

  it('maps a missing image to null', async () => {
    const body = loadFixture('search-milk.json')
    body.Products[0].Products[0].MediumImageFile = null
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'milk' })
    expect(result.products[0]?.imageUrl).toBeNull()
  })

  it('refuses an image URL that is not https', async () => {
    const body = loadFixture('search-milk.json')
    body.Products[0].Products[0].MediumImageFile = 'javascript:alert(1)'
    body.Products[1].Products[0].MediumImageFile = 'http://cdn0.woolworths.media/x.jpg'
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'milk' })
    expect(result.products[0]?.imageUrl).toBeNull()
    expect(result.products[1]?.imageUrl).toBeNull()
  })

  it('falls back to Name, then to the stockcode, when DisplayName is missing', async () => {
    const body = loadFixture('search-milk.json')
    body.Products[0].Products[0].DisplayName = null
    body.Products[1].Products[0].DisplayName = '  '
    body.Products[1].Products[0].Name = null
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'milk' })
    expect(result.products[0]?.name).toBe('Dairy Farmers Full Cream Milk Full Cream Milk')
    expect(result.products[1]?.name).toBe('Product 64746')
  })

  it('maps missing brand, size and cup price to null', async () => {
    const body = loadFixture('search-milk.json')
    const tile = body.Products[0].Products[0]
    delete tile.Brand
    tile.PackageSize = ''
    tile.CupString = null
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'milk' })
    expect(result.products[0]).toMatchObject({ brand: null, size: null, cupPrice: null })
  })

  it('returns an empty list when the site has no matches', async () => {
    const body = loadFixture('search-milk.json')
    body.Products = null
    body.SearchResultsCount = 0
    body.SuggestedTerm = 'milk'
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'mlik' })
    expect(result).toEqual({ total: 0, suggestedQuery: 'milk', products: [] })
  })

  it('counts the products when the site sends no total, and tolerates a group with no products', async () => {
    const body = loadFixture('search-milk.json')
    body.SearchResultsCount = null
    body.Products[0].Products = null
    const ctx = new FakeToolContext().on('POST', SEARCH, json(body))
    const result = await run(ctx, { query: 'milk' })
    expect(result.total).toBe(4)
  })
})

describe('search_products request', () => {
  it('makes exactly one POST with the confirmed body keys, without a login', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    await run(ctx, { query: '  milk  ' })
    expect(ctx.events).toEqual(['POST /apis/ui/Search/products'])
    expect(ctx.fetches[0]?.json).toEqual({
      SearchTerm: 'milk',
      PageSize: 12,
      PageNumber: 1,
      SortType: 'TraderRelevance',
      IsSpecial: false,
    })
  })

  it('passes the page and page size through', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    await run(ctx, { query: 'milk', page: 3, pageSize: 36 })
    expect(ctx.fetches[0]?.json).toMatchObject({ PageSize: 36, PageNumber: 3 })
  })

  it('asks for specials and filters to them, in case the site ignores the flag', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    const result = await run(ctx, { query: 'milk', specialsOnly: true })
    expect(ctx.fetches[0]?.json).toMatchObject({ IsSpecial: true })
    expect(result.products.map((p) => p.stockcode)).toEqual([88436, 64746])
  })

  it('keeps the query out of the URL, where it would land in logs', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    await run(ctx, { query: 'pregnancy test' })
    expect(ctx.fetches[0]?.url).toBe('https://www.woolworths.test/apis/ui/Search/products')
  })
})

describe('search_products input', () => {
  const parse = (input: unknown) => searchProducts.input.safeParse(input)

  it('applies the defaults', () => {
    expect(parse({ query: 'milk' }).data).toEqual({
      query: 'milk',
      page: 1,
      pageSize: 12,
      specialsOnly: false,
    })
  })

  it('refuses an empty or blank query', () => {
    expect(parse({ query: '' }).success).toBe(false)
    expect(parse({ query: '   ' }).success).toBe(false)
    expect(parse({}).success).toBe(false)
  })

  it('refuses a query over 100 characters', () => {
    expect(parse({ query: 'a'.repeat(100) }).success).toBe(true)
    expect(parse({ query: 'a'.repeat(101) }).success).toBe(false)
  })

  it('bounds the page size to 1..36', () => {
    expect(parse({ query: 'milk', pageSize: 36 }).success).toBe(true)
    expect(parse({ query: 'milk', pageSize: 37 }).success).toBe(false)
    expect(parse({ query: 'milk', pageSize: 0 }).success).toBe(false)
    expect(parse({ query: 'milk', pageSize: 1.5 }).success).toBe(false)
  })

  it('bounds the page to 1..50', () => {
    expect(parse({ query: 'milk', page: 0 }).success).toBe(false)
    expect(parse({ query: 'milk', page: 51 }).success).toBe(false)
    expect(parse({ query: 'milk', page: '2' }).success).toBe(false)
  })
})

describe('search_products failures', () => {
  async function failure(ctx: FakeToolContext): Promise<ValetError> {
    const error = await run(ctx, { query: 'milk' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValetError)
    return error as ValetError
  }

  it('reports an Akamai "Access Denied" page as blocked-by-site', async () => {
    const page = '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.a66e</BODY></HTML>'
    const ctx = new FakeToolContext().on('POST', SEARCH, {
      status: 403,
      contentType: 'text/html',
      body: page,
    })
    const error = await failure(ctx)
    expect([error.stage, error.errorClass]).toEqual(['tool-run', 'blocked-by-site'])
    expect(error.message).not.toContain('Reference')
  })

  it('reports a 429 as rate-limited, apart from an Akamai block', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json({}, 429))
    const error = await failure(ctx)
    expect([error.stage, error.errorClass]).toEqual(['tool-run', 'rate-limited'])
  })

  it('reports a 401 as not-logged-in', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json({}, 401))
    expect((await failure(ctx)).errorClass).toBe('not-logged-in')
  })

  it('reports a server error as unavailable', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json({}, 503))
    expect((await failure(ctx)).errorClass).toBe('unavailable')
  })

  it('reports a 200 HTML page as blocked-by-site, so the runtime backs off, without echoing it', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, {
      status: 200,
      contentType: 'text/html',
      body: '<html>Please verify you are human: canary-7f3a</html>',
    })
    const error = await failure(ctx)
    expect([error.stage, error.errorClass]).toEqual(['tool-run', 'blocked-by-site'])
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('canary-7f3a')
  })

  it('reports an HTML body with no content type as blocked-by-site', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, {
      status: 200,
      contentType: null,
      body: '  <!DOCTYPE html><html>Sign in</html>',
    })
    expect((await failure(ctx)).errorClass).toBe('blocked-by-site')
  })

  it('reports a 200 that is neither JSON nor HTML as unavailable', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, {
      status: 200,
      contentType: 'text/plain',
      body: 'ok',
    })
    expect((await failure(ctx)).errorClass).toBe('unavailable')
  })

  it('refuses a JSON-looking body that is not labelled JSON', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, {
      status: 200,
      contentType: null,
      body: loadFixture('search-milk.json'),
    })
    expect((await failure(ctx)).errorClass).toBe('unavailable')
  })

  it('reports JSON of the wrong shape as site-changed', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json({ Products: 'not a list' }))
    expect((await failure(ctx)).errorClass).toBe('site-changed')
  })

  it('replaces a thrown error with a class, dropping its message', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, () => {
      throw new Error('net::ERR_FAILED https://www.woolworths.test/?token=canary-91c2')
    })
    const error = await failure(ctx)
    expect([error.stage, error.errorClass]).toEqual(['tool-run', 'unavailable'])
    expect(error.message).not.toContain('canary-91c2')
  })

  it("passes the runtime guard's own error through unchanged", async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, () => {
      throw new ValetError('request-surface', 'request-ceiling')
    })
    const error = await failure(ctx)
    expect([error.stage, error.errorClass]).toEqual(['request-surface', 'request-ceiling'])
  })

  it('makes no request once the call is cancelled', async () => {
    const ctx = new FakeToolContext().on('POST', SEARCH, json(loadFixture('search-milk.json')))
    ctx.controller.abort()
    const error = await failure(ctx)
    expect([error.stage, error.errorClass]).toEqual(['tool-run', 'aborted'])
    expect(ctx.fetches).toEqual([])
  })
})
