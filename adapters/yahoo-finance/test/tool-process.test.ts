// The tools as the app runs them: bundled into the tool script and run in the tool process's
// context, which has none of Node's or the browser's globals (no URL, no URLSearchParams). The
// first live run failed every call with an internal error because tool code reached for `URL`.

import { runInToolContext, ToolThrew } from '@valet/runtime/in-context'
import { buildToolScript } from '@valet/runtime/tool-script'
import { beforeAll, describe, expect, it } from 'vitest'
import { CHART, SEARCH } from './api-data'
import { FAKE_ORIGIN, json, yahoo } from './fake-context'

let script = ''
beforeAll(async () => {
  script = await buildToolScript(new URL('../src/tools.ts', import.meta.url).pathname)
})

describe('in the tool process', () => {
  it('get_quote reads a captured page', async () => {
    const ctx = yahoo()
    const quote = await runInToolContext(script, 'get_quote', { symbol: '^GSPC' }, ctx)
    expect(ctx.visits.at(-1)).toBe(`${FAKE_ORIGIN}/quote/%5EGSPC/`)
    expect(quote).toMatchObject({ symbol: '^GSPC', price: expect.any(Number) })
  })

  it('get_quote reports an unknown symbol as not-found', async () => {
    const ctx = yahoo()
    const failure = await runInToolContext(script, 'get_quote', { symbol: 'NOPE' }, ctx).catch((e) => e)
    expect(failure).toBeInstanceOf(ToolThrew)
    expect((failure as ToolThrew).wire).toEqual({ kind: 'valet', stage: 'tool-run', errorClass: 'not-found' })
  })

  it('search_symbols and get_price_history ask the query1 API', async () => {
    const ctx = yahoo()
    ctx.routes.set('/v1/finance/search', json(SEARCH))
    ctx.routes.set('/v8/finance/chart/BHP.AX', json(CHART))
    const found = await runInToolContext(
      script,
      'search_symbols',
      { query: 'commonwealth bank', limit: 5 },
      ctx,
    )
    expect(found).toMatchObject({ matches: [{ symbol: 'CBA.AX' }, { symbol: 'CMWAY' }] })
    const history = await runInToolContext(
      script,
      'get_price_history',
      { symbol: 'BHP.AX', range: '1mo', interval: '1d' },
      ctx,
    )
    expect(history).toMatchObject({ symbol: 'BHP.AX', currency: 'AUD' })
    expect(ctx.fetches[0]).toBe(
      'https://query1.finance.yahoo.test/v1/finance/search?q=commonwealth%20bank&quotesCount=5&newsCount=0&listsCount=0&enableFuzzyQuery=false',
    )
    expect(ctx.blocked).toEqual([])
  })
})
