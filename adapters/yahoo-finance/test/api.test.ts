import { describe, expect, it } from 'vitest'
import { getPriceHistory } from '../src/history'
import { searchSymbols } from '../src/search'
import { CHART, SEARCH } from './api-data'
import { json, yahoo } from './fake-context'

describe('search_symbols', () => {
  it('asks the API on query1, from the page, and reshapes the matches', async () => {
    const ctx = yahoo()
    ctx.routes.set('/v1/finance/search', json(SEARCH))
    const out = await searchSymbols.run(
      ctx,
      searchSymbols.input.parse({ query: 'commonwealth bank', limit: 5 }),
    )
    const url = new URL(ctx.fetches[0] ?? '')
    expect(url.origin).toBe('https://query1.finance.yahoo.test')
    expect(url.searchParams.get('q')).toBe('commonwealth bank')
    expect(url.searchParams.get('newsCount')).toBe('0')
    expect(out.matches).toEqual([
      {
        symbol: 'CBA.AX',
        name: 'Commonwealth Bank of Australia',
        type: 'EQUITY',
        exchange: 'Australian',
        sector: 'Financial Services',
        industry: 'Banks—Diversified',
      },
      {
        symbol: 'CMWAY',
        name: 'Commonwealth Bank ADR',
        type: 'EQUITY',
        exchange: 'PNK',
        sector: null,
        industry: null,
      },
    ])
  })

  it('maps a 429 to rate-limited and HTML to unexpected-shape', async () => {
    const ctx = yahoo()
    ctx.routes.set('/v1/finance/search', { status: 429, contentType: 'text/html', body: 'Too Many Requests' })
    await expect(searchSymbols.run(ctx, searchSymbols.input.parse({ query: 'x' }))).rejects.toMatchObject({
      errorClass: 'rate-limited',
    })
    ctx.routes.set('/v1/finance/search', { status: 200, contentType: 'text/html', body: '<html>' })
    await expect(searchSymbols.run(ctx, searchSymbols.input.parse({ query: 'x' }))).rejects.toMatchObject({
      errorClass: 'unexpected-shape',
    })
    ctx.routes.set('/v1/finance/search', json({ redesigned: true }))
    await expect(searchSymbols.run(ctx, searchSymbols.input.parse({ query: 'x' }))).rejects.toMatchObject({
      errorClass: 'site-changed',
    })
  })
})

describe('get_price_history', () => {
  it('reads the chart into points, keeping nulls the API leaves', async () => {
    const ctx = yahoo()
    ctx.routes.set('/v8/finance/chart/BHP.AX', json(CHART))
    const out = await getPriceHistory.run(ctx, getPriceHistory.input.parse({ symbol: 'bhp.ax', range: '5d' }))
    const url = new URL(ctx.fetches[0] ?? '')
    expect(url.pathname).toBe('/v8/finance/chart/BHP.AX')
    expect(url.searchParams.get('range')).toBe('5d')
    expect(url.searchParams.get('interval')).toBe('1d')
    expect(out).toMatchObject({ symbol: 'BHP.AX', currency: 'AUD', exchange: 'ASX', truncated: false })
    expect(out.points).toHaveLength(3)
    expect(out.points[0]).toEqual({
      time: '2026-11-10T00:00:00.000Z',
      open: 60,
      high: 61,
      low: 59.5,
      close: 60.4,
      adjustedClose: 60.4,
      volume: 100,
    })
    expect(out.points[2]?.close).toBeNull()
  })

  it('encodes ^ and = in the symbol segment, and reports an unknown symbol as not-found', async () => {
    const ctx = yahoo()
    ctx.routes.set('/v8/finance/chart/%5EGSPC', json(CHART))
    await getPriceHistory.run(ctx, getPriceHistory.input.parse({ symbol: '^GSPC' }))
    expect(new URL(ctx.fetches[0] ?? '').pathname).toBe('/v8/finance/chart/%5EGSPC')
    ctx.routes.set(
      '/v8/finance/chart/NOPE',
      json({ chart: { result: null, error: { code: 'Not Found' } } }, 404),
    )
    await expect(
      getPriceHistory.run(ctx, getPriceHistory.input.parse({ symbol: 'NOPE' })),
    ).rejects.toMatchObject({ errorClass: 'not-found' })
  })

  it('refuses ranges and intervals it does not know', () => {
    expect(getPriceHistory.input.safeParse({ symbol: 'A', range: '7d' }).success).toBe(false)
    expect(getPriceHistory.input.safeParse({ symbol: 'A', interval: '1s' }).success).toBe(false)
  })
})
