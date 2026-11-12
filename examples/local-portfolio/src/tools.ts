// The example local-data adapter (docs/sandbox.md#the-example-local-data-adapter): reads one file
// through its declared exception, ctx.local.files, and prices each line from Yahoo Finance's chart
// API through the page, like the built-in adapter. Nothing else on the Mac is reachable from here.

import { type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'

export const PORTFOLIO_FILE = '~/Documents/Valet/portfolio.csv'
const MAX_HOLDINGS = 20
const SYMBOL = /^[A-Z0-9^][A-Z0-9.=^-]{0,19}$/

const holding = z.object({
  symbol: z.string(),
  quantity: z.number(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  value: z.number().nullable(),
})

/** symbol,quantity lines; a header line, blank lines and # comments are skipped. */
export function parseHoldings(text: string): { symbol: string; quantity: number }[] {
  const out: { symbol: string; quantity: number }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [symbolCell = '', quantityCell = ''] = line.split(',').map((c) => c.trim())
    const symbol = symbolCell.toUpperCase()
    const quantity = Number(quantityCell)
    if (!SYMBOL.test(symbol) || !Number.isFinite(quantity)) continue
    out.push({ symbol, quantity })
    if (out.length > MAX_HOLDINGS) throw new ValetError('tool-input', 'invalid')
  }
  return out
}

async function latestPrice(
  ctx: ToolContext,
  symbol: string,
): Promise<{ price: number | null; currency: string | null }> {
  const response = await ctx.page.fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
    { headers: { accept: 'application/json' } },
  )
  if (response.status === 404) return { price: null, currency: null }
  if (response.status === 429) throw new ValetError('tool-run', 'rate-limited')
  if (response.status < 200 || response.status >= 300) throw new ValetError('tool-run', 'unavailable')
  const meta = (response.body as { chart?: { result?: { meta?: Record<string, unknown> }[] } } | null)?.chart
    ?.result?.[0]?.meta
  const price = typeof meta?.['regularMarketPrice'] === 'number' ? meta['regularMarketPrice'] : null
  const currency = typeof meta?.['currency'] === 'string' ? meta['currency'] : null
  return { price, currency }
}

export const tools = {
  get_portfolio: tool({
    input: z.object({}),
    output: z.object({
      holdings: z.array(holding),
      /** The value held in each currency. */
      totals: z.array(z.object({ currency: z.string(), value: z.number() })),
    }),
    async run(ctx) {
      if (ctx.local === undefined) throw new ValetError('tool-run', 'not-granted')
      const holdings = []
      const total: Record<string, number> = {}
      for (const { symbol, quantity } of parseHoldings(await ctx.local.files.read(PORTFOLIO_FILE))) {
        const { price, currency } = await latestPrice(ctx, symbol)
        const value = price === null ? null : Math.round(price * quantity * 100) / 100
        if (value !== null && currency !== null)
          total[currency] = Math.round(((total[currency] ?? 0) + value) * 100) / 100
        holdings.push({ symbol, quantity, price, currency, value })
      }
      return { holdings, totals: Object.entries(total).map(([currency, value]) => ({ currency, value })) }
    },
  }),
}
