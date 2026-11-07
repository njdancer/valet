// Drift detection against everything recorded or faked (M4). Every fixture in this package and in
// the fake site, and every response the fake builds, must pass the same checks the gated live smoke
// test runs against the real site (smoke/), with no declared field absent. A drifted copy of each
// must be caught, and a tool reading one must fail with site-changed, not return wrong data.

import { readdirSync, readFileSync } from 'node:fs'
import { ValetError } from '@valet/core'
import {
  applyShapeDrift,
  catalogue,
  FIXTURE_NAMES,
  FIXTURES_DIRECTORY,
  productDetailResponse,
  productNotFoundResponse,
  SHAPE_DRIFTS,
  searchQueryFromJson,
  searchResponse,
  type Trolley,
  trolleyResponse,
} from '@valet/fake-woolworths-site'
import { describe, expect, it } from 'vitest'
import { getCart } from '../src/cart'
import { checkResponse, DRIFT_ENDPOINTS, type DriftEndpoint, firstStockcode, SMOKE_PLAN } from '../src/drift'
import { getProduct, searchProducts } from '../src/products'
import { productTileWire } from '../src/wire'
import { FakeToolContext, json, loadFixture } from './fake-context'

/** What each recorded fixture is. Every file in either fixtures folder must be listed here. */
const ADAPTER_FIXTURES: Record<string, DriftEndpoint> = {
  'product-detail-88436.json': 'productDetail',
  'search-milk.json': 'search',
  'trolley-empty.json': 'trolley',
  'trolley-two-items.json': 'trolley',
}
const FAKE_FIXTURES: Record<string, DriftEndpoint | 'product' | 'synthetic'> = {
  'search-response.json': 'search',
  'product-detail.json': 'productDetail',
  'trolley-empty.json': 'trolley',
  // Single product objects, the templates every fake product is cloned from.
  'product-regular.json': 'product',
  'product-special.json': 'product',
  // The fake's own catalogue rows, not a site response.
  'catalogue.json': 'synthetic',
}

const CANARY = 'canary-drift-3b9e'

function expectClean(endpoint: DriftEndpoint, body: unknown): void {
  expect(checkResponse(endpoint, body)).toEqual({ ok: true, issues: [], absent: [] })
}

describe('recorded fixtures', () => {
  it('lists every fixture file, so a new one cannot skip the checks', () => {
    const own = readdirSync(new URL('./fixtures/', import.meta.url)).filter((name) => name.endsWith('.json'))
    expect(own.sort()).toEqual(Object.keys(ADAPTER_FIXTURES).sort())
    const fake = readdirSync(FIXTURES_DIRECTORY).filter((name) => name.endsWith('.json'))
    expect(fake.sort()).toEqual(Object.keys(FAKE_FIXTURES).sort())
    expect([...FIXTURE_NAMES].sort()).toEqual(Object.keys(FAKE_FIXTURES).sort())
  })

  for (const [name, endpoint] of Object.entries(ADAPTER_FIXTURES)) {
    it(`${name} passes the ${endpoint} checks`, () => expectClean(endpoint, loadFixture(name)))
  }

  for (const [name, kind] of Object.entries(FAKE_FIXTURES)) {
    if (kind === 'synthetic') continue
    it(`the fake's ${name} passes the ${kind} checks`, () => {
      const body = JSON.parse(readFileSync(new URL(name, FIXTURES_DIRECTORY), 'utf8'))
      if (kind === 'product') {
        expect(productTileWire.safeParse(body).success).toBe(true)
        // As a trolley line, through the trolley's own checks.
        const trolley = { ...loadFixture('trolley-empty.json'), AvailableItems: [body], TrolleyItemCount: 1 }
        expectClean('trolley', trolley)
      } else {
        expectClean(kind, body)
      }
    })
  }
})

describe("the fake site's responses", () => {
  const empty: Trolley = new Map()
  const full: Trolley = new Map(catalogue.slice(0, 8).map((product, i) => [product.Stockcode, i + 1]))

  it('searches built from the smoke test request pass, for several terms and with a full trolley', () => {
    for (const term of ['milk', 'bread', 'eggs', 'coffee']) {
      for (const trolley of [empty, full]) {
        const query = searchQueryFromJson(SMOKE_PLAN.search(term).init.json)
        expect(query).not.toBeNull()
        if (query === null) continue
        const body = searchResponse(query, trolley)
        expectClean('search', body)
        expect(firstStockcode(body)).not.toBeNull()
      }
    }
  })

  it('every catalogue product detail passes', () => {
    for (const product of catalogue)
      expectClean('productDetail', productDetailResponse(product.Stockcode, full))
  })

  it('the not-found detail parses, its null fields counting as present', () => {
    expectClean('productDetail', productNotFoundResponse())
  })

  it('an empty and a full trolley (unavailable item included) pass', () => {
    const unavailable = catalogue.find((product) => !product.IsAvailable)
    expect(unavailable).toBeDefined()
    const withUnavailable: Trolley = new Map([...full, [unavailable?.Stockcode ?? 0, 2]])
    expectClean('trolley', trolleyResponse(empty))
    expectClean('trolley', trolleyResponse(withUnavailable))
  })
})

describe('drift is caught', () => {
  const trolleyBody = () => loadFixture('trolley-two-items.json')

  it("the fake's changed-type drift is a parse failure, with the path and types and no value", () => {
    const body = applyShapeDrift(loadFixture('search-milk.json'), 'changed-type')
    const report = checkResponse('search', body)
    expect(report.ok).toBe(false)
    expect(report.issues).toEqual([
      {
        path: 'Products[].Products[].Stockcode',
        code: 'invalid_type',
        expected: 'number',
        received: 'string',
      },
    ])
  })

  it("the fake's renamed-field drift still parses, and shows up as an absent field", () => {
    for (const [endpoint, fixture, path] of [
      ['search', 'search-milk.json', 'Products[].Products[].Price'],
      ['productDetail', 'product-detail-88436.json', 'Product.Price'],
      ['trolley', 'trolley-two-items.json', 'AvailableItems[].Price'],
    ] as const) {
      const report = checkResponse(endpoint, applyShapeDrift(loadFixture(fixture), 'renamed-field'))
      expect(report).toEqual({ ok: false, issues: [], absent: [path] })
    }
  })

  it('an unreadable item in an unconfirmed trolley bucket is reported under that bucket', () => {
    const body = trolleyBody()
    body.RestrictedItems = [{ Stockcode: CANARY }]
    body.ExceededSupplyLimitGroups = [{ Products: [] }]
    const report = checkResponse('trolley', body)
    expect(report.ok).toBe(false)
    expect(report.issues).toEqual([
      {
        path: 'ExceededSupplyLimitGroups[].Items',
        code: 'invalid_type',
        expected: 'array',
        received: 'missing',
      },
      { path: 'RestrictedItems[].Stockcode', code: 'invalid_type', expected: 'number', received: 'string' },
    ])
    expect(JSON.stringify(report)).not.toContain(CANARY)
  })

  it('a bundle line is reported, since nobody has seen one', () => {
    const body = trolleyBody()
    body.BundleItems = [{ Stockcode: 1 }]
    expect(checkResponse('trolley', body).issues).toEqual([
      { path: 'BundleItems[]', code: 'no_schema', expected: null, received: 'object' },
    ])
  })

  it('a missing envelope field is an issue at its path', () => {
    const body = trolleyBody()
    delete body.Totals
    expect(checkResponse('trolley', body).issues).toEqual([
      { path: 'Totals', code: 'invalid_type', expected: 'object', received: 'missing' },
    ])
  })

  it('every endpoint has a check', () => {
    expect([...DRIFT_ENDPOINTS].sort()).toEqual(['productDetail', 'search', 'trolley'])
  })
})

describe('tools reading a drifted response', () => {
  const SEARCH = '/apis/ui/Search/products'
  const TROLLEY = '/apis/ui/Trolley'

  it('fail with site-changed for every changed-type drift, never returning data', async () => {
    const search = new FakeToolContext().on(
      'POST',
      SEARCH,
      json(applyShapeDrift(loadFixture('search-milk.json'), 'changed-type')),
    )
    await expect(searchProducts.run(search, searchProducts.input.parse({ query: 'milk' }))).rejects.toEqual(
      new ValetError('tool-run', 'site-changed'),
    )
    const detail = new FakeToolContext().on(
      'GET',
      '/apis/ui/product/detail/88436',
      json(applyShapeDrift(loadFixture('product-detail-88436.json'), 'changed-type')),
    )
    await expect(getProduct.run(detail, getProduct.input.parse({ stockcode: 88436 }))).rejects.toEqual(
      new ValetError('tool-run', 'site-changed'),
    )
    const cart = new FakeToolContext().on(
      'GET',
      TROLLEY,
      json(applyShapeDrift(loadFixture('trolley-two-items.json'), 'changed-type')),
    )
    await expect(getCart.run(cart, {})).rejects.toEqual(new ValetError('tool-run', 'site-changed'))
  })

  it('read a renamed price as no price: only drift detection notices that one', async () => {
    const ctx = new FakeToolContext().on(
      'POST',
      SEARCH,
      json(applyShapeDrift(loadFixture('search-milk.json'), 'renamed-field')),
    )
    const result = await searchProducts.run(ctx, searchProducts.input.parse({ query: 'milk' }))
    expect(result.products.length).toBeGreaterThan(0)
    for (const product of result.products) expect(product.price).toBeNull()
  })

  it('the fake knows both drifts', () => {
    expect([...SHAPE_DRIFTS].sort()).toEqual(['changed-type', 'renamed-field'])
  })
})

describe('the smoke plan', () => {
  it('makes only reads the manifest declares as read, the same requests the tools make', async () => {
    const plan = [SMOKE_PLAN.search('milk'), SMOKE_PLAN.productDetail(88436), SMOKE_PLAN.trolley()]
    const ctx = new FakeToolContext()
      .on('POST', SEARCH_PATH, json(loadFixture('search-milk.json')))
      .on('GET', '/apis/ui/product/detail/88436', json(loadFixture('product-detail-88436.json')))
      .on('GET', '/apis/ui/Trolley', json(loadFixture('trolley-empty.json')))
    for (const request of plan) {
      // FakeToolContext checks each request against the manifest's surface, at the tool's purpose.
      const result = await ctx.page.fetch(request.path, request.init)
      expectClean(request.endpoint, result.body)
    }
    expect(ctx.fetches.map((f) => `${f.method} ${f.path}`)).toEqual([
      'POST /apis/ui/Search/products',
      'GET /apis/ui/product/detail/88436',
      'GET /apis/ui/Trolley',
    ])
    // The search body is the tool's own.
    const tool = new FakeToolContext().on('POST', SEARCH_PATH, json(loadFixture('search-milk.json')))
    await searchProducts.run(tool, searchProducts.input.parse({ query: 'milk', pageSize: 3 }))
    expect(tool.fetches[0]?.json).toEqual(plan[0]?.init.json)
  })

  it('reads the first stockcode out of a search, or null', () => {
    expect(firstStockcode(loadFixture('search-milk.json'))).toBe(88436)
    expect(firstStockcode({ Products: [] })).toBeNull()
    expect(firstStockcode('<html>')).toBeNull()
    expect(
      firstStockcode({ Products: [{ Products: 'x' }, 7, { Products: [{ Stockcode: -1 }, {}] }] }),
    ).toBeNull()
    // Loosely, so a drifted search still leads to a detail read.
    expect(firstStockcode(applyShapeDrift(loadFixture('search-milk.json'), 'changed-type'))).toBe(88436)
  })
})

const SEARCH_PATH = '/apis/ui/Search/products'
