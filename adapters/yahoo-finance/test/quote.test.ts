import { describe, expect, it } from 'vitest'
import { getQuote } from '../src/quote'
import { FAKE_ORIGIN, yahoo } from './fake-context'

const run = (ctx: ReturnType<typeof yahoo>, symbol: string) =>
  getQuote.run(ctx, getQuote.input.parse({ symbol }))

describe('get_quote', () => {
  it('reads a stock quote and its summary from the captured AAPL page', async () => {
    const ctx = yahoo()
    const quote = await run(ctx, 'aapl')
    expect(ctx.visits.at(-1)).toBe(`${FAKE_ORIGIN}/quote/AAPL/`)
    expect(ctx.fetches).toEqual([])
    expect(quote).toMatchObject({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      type: 'EQUITY',
      currency: 'USD',
      exchange: 'NasdaqGS',
      delayedMinutes: expect.any(Number),
      url: `${FAKE_ORIGIN}/quote/AAPL/`,
    })
    for (const key of [
      'price',
      'previousClose',
      'dayLow',
      'dayHigh',
      'fiftyTwoWeekLow',
      'fiftyTwoWeekHigh',
      'marketCap',
      'trailingPE',
      'analystTargetPrice',
    ] as const) {
      expect(quote[key], key).toEqual(expect.any(Number))
    }
    expect(quote.price).toBeGreaterThan(quote.fiftyTwoWeekLow ?? Number.POSITIVE_INFINITY)
    expect(quote.sector).toBe('Technology')
    expect(quote.time).toMatch(/^\d{4}-\d\d-\d\dT/)
    // Percentages are percentages, not fractions.
    expect(Math.abs(quote.changePercent ?? 0)).toBeLessThan(20)
    expect(quote.dividendYield).toBeGreaterThan(0.05)
    expect(quote.dividendYield).toBeLessThan(5)
  })

  it('reads an ASX stock, an index and a currency pair, whose summaries are shorter', async () => {
    const ctx = yahoo()
    expect(await run(ctx, 'BHP.AX')).toMatchObject({
      symbol: 'BHP.AX',
      currency: 'AUD',
      exchange: 'ASX',
      delayedMinutes: 20,
    })
    const index = await run(ctx, '^GSPC')
    expect(ctx.visits.at(-1)).toBe(`${FAKE_ORIGIN}/quote/%5EGSPC/`)
    expect(index).toMatchObject({
      symbol: '^GSPC',
      name: 'S&P 500',
      type: 'INDEX',
      sector: null,
      analystTargetPrice: null,
    })
    expect(await run(ctx, 'AUDUSD=X')).toMatchObject({
      symbol: 'AUDUSD=X',
      type: 'CURRENCY',
      price: expect.any(Number),
    })
  })

  it('reports an unknown symbol as not-found', async () => {
    await expect(run(yahoo(), 'NOTAREALSYMBOLXX')).rejects.toMatchObject({
      stage: 'tool-run',
      errorClass: 'not-found',
    })
  })

  it('reports a page without its embedded quote as site-changed', async () => {
    const ctx = yahoo()
    ctx.pages.set('/quote/AAPL/', '<!doctype html><title>redesigned</title>')
    await expect(run(ctx, 'AAPL')).rejects.toMatchObject({ errorClass: 'site-changed' })
  })

  it('refuses a symbol that could leave its path segment', () => {
    for (const symbol of ['AAPL/../x', 'A B', '', 'a?b', '%2F']) {
      expect(getQuote.input.safeParse({ symbol }).success, symbol).toBe(false)
    }
  })
})
