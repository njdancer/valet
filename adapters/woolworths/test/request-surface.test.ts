// Every call each tool makes must pass the runtime's request-surface guard for the manifest it
// ships with, or the tool breaks in production. The fake context already refuses undeclared calls;
// these tests also check the purpose of each call against the tool's declared side effect.

import { decideRequest, parseManifest, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { createAdapter } from '../src/adapter'
import { createManifest, REAL_ORIGIN } from '../src/manifest'
import { FAKE_ORIGIN, FakeToolContext, json, loadFixture } from './fake-context'

const INPUTS: Readonly<Record<string, unknown>> = {
  search_products: { query: 'milk', specialsOnly: true },
  get_product: { stockcode: 88436 },
  get_cart: {},
  add_to_cart: { stockcode: 88436, quantity: 2 },
  set_cart_quantity: { stockcode: 88436, quantity: 4 },
  remove_from_cart: { stockcode: 88436 },
}

function serveEverything(ctx: FakeToolContext): FakeToolContext {
  return ctx
    .on('POST', '/apis/ui/Search/products', json(loadFixture('search-milk.json')))
    .on('GET', '/apis/ui/product/detail/88436', json(loadFixture('product-detail-88436.json')))
    .on('GET', '/apis/ui/Trolley', json(loadFixture('trolley-two-items.json')))
    .on('POST', '/api/v3/ui/trolley/update', json(loadFixture('trolley-two-items.json')))
}

for (const origin of [REAL_ORIGIN, FAKE_ORIGIN]) {
  describe(`every tool against the ${origin} manifest`, () => {
    const adapter = createAdapter({ origin })
    const { manifest } = adapter

    for (const declaration of manifest.tools) {
      it(`${declaration.name} only makes calls the guard allows, of a matching purpose`, async () => {
        const implementation = adapter.tools[declaration.name]
        if (implementation === undefined) throw new Error(`missing ${declaration.name}`)
        const ctx = serveEverything(new FakeToolContext(manifest))

        await implementation.run(ctx, implementation.input.parse(INPUTS[declaration.name]))

        expect(ctx.blocked).toEqual([])
        expect(ctx.fetches.length).toBeGreaterThan(0)
        expect(ctx.fetches.length).toBeLessThanOrEqual(manifest.limits.requestsPerRun)
        for (const fetch of ctx.fetches) {
          expect(new URL(fetch.url).origin).toBe(origin)
          const decision = decideRequest(fetch.method, fetch.url, manifest.egress, manifest.requests)
          if (!decision.allowed) throw new Error(`refused ${fetch.method} ${fetch.path}`)
          if (declaration.sideEffect === 'read') expect(decision.declaration.purpose).toBe('read')
          expect(decision.declaration.purpose).not.toBe('irreversible')
        }
      })
    }
  })
}

describe('the declared request surface', () => {
  for (const origin of [REAL_ORIGIN, FAKE_ORIGIN]) {
    it(`is exactly what the tools use, against the ${origin} manifest`, async () => {
      const adapter = createAdapter({ origin })
      const { manifest } = adapter
      const used = new Set<unknown>()
      for (const declaration of manifest.tools) {
        const implementation = adapter.tools[declaration.name]
        if (implementation === undefined) throw new Error(`missing ${declaration.name}`)
        const ctx = serveEverything(new FakeToolContext(manifest))
        await implementation.run(ctx, implementation.input.parse(INPUTS[declaration.name]))
        for (const fetch of ctx.fetches) {
          const decision = decideRequest(fetch.method, fetch.url, manifest.egress, manifest.requests)
          if (decision.allowed) used.add(decision.declaration)
        }
      }
      // Every declaration is something a person approves; one no tool makes is reach for nothing.
      expect(manifest.requests.filter((request) => !used.has(request))).toEqual([])
    })
  }
})

describe('the fake guard', () => {
  it('refuses an undeclared call, so the checks above cannot pass vacuously', async () => {
    const ctx = new FakeToolContext(createManifest({ origin: FAKE_ORIGIN }))
    const attempts = [
      ctx.page.fetch('/api/v3/ui/checkout/submit', { method: 'POST', json: {} }),
      ctx.page.fetch('https://evil.example/apis/ui/Trolley'),
      ctx.page.fetch(`${REAL_ORIGIN}/apis/ui/Trolley`),
      ctx.page.fetch('/apis/ui/Trolley', { method: 'DELETE' }),
    ]
    for (const attempt of attempts) {
      await expect(attempt).rejects.toEqual(new ValetError('request-surface', 'undeclared-request'))
    }
    expect(ctx.blocked.map((b) => b.reason)).toEqual([
      'undeclared',
      'host-not-allowed',
      'host-not-allowed',
      'undeclared',
    ])
    expect(ctx.fetches).toEqual([])
  })

  it('refuses checkout through a wildcard write declaration, as denied-path', async () => {
    const base = createManifest({ origin: FAKE_ORIGIN })
    const broadened = parseManifest({
      ...base,
      requests: [...base.requests, { method: 'POST', path: '/api/v3/ui/*', purpose: 'write' }],
    })
    const ctx = new FakeToolContext(broadened)
    const attempts = [
      ctx.page.fetch('/api/v3/ui/checkout/submit', { method: 'POST', json: {} }),
      ctx.page.fetch('/api/v3/ui/payment/confirm', { method: 'POST', json: {} }),
      ctx.page.fetch('/api/v3/ui/Pay', { method: 'POST', json: {} }),
    ]
    for (const attempt of attempts) {
      await expect(attempt).rejects.toEqual(new ValetError('request-surface', 'undeclared-request'))
    }
    expect(ctx.blocked.map((b) => b.reason)).toEqual(['denied-path', 'denied-path', 'denied-path'])
    expect(ctx.fetches).toEqual([])
  })

  it('refuses every page primitive but fetch, which the adapter never needs', async () => {
    const ctx = new FakeToolContext()
    await expect(ctx.page.goto(FAKE_ORIGIN)).rejects.toThrow()
    await expect(ctx.page.click('#x')).rejects.toThrow()
    await expect(ctx.page.fill('#x', 'y')).rejects.toThrow()
    await expect(ctx.page.extract('#x')).rejects.toThrow()
    await expect(ctx.page.evaluate('1')).rejects.toThrow()
    await expect(ctx.confirm()).rejects.toThrow()
    expect(() => ctx.page.currentUrl()).toThrow()
  })
})
