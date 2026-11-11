import { tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { getApi } from './api'
import { symbolSchema, symbolSegment } from './symbols'
import { field, isoFromSeconds, num, path, str } from './values'

export const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max'] as const
export const INTERVALS = ['5m', '15m', '30m', '60m', '1d', '1wk', '1mo'] as const
/** The most points returned; the oldest are dropped beyond it. */
export const MAX_POINTS = 400

const pointSchema = z.object({
  time: z.string(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  close: z.number().nullable(),
  /** The close adjusted for splits and dividends, on daily and longer intervals. */
  adjustedClose: z.number().nullable(),
  volume: z.number().nullable(),
})

export const getPriceHistory = tool({
  input: z.object({
    symbol: symbolSchema,
    range: z.enum(RANGES).default('1mo'),
    interval: z.enum(INTERVALS).default('1d'),
  }),
  output: z.object({
    symbol: z.string(),
    currency: z.string().nullable(),
    exchange: z.string().nullable(),
    range: z.string(),
    interval: z.string(),
    /** True when points were dropped to stay under the cap; ask for a coarser interval. */
    truncated: z.boolean(),
    points: z.array(pointSchema),
  }),
  async run(ctx, input) {
    const body = await getApi(ctx, `/v8/finance/chart/${symbolSegment(input.symbol)}`, {
      range: input.range,
      interval: input.interval,
      includePrePost: 'false',
      events: 'div,split',
    })
    const result = path(body, 'chart', 'result')
    const series = Array.isArray(result) ? result[0] : undefined
    if (series === undefined) throw new ValetError('tool-run', 'not-found')
    const times = field(series, 'timestamp')
    const quote = path(series, 'indicators', 'quote')
    const bars = Array.isArray(quote) ? quote[0] : undefined
    const adjusted = path(series, 'indicators', 'adjclose')
    const adjclose = field(Array.isArray(adjusted) ? adjusted[0] : undefined, 'adjclose')
    const column = (name: string) => field(bars, name)
    const at = (values: unknown, i: number) => (Array.isArray(values) ? num(values[i]) : null)
    const points = (Array.isArray(times) ? times : []).flatMap((t, i) => {
      const time = isoFromSeconds(t)
      if (time === null) return []
      return [
        {
          time,
          open: at(column('open'), i),
          high: at(column('high'), i),
          low: at(column('low'), i),
          close: at(column('close'), i),
          adjustedClose: at(adjclose, i),
          volume: at(column('volume'), i),
        },
      ]
    })
    const meta = field(series, 'meta')
    return {
      symbol: str(field(meta, 'symbol')) ?? input.symbol,
      currency: str(field(meta, 'currency')),
      exchange: str(field(meta, 'fullExchangeName')) ?? str(field(meta, 'exchangeName')),
      range: input.range,
      interval: input.interval,
      truncated: points.length > MAX_POINTS,
      points: points.slice(-MAX_POINTS),
    }
  },
})
