import { tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { getApi } from './api'
import { field, str } from './values'

export const symbolMatchSchema = z.object({
  symbol: z.string(),
  name: z.string().nullable(),
  type: z.string().nullable(),
  exchange: z.string().nullable(),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
})

export const searchSymbols = tool({
  input: z.object({
    query: z.string().trim().min(1).max(80),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  output: z.object({ matches: z.array(symbolMatchSchema) }),
  async run(ctx, input) {
    const body = await getApi(ctx, '/v1/finance/search', {
      q: input.query,
      quotesCount: String(input.limit),
      newsCount: '0',
      listsCount: '0',
      enableFuzzyQuery: 'false',
    })
    const quotes = field(body, 'quotes')
    if (!Array.isArray(quotes)) throw new ValetError('tool-run', 'site-changed')
    const matches = quotes.flatMap((q) => {
      const symbol = str(field(q, 'symbol'))
      if (symbol === null) return []
      return [
        {
          symbol,
          name: str(field(q, 'longname')) ?? str(field(q, 'shortname')),
          type: str(field(q, 'quoteType')),
          exchange: str(field(q, 'exchDisp')) ?? str(field(q, 'exchange')),
          sector: str(field(q, 'sectorDisp')) ?? str(field(q, 'sector')),
          industry: str(field(q, 'industryDisp')) ?? str(field(q, 'industry')),
        },
      ]
    })
    return { matches: matches.slice(0, input.limit) }
  },
})
