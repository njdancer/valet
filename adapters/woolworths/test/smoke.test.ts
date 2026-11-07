// The live smoke test's run, against canned answers. The Electron harness in smoke/ runs the same
// function on a real tool page; this covers its decisions: pacing, what stops it, what it reports.

import type { FetchResult } from '@valet/core'
import { applyShapeDrift } from '@valet/fake-woolworths-site'
import { describe, expect, it } from 'vitest'
import { runSmoke } from '../src/smoke'
import { json, loadFixture } from './fake-context'

const CANARY = 'canary-smoke-77d1'

type Answer = FetchResult | Error

function site(answers: Record<string, Answer>) {
  const calls: string[] = []
  const sleeps: number[] = []
  return {
    calls,
    sleeps,
    options: {
      gapMs: 10_000,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      fetch: async (path: string, init: { method?: string }) => {
        const key = `${init.method ?? 'GET'} ${path}`
        calls.push(key)
        const answer = answers[key]
        if (answer === undefined) throw new Error(`unexpected ${key}`)
        if (answer instanceof Error) throw answer
        return answer
      },
    },
  }
}

const SEARCH = 'POST /apis/ui/Search/products'
const DETAIL = 'GET /apis/ui/product/detail/88436'
const TROLLEY = 'GET /apis/ui/Trolley'

const healthy = () => ({
  [SEARCH]: json(loadFixture('search-milk.json')),
  [DETAIL]: json(loadFixture('product-detail-88436.json')),
  [TROLLEY]: json(loadFixture('trolley-empty.json')),
})

describe('runSmoke', () => {
  it('makes three paced reads and passes recorded shapes', async () => {
    const s = site(healthy())
    const result = await runSmoke(s.options)
    expect(s.calls).toEqual([SEARCH, DETAIL, TROLLEY])
    expect(s.sleeps).toEqual([10_000, 10_000])
    expect(result.ok).toBe(true)
    expect(result.stopped).toBeNull()
    expect(result.steps.map((step) => [step.endpoint, step.status, step.report?.ok])).toEqual([
      ['search', 200, true],
      ['productDetail', 200, true],
      ['trolley', 200, true],
    ])
  })

  it('reports drift without stopping, and keeps no value', async () => {
    const answers = healthy()
    const detail = loadFixture('product-detail-88436.json')
    detail.Product.Name = CANARY
    answers[DETAIL] = json(applyShapeDrift(detail, 'changed-type'))
    const result = await runSmoke(site(answers).options)
    expect(result.ok).toBe(false)
    expect(result.stopped).toBeNull()
    expect(result.steps[1]?.report?.issues).toEqual([
      { path: 'Product.Stockcode', code: 'invalid_type', expected: 'number', received: 'string' },
    ])
    expect(JSON.stringify(result)).not.toContain(CANARY)
    expect(JSON.stringify(result)).not.toContain('Dairy Farmers')
  })

  it('stops at a 403, a 429 or an HTML answer, and makes no further request', async () => {
    for (const answer of [
      { status: 403, contentType: 'text/html', body: '<HTML>Access Denied' },
      { status: 429, contentType: 'application/json', body: {} },
      { status: 200, contentType: 'text/html', body: '<html>login' },
    ]) {
      const s = site({ ...healthy(), [SEARCH]: answer })
      const result = await runSmoke(s.options)
      expect(s.calls).toEqual([SEARCH])
      expect(result).toMatchObject({ ok: false, stopped: { reason: 'blocked', status: answer.status } })
      expect(result.steps[0]?.report).toBeNull()
    }
  })

  it('stops at a block partway, keeping the steps before it', async () => {
    const s = site({ ...healthy(), [TROLLEY]: { status: 403, contentType: 'text/html', body: 'denied' } })
    const result = await runSmoke(s.options)
    expect(s.calls).toEqual([SEARCH, DETAIL, TROLLEY])
    expect(result.steps).toHaveLength(3)
    expect(result.stopped).toEqual({ reason: 'blocked', status: 403 })
  })

  it('stops as unavailable on another error status or a body that is not JSON', async () => {
    for (const answer of [
      { status: 500, contentType: 'application/json', body: {} },
      { status: 200, contentType: 'text/plain', body: 'hello' },
    ]) {
      const result = await runSmoke(site({ ...healthy(), [SEARCH]: answer }).options)
      expect(result.stopped).toEqual({ reason: 'unavailable', status: answer.status })
    }
  })

  it('stops as refused when the fetch throws, keeping nothing of the error', async () => {
    const result = await runSmoke(site({ ...healthy(), [SEARCH]: new Error(CANARY) }).options)
    expect(result).toEqual({ steps: [], stopped: { reason: 'refused' }, ok: false })
  })

  it('stops when the search finds no product', async () => {
    const s = site({ ...healthy(), [SEARCH]: json({ SearchResultsCount: 0, Products: [] }) })
    const result = await runSmoke(s.options)
    expect(s.calls).toEqual([SEARCH])
    expect(result.stopped).toEqual({ reason: 'no-product' })
  })

  it('searches for the term it is given', async () => {
    const seen: unknown[] = []
    await runSmoke({
      gapMs: 0,
      query: 'bread',
      fetch: async (path, init) => {
        seen.push(init.json)
        return path.includes('Search') ? json({ Products: [] }) : json({})
      },
    })
    expect(seen).toEqual([expect.objectContaining({ SearchTerm: 'bread', PageSize: 3 })])
  })
})
