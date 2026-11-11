import { readFileSync } from 'node:fs'
import {
  decideRequest,
  type EnsureResult,
  type FetchInit,
  type FetchResult,
  hasLogin,
  type ToolContext,
  ValetError,
} from '@valet/core'
import { runInToolContext } from '@valet/runtime/in-context'
import { buildToolScript } from '@valet/runtime/tool-script'
import { describe, expect, it } from 'vitest'
import { createAdapter } from '../src/adapter'
import { getArticle, getSummary, searchArticles } from '../src/articles'
import { createManifest } from '../src/manifest'

const ORIGIN = 'https://en.wikipedia.test'
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const json = (body: unknown, status = 200): FetchResult => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body,
})

/** A tool context on the fake origin whose fetch checks the request surface, then serves `routes`. */
function wiki(routes: Record<string, FetchResult>) {
  const manifest = createManifest({ origin: ORIGIN })
  const fetched: { url: URL; init?: FetchInit }[] = []
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    session: { ensure: async (): Promise<EnsureResult> => Promise.reject(new Error('no login')) },
    confirm: async () => Promise.reject(new Error('not used')),
    page: {
      currentUrl: () => `${ORIGIN}/`,
      goto: async () => Promise.reject(new Error('not used')),
      click: async () => Promise.reject(new Error('not used')),
      fill: async () => Promise.reject(new Error('not used')),
      extract: async () => Promise.reject(new Error('not used')),
      evaluate: async () => Promise.reject(new Error('not used')),
      fetch: async (url: string, init?: FetchInit) => {
        const target = new URL(url)
        if (!decideRequest(init?.method ?? 'GET', target.href, manifest.egress, manifest.requests).allowed) {
          throw new ValetError('request-surface', 'undeclared-request')
        }
        fetched.push({ url: target, ...(init === undefined ? {} : { init }) })
        return routes[target.pathname] ?? json({ status: 404, type: 'Internal error' }, 404)
      },
    },
  }
  return { ctx, fetched }
}

describe('search_articles', () => {
  it('searches with the REST API and turns excerpts into plain text', async () => {
    const { ctx, fetched } = wiki({ '/w/rest.php/v1/search/page': json(fixture('search-kangaroo.json')) })
    const out = await searchArticles.run(ctx, searchArticles.input.parse({ query: 'kangaroo' }))
    expect(fetched[0]?.url.searchParams.get('q')).toBe('kangaroo')
    expect(fetched[0]?.init?.headers?.['api-user-agent']).toMatch(/^Valet\//)
    expect(out.results[0]).toEqual({
      title: 'Kangaroo',
      description: 'Marsupial of the family Macropodidae',
      excerpt: expect.stringContaining('the red kangaroo, as well as'),
      url: `${ORIGIN}/wiki/Kangaroo`,
    })
    expect(out.results.every((r) => !r.excerpt?.includes('<'))).toBe(true)
  })
})

describe('get_summary', () => {
  it('reads the lead from the summary API', async () => {
    const { ctx, fetched } = wiki({
      '/api/rest_v1/page/summary/Red_kangaroo': json(fixture('summary-kangaroo.json')),
    })
    const out = await getSummary.run(ctx, getSummary.input.parse({ title: 'Red kangaroo' }))
    expect(fetched[0]?.url.pathname).toBe('/api/rest_v1/page/summary/Red_kangaroo')
    expect(out).toMatchObject({ title: 'Kangaroo', type: 'standard', url: `${ORIGIN}/wiki/Kangaroo` })
    expect(out.summary).toMatch(/^Kangaroos are marsupials/)
  })

  it('reports a missing article as not-found', async () => {
    const { ctx } = wiki({})
    await expect(getSummary.run(ctx, getSummary.input.parse({ title: 'Nope' }))).rejects.toMatchObject({
      errorClass: 'not-found',
    })
  })

  it('refuses titles with characters no title may have', () => {
    for (const title of ['a#b', 'a|b', 'line\nbreak', ''])
      expect(getSummary.input.safeParse({ title }).success).toBe(false)
  })
})

describe('get_article', () => {
  it('reads the plain-text extract, cut to maxChars', async () => {
    const { ctx, fetched } = wiki({ '/w/api.php': json(fixture('extract-kangaroo.json')) })
    const out = await getArticle.run(ctx, getArticle.input.parse({ title: 'Kangaroo', maxChars: 1000 }))
    const params = fetched[0]?.url.searchParams
    expect(params?.get('action')).toBe('query')
    expect(params?.get('prop')).toBe('extracts')
    expect(params?.get('titles')).toBe('Kangaroo')
    expect(out.text).toHaveLength(1000)
    expect(out.truncated).toBe(true)
    expect(out.title).toBe('Kangaroo')
  })

  it('reports a missing page as not-found', async () => {
    const { ctx } = wiki({
      '/w/api.php': json({ query: { pages: [{ ns: 0, title: 'Nope', missing: true }] } }),
    })
    await expect(getArticle.run(ctx, getArticle.input.parse({ title: 'Nope' }))).rejects.toMatchObject({
      errorClass: 'not-found',
    })
  })
})

describe('the Wikipedia manifest', () => {
  it('has no login, reads only, and reaches only its own host', () => {
    const manifest = createManifest()
    expect(hasLogin(manifest)).toBe(false)
    expect(manifest.egress).toEqual(['en.wikipedia.org'])
    expect(manifest.requests.every((r) => r.method === 'GET' && r.purpose === 'read')).toBe(true)
    expect(() => createAdapter()).not.toThrow()
  })
})

// As the app runs them: bundled, in the tool process's context, which has no URL or
// URLSearchParams. The first live run of Yahoo Finance failed every call on exactly that.
describe('in the tool process', () => {
  it('runs each tool against the captured responses', async () => {
    const script = await buildToolScript(new URL('../src/tools.ts', import.meta.url).pathname)
    const { ctx, fetched } = wiki({
      '/w/rest.php/v1/search/page': json(fixture('search-kangaroo.json')),
      '/api/rest_v1/page/summary/Red_kangaroo': json(fixture('summary-kangaroo.json')),
      '/w/api.php': json(fixture('extract-kangaroo.json')),
    })
    const found = (await runInToolContext(script, 'search_articles', { query: 'red kangaroo' }, ctx)) as {
      results: { title: string }[]
    }
    expect(found.results[0]?.title).toBe('Kangaroo')
    expect(await runInToolContext(script, 'get_summary', { title: 'Red kangaroo' }, ctx)).toMatchObject({
      url: expect.stringContaining('/wiki/'),
    })
    expect(
      await runInToolContext(script, 'get_article', { title: 'Kangaroo', maxChars: 1000 }, ctx),
    ).toMatchObject({ title: 'Kangaroo', truncated: true })
    expect(fetched[0]?.url.searchParams.get('q')).toBe('red kangaroo')
  })
})
