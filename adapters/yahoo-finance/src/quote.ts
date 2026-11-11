// get_quote: the quote page, read for the JSON it is rendered with. The page embeds each response
// its server fetched as <script type="application/json" data-sveltekit-fetched data-url="…">,
// holding { status, body } with the API's JSON as a string in body. Two are read: the quote
// (v7/finance/quote, the page's main one asks for fiftyTwoWeekHigh first) and the quote summary
// (v10/finance/quoteSummary: valuation, dividends, analyst figures, profile).

import { type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { REAL_ORIGIN } from './origins'
import { symbolSchema, symbolSegment } from './symbols'
import { field, isoFromSeconds, num, path, round, str } from './values'

export const QUOTE_SCRIPT =
  'script[type="application/json"][data-sveltekit-fetched][data-url*="/v7/finance/quote?fields=fiftyTwoWeekHigh"]'
export const SUMMARY_SCRIPT =
  'script[type="application/json"][data-sveltekit-fetched][data-url*="/v10/finance/quoteSummary/"]'

const sessionPriceSchema = z.object({
  price: z.number(),
  change: z.number().nullable(),
  changePercent: z.number().nullable(),
  time: z.string().nullable(),
})

export const quoteSchema = z.object({
  symbol: z.string(),
  name: z.string().nullable(),
  /** EQUITY, ETF, INDEX, CURRENCY, CRYPTOCURRENCY, FUTURE, MUTUALFUND… */
  type: z.string().nullable(),
  exchange: z.string().nullable(),
  currency: z.string().nullable(),
  /** REGULAR, PRE, POST, POSTPOST, CLOSED… as the site reports it. */
  marketState: z.string().nullable(),
  price: z.number().nullable(),
  change: z.number().nullable(),
  /** In percent: -0.64 means down 0.64 %. */
  changePercent: z.number().nullable(),
  previousClose: z.number().nullable(),
  open: z.number().nullable(),
  dayLow: z.number().nullable(),
  dayHigh: z.number().nullable(),
  fiftyTwoWeekLow: z.number().nullable(),
  fiftyTwoWeekHigh: z.number().nullable(),
  volume: z.number().nullable(),
  averageVolume: z.number().nullable(),
  marketCap: z.number().nullable(),
  trailingPE: z.number().nullable(),
  forwardPE: z.number().nullable(),
  /** In percent. */
  dividendYield: z.number().nullable(),
  eps: z.number().nullable(),
  beta: z.number().nullable(),
  analystTargetPrice: z.number().nullable(),
  /** strong_buy, buy, hold, underperform, sell, as the site words it. */
  analystRecommendation: z.string().nullable(),
  analystCount: z.number().nullable(),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
  /** When the regular-session price was set. */
  time: z.string().nullable(),
  /** How many minutes the exchange's prices are delayed by; 0 is real time. */
  delayedMinutes: z.number().nullable(),
  preMarket: sessionPriceSchema.nullable(),
  postMarket: sessionPriceSchema.nullable(),
  /** The quote's page on the site. */
  url: z.string(),
})
export type Quote = z.infer<typeof quoteSchema>

export const getQuote = tool({
  input: z.object({ symbol: symbolSchema }),
  output: quoteSchema,
  run: (ctx, input) =>
    readQuotePage(ctx, input.symbol, siteUrl(ctx, `/quote/${symbolSegment(input.symbol)}/`)),
})

/**
 * `path` on the tool page's own origin, so the same code serves the real site and a fake. Before
 * the page has loaded anything, the real site.
 */
export function siteUrl(ctx: ToolContext, path: string): string {
  let origin = REAL_ORIGIN
  try {
    const current = new URL(ctx.page.currentUrl())
    if (current.protocol === 'https:') origin = current.origin
  } catch {
    // about:blank or nothing yet.
  }
  return new URL(path, origin).href
}

async function readQuotePage(ctx: ToolContext, symbol: string, url: string): Promise<Quote> {
  if (ctx.signal.aborted) throw new ValetError('tool-run', 'aborted')
  await ctx.page.goto(url)
  // A symbol the site doesn't know answers 404 and its inline script moves the page home.
  if (!new URL(ctx.page.currentUrl()).pathname.startsWith('/quote/'))
    throw new ValetError('tool-run', 'not-found')
  const quoteBody = embedded(await ctx.page.extract(QUOTE_SCRIPT))
  if (quoteBody === undefined) throw new ValetError('tool-run', 'site-changed')
  const results = path(quoteBody, 'quoteResponse', 'result')
  const quote = Array.isArray(results)
    ? results.find((r) => str(field(r, 'symbol'))?.toUpperCase() === symbol)
    : undefined
  if (quote === undefined) throw new ValetError('tool-run', 'not-found')
  // The summary is extra: an index or currency has a short one, and a missing one is no error.
  const summaryBody = embedded(await ctx.page.extract(SUMMARY_SCRIPT))
  const summary = path(summaryBody, 'quoteSummary', 'result')
  return toQuote(quote, Array.isArray(summary) ? summary[0] : undefined, url)
}

/** The API JSON inside one embedded-response script's text, or undefined if it isn't one. */
export function embedded(text: unknown): unknown {
  if (typeof text !== 'string' || text.length > 2_000_000) return undefined
  try {
    const outer: unknown = JSON.parse(text)
    if (num(field(outer, 'status')) !== 200) return undefined
    const body = field(outer, 'body')
    return typeof body === 'string' ? JSON.parse(body) : body
  } catch {
    return undefined
  }
}

export function toQuote(quote: unknown, summary: unknown, url: string): Quote {
  const q = (key: string) => num(field(quote, key))
  const s = (module: string, key: string) => num(path(summary, module, key))
  const percent = (value: number | null) => round(value, 4)
  return {
    symbol: str(field(quote, 'symbol')) ?? '',
    name: str(field(quote, 'longName')) ?? str(field(quote, 'shortName')),
    type: str(field(quote, 'quoteType')),
    exchange: str(field(quote, 'fullExchangeName')) ?? str(field(quote, 'exchange')),
    currency: str(field(quote, 'currency')),
    marketState: str(field(quote, 'marketState')),
    price: q('regularMarketPrice'),
    change: round(q('regularMarketChange'), 4),
    changePercent: percent(q('regularMarketChangePercent')),
    previousClose: q('regularMarketPreviousClose') ?? s('summaryDetail', 'previousClose'),
    open: q('regularMarketOpen') ?? s('summaryDetail', 'open'),
    dayLow: q('regularMarketDayLow'),
    dayHigh: q('regularMarketDayHigh'),
    fiftyTwoWeekLow: q('fiftyTwoWeekLow'),
    fiftyTwoWeekHigh: q('fiftyTwoWeekHigh'),
    volume: q('regularMarketVolume'),
    averageVolume: s('summaryDetail', 'averageVolume'),
    marketCap: q('marketCap') ?? s('summaryDetail', 'marketCap'),
    trailingPE: s('summaryDetail', 'trailingPE'),
    forwardPE: s('summaryDetail', 'forwardPE') ?? s('defaultKeyStatistics', 'forwardPE'),
    dividendYield: percent(scaled(s('summaryDetail', 'dividendYield'))),
    eps: s('defaultKeyStatistics', 'trailingEps'),
    beta: s('summaryDetail', 'beta') ?? s('defaultKeyStatistics', 'beta'),
    analystTargetPrice: s('financialData', 'targetMeanPrice'),
    analystRecommendation: str(path(summary, 'financialData', 'recommendationKey')),
    analystCount: s('financialData', 'numberOfAnalystOpinions'),
    sector: str(path(summary, 'summaryProfile', 'sector')),
    industry: str(path(summary, 'summaryProfile', 'industry')),
    time: isoFromSeconds(field(quote, 'regularMarketTime')),
    delayedMinutes: q('exchangeDataDelayedBy'),
    preMarket: sessionPrice(quote, 'preMarket'),
    postMarket: sessionPrice(quote, 'postMarket'),
    url,
  }
}

/** A fraction as a percentage: Yahoo's summary gives yields as 0.0042 for 0.42 %. */
function scaled(value: number | null): number | null {
  return value === null ? null : value * 100
}

function sessionPrice(quote: unknown, prefix: 'preMarket' | 'postMarket'): Quote['preMarket'] {
  const price = num(field(quote, `${prefix}Price`))
  if (price === null) return null
  return {
    price,
    change: round(num(field(quote, `${prefix}Change`)), 4),
    changePercent: round(num(field(quote, `${prefix}ChangePercent`)), 4),
    time: isoFromSeconds(field(quote, `${prefix}Time`)),
  }
}
