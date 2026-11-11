// The session read cache (D28) and the minute a write may rest on the last login check, through the
// real tool host: what is answered from memory, and everything that makes the host forget.

import {
  type AdapterManifest,
  defineAdapter,
  type FetchInit,
  parseManifest,
  type ToolContext,
  tool,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { json } from './fakes'
import { COOKIE, call, fixture, HOME, loggedIn, loggedOut, manifest, SESSION_URL } from './fixtures'

const TROLLEY = `${HOME}/api/trolley`
const UPDATE = `${HOME}/api/trolley/update`
const SEARCH = `${HOME}/api/search`

type Tools = AdapterManifest['tools']

function cachingManifest(tools: Tools = manifest.tools, trustSeconds?: number): AdapterManifest {
  return parseManifest({
    ...manifest,
    session: {
      ...manifest.session,
      probe: { ...manifest.session.probe, ...(trustSeconds === undefined ? {} : { trustSeconds }) },
    },
    requests: [
      { method: 'GET', path: '/api/trolley', purpose: 'read', cacheSeconds: 120 },
      { method: 'POST', path: '/api/trolley/update', purpose: 'write', refreshes: '/api/trolley' },
      { method: 'POST', path: '/api/trolley/clear', purpose: 'write' },
      { method: 'POST', path: '/api/search', purpose: 'read', cacheSeconds: 900 },
      { method: 'GET', path: '/api/orders', purpose: 'read' },
    ],
    tools,
  })
}

const WRITE_TOOL: Tools = [
  { name: 'run_test', title: 'Run test', description: 'The tool under test', sideEffect: 'write' },
]

type Step = readonly [path: string, init?: FetchInit]

/** A tool that makes the fetches its input lists, in order, and returns what came back. */
function fetcher(adapterManifest: AdapterManifest, before?: (ctx: ToolContext) => Promise<unknown>) {
  return defineAdapter({
    manifest: adapterManifest,
    tools: {
      run_test: tool({
        input: z.object({ steps: z.array(z.tuple([z.string(), z.any().optional()])) }),
        output: z.unknown(),
        run: async (ctx, input) => {
          if (before !== undefined) await before(ctx)
          const results: unknown[] = []
          for (const [path, init] of input.steps) results.push(await ctx.page.fetch(path, init))
          return results
        },
      }),
    },
  })
}

function setup(definition = fetcher(cachingManifest())) {
  const f = fixture(definition)
  let calls = 0
  const run = (...steps: Step[]) =>
    f.host.call({ ...call, callId: `call-${++calls}`, input: { steps: steps.map((s) => [...s]) } })
  const sent = () => f.page.fetches.map((x) => `${(x.init?.method ?? 'GET').toUpperCase()} ${x.url}`)
  return { ...f, run, sent }
}

const GET_TROLLEY: Step = ['/api/trolley']
const milk = { items: [{ name: 'Milk', quantity: 2 }] }

describe('the session read cache', () => {
  it('answers a declared read again from memory: nothing sent, nothing paced, and marked as cached', async () => {
    const { run, sent, clock } = setup()

    const first = await run(GET_TROLLEY)
    const second = await run(GET_TROLLEY, GET_TROLLEY)

    expect(first).toEqual({ status: 'ok', output: [json(milk)] })
    expect(second).toEqual({
      status: 'ok',
      output: [
        { ...json(milk), fromCache: true },
        { ...json(milk), fromCache: true },
      ],
    })
    expect(sent()).toEqual([`GET ${TROLLEY}`])
    expect(clock.paced).toEqual([])
  })

  it('gives each caller its own copy', async () => {
    const definition = defineAdapter({
      manifest: cachingManifest(),
      tools: {
        run_test: tool({
          input: z.object({}),
          output: z.unknown(),
          run: async (ctx) => {
            const one = await ctx.page.fetch('/api/trolley')
            ;(one.body as { items: unknown[] }).items.length = 0
            return (await ctx.page.fetch('/api/trolley')).body
          },
        }),
      },
    })
    const { host } = fixture(definition)
    expect(await host.call(call)).toEqual({ status: 'ok', output: milk })
  })

  it('asks the site again once the declared time has passed', async () => {
    const { run, sent, clock } = setup()
    await run(GET_TROLLEY)
    await clock.advance(119_000)
    await run(GET_TROLLEY)
    expect(sent()).toHaveLength(1)
    await clock.advance(1_000)
    await run(GET_TROLLEY)
    expect(sent()).toHaveLength(2)
  })

  it('asks the site when the tool says reload, and keeps the new answer', async () => {
    const { run, sent, page } = setup()
    await run(GET_TROLLEY)
    page.route('GET', TROLLEY, json({ items: [] }))
    const reloaded = await run(['/api/trolley', { cache: 'reload' }], GET_TROLLEY)
    expect(reloaded).toEqual({
      status: 'ok',
      output: [json({ items: [] }), { ...json({ items: [] }), fromCache: true }],
    })
    expect(sent()).toEqual([`GET ${TROLLEY}`, `GET ${TROLLEY}`])
    // The guard and the driver never see the cache field.
    expect(page.fetches[1]?.init).toEqual({ method: 'GET', headers: {} })
  })

  it('never keeps a read the manifest did not say to keep, or one sent with headers', async () => {
    const { run, sent, page } = setup()
    page.route('GET', `${HOME}/api/orders`, json({ orders: [] }))
    await run(['/api/orders'], ['/api/orders'])
    await run(
      ['/api/trolley', { headers: { 'x-view': 'full' } }],
      ['/api/trolley', { headers: { 'x-view': 'full' } }],
    )
    expect(sent()).toEqual([
      `GET ${HOME}/api/orders`,
      `GET ${HOME}/api/orders`,
      `GET ${TROLLEY}`,
      `GET ${TROLLEY}`,
    ])
  })

  it('keeps a POST read by its body', async () => {
    const { run, sent, page } = setup()
    page.route('POST', SEARCH, (_url, init) => json({ found: (init as { json: { q: string } }).json.q }))
    const search = (q: string): Step => ['/api/search', { method: 'POST', json: { q } }]
    const result = await run(search('milk'), search('bread'), search('milk'))
    expect(result).toEqual({
      status: 'ok',
      output: [
        json({ found: 'milk' }),
        json({ found: 'bread' }),
        { ...json({ found: 'milk' }), fromCache: true },
      ],
    })
    expect(sent()).toEqual([`POST ${SEARCH}`, `POST ${SEARCH}`])
  })

  it('keeps only a 2xx JSON object', async () => {
    const { run, sent, page } = setup()
    for (const answer of [
      json({ error: 'down' }, 503),
      { status: 200, contentType: 'text/plain', body: 'ok' },
      json('just text'),
      json(null),
    ]) {
      page.route('GET', TROLLEY, answer)
      await run(['/api/trolley', { headers: { accept: 'text/plain, application/json' } }])
      await run(GET_TROLLEY)
    }
    // Every one of them was asked for again.
    expect(sent()).toHaveLength(8)
  })

  it('does not count a cached answer against the run’s request ceiling', async () => {
    const { run, sent } = setup()
    await run(GET_TROLLEY)
    const many = await run(...Array.from({ length: 12 }, () => GET_TROLLEY))
    expect(many.status).toBe('ok')
    expect(sent()).toHaveLength(1)
  })

  it('redacts a cached answer against the session values of the call that stored it', async () => {
    const { run, page, driver } = setup()
    page.route('GET', TROLLEY, json({ token: COOKIE }))
    expect(await run(GET_TROLLEY)).toEqual({ status: 'ok', output: [json({ token: '[redacted]' })] })
    // The site rotates the cookie; the old value is still not something a client should see.
    driver.cookieValues = ['sess-rotated-000000']
    expect(await run(GET_TROLLEY)).toEqual({
      status: 'ok',
      output: [{ ...json({ token: '[redacted]' }), fromCache: true }],
    })
  })
})

describe('requests the cache does not understand', () => {
  it('leaves an init it cannot read to the guard, which refuses it, and keeps nothing', async () => {
    const definition = defineAdapter({
      manifest: cachingManifest(),
      tools: {
        run_test: tool({
          input: z.object({ bad: z.boolean() }),
          output: z.unknown(),
          run: async (ctx, input) => {
            const init = input.bad ? ({ method: 7 } as unknown as FetchInit) : undefined
            return (await ctx.page.fetch('/api/trolley', init)).fromCache ?? false
          },
        }),
      },
    })
    const { host, page } = fixture(definition)
    const run = (bad: boolean, callId: string) => host.call({ ...call, callId, input: { bad } })
    expect(await run(false, 'a')).toEqual({ status: 'ok', output: false })
    expect(await run(true, 'b')).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'undeclared-request',
    })
    expect(await run(false, 'c')).toEqual({ status: 'ok', output: false })
    expect(page.fetches).toHaveLength(2)
  })

  it('reads the tool’s init once, so the guard checks exactly the request the cache looked at', async () => {
    const definition = defineAdapter({
      manifest: cachingManifest(),
      tools: {
        run_test: tool({
          input: z.object({}),
          output: z.unknown(),
          run: async (ctx) => {
            let reads = 0
            const init = {
              get method() {
                return reads++ === 0 ? 'GET' : 'POST'
              },
            }
            await ctx.page.fetch('/api/trolley', init)
            return reads
          },
        }),
      },
    })
    const { host, page } = fixture(definition)
    expect(await host.call(call)).toEqual({ status: 'ok', output: 1 })
    expect(page.fetches.map((f) => f.init?.method)).toEqual(['GET'])
  })
})

describe('what makes the read cache forget', () => {
  const writing = () => setup(fetcher(cachingManifest(WRITE_TOOL)))
  const update: Step = ['/api/trolley/update', { method: 'POST', json: { stockcode: 1, quantity: 3 } }]

  it('a write: its own reply becomes the read it says it answers', async () => {
    const { run, sent, page } = writing()
    const after = { items: [{ name: 'Milk', quantity: 3 }] }
    page.route('POST', UPDATE, json(after))
    const result = await run(GET_TROLLEY, update, GET_TROLLEY)
    expect(result).toEqual({
      status: 'ok',
      output: [json(milk), json(after), { ...json(after), fromCache: true }],
    })
    expect(sent()).toEqual([`GET ${TROLLEY}`, `POST ${UPDATE}`])
  })

  it('a write that names no read, or whose reply is not a 2xx JSON object, leaves nothing behind', async () => {
    const { run, sent, page } = writing()
    page.route('POST', `${HOME}/api/trolley/clear`, json({ ok: true }))
    await run(GET_TROLLEY, ['/api/trolley/clear', { method: 'POST' }], GET_TROLLEY)
    expect(sent()).toEqual([`GET ${TROLLEY}`, `POST ${HOME}/api/trolley/clear`, `GET ${TROLLEY}`])

    page.route('POST', UPDATE, json({ error: 'no' }, 500))
    await run(update, GET_TROLLEY)
    expect(sent().slice(3)).toEqual([`POST ${UPDATE}`, `GET ${TROLLEY}`])
  })

  it('a write the site never answered: the cache was emptied before it was sent', async () => {
    const { run, sent, page } = writing()
    await run(GET_TROLLEY)
    page.route('POST', UPDATE, () => {
      throw new Error('connection reset')
    })
    expect((await run(update)).status).toBe('failed')
    await run(GET_TROLLEY)
    expect(sent()).toEqual([`GET ${TROLLEY}`, `POST ${UPDATE}`, `GET ${TROLLEY}`])
  })

  it('a write a read tool may not make: refused by the guard as before, and nothing is kept', async () => {
    const { run, sent, audit } = setup()
    await run(GET_TROLLEY)
    expect(await run(update)).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'denied-path',
    })
    expect(audit.types().filter((t) => t === 'request-blocked')).toHaveLength(1)
    await run(GET_TROLLEY)
    expect(sent()).toEqual([`GET ${TROLLEY}`, `GET ${TROLLEY}`])
  })

  it('a call that ends any way but ok', async () => {
    const { run, sent } = setup()
    await run(GET_TROLLEY)
    expect((await run(GET_TROLLEY, ['/api/not-declared'])).status).toBe('failed')
    await run(GET_TROLLEY)
    expect(sent()).toEqual([`GET ${TROLLEY}`, `GET ${TROLLEY}`])
  })

  it('a login', async () => {
    let loggedInNow = true
    const { run, sent, page, authRunner } = setup(fetcher(cachingManifest(), (ctx) => ctx.session.ensure()))
    page.route('GET', SESSION_URL, () => (loggedInNow ? loggedIn : loggedOut))
    await run(GET_TROLLEY)
    await run(GET_TROLLEY)
    expect(sent().filter((r) => r === `GET ${TROLLEY}`)).toHaveLength(1)

    loggedInNow = false
    authRunner.mockImplementation(async () => {
      loggedInNow = true
      return { status: 'ok' }
    })
    await run(GET_TROLLEY)
    expect(authRunner).toHaveBeenCalledTimes(1)
    expect(sent().filter((r) => r === `GET ${TROLLEY}`)).toHaveLength(2)
  })

  it('click() and evaluate(), which can change the site out of the cache’s sight', async () => {
    for (const act of [
      (ctx: ToolContext) => ctx.page.click('#go'),
      (ctx: ToolContext) => ctx.page.evaluate('1'),
    ]) {
      const { run, sent } = setup(fetcher(cachingManifest(), act))
      await run(GET_TROLLEY)
      await run(GET_TROLLEY)
      expect(sent()).toEqual([`GET ${TROLLEY}`, `GET ${TROLLEY}`])
    }
  })

  it('a login step the person drives', async () => {
    const { run, sent, host } = setup()
    await run(GET_TROLLEY)
    await host.runLoginStep('example-shop', async () => {})
    await run(GET_TROLLEY)
    expect(sent()).toEqual([`GET ${TROLLEY}`, `GET ${TROLLEY}`])
  })
})

describe('resting on the last login check', () => {
  const probes = (sent: string[]) => sent.filter((r) => r === `GET ${SESSION_URL}`).length
  const ensuring = (tools: Tools, trustSeconds: number | undefined, times = 1) =>
    setup(
      fetcher(cachingManifest(tools, trustSeconds), async (ctx) => {
        for (let i = 0; i < times; i++) await ctx.session.ensure()
      }),
    )

  it('a write tool skips the probe for the manifest’s trustSeconds after a "logged in" answer, no longer', async () => {
    const { run, sent, clock } = ensuring(WRITE_TOOL, 60)
    await run()
    await clock.advance(59_000)
    await run()
    expect(probes(sent())).toBe(1)
    await clock.advance(1_000)
    await run()
    expect(probes(sent())).toBe(2)
    // The window runs from the probe, not from the last call that rested on it.
    await clock.advance(59_000)
    await run()
    expect(probes(sent())).toBe(2)
  })

  it('never without trustSeconds, and never for a read tool or an irreversible one', async () => {
    const irreversible: Tools = [{ ...WRITE_TOOL[0], sideEffect: 'irreversible' } as Tools[number]]
    for (const [tools, trust] of [
      [WRITE_TOOL, undefined],
      [WRITE_TOOL, 0],
      [manifest.tools, 60],
      [irreversible, 60],
    ] as const) {
      const { run, sent } = ensuring(tools, trust)
      expect((await run()).status).toBe('ok')
      expect((await run()).status).toBe('ok')
      expect(probes(sent()), `${tools[0]?.sideEffect} ${trust}`).toBe(2)
    }
  })

  it('a second ensure() in one call always probes: the tool met a logged-out answer', async () => {
    const { run, sent } = ensuring(WRITE_TOOL, 60, 2)
    await run()
    expect(probes(sent())).toBe(2)
    await run()
    expect(probes(sent())).toBe(3)
  })

  it('probes when the page has been left on another origin, where its requests carry no session', async () => {
    const { run, sent, page } = ensuring(WRITE_TOOL, 60)
    await run()
    page.url = 'https://cdn.example.com/somewhere'
    await run()
    expect(probes(sent())).toBe(2)
  })

  it('probes after a call that ended any way but ok, and after a login step the person drives', async () => {
    const { run, sent, host } = ensuring(WRITE_TOOL, 60)
    await run()
    expect((await run(['/api/not-declared'])).status).toBe('failed')
    expect(probes(sent())).toBe(1)
    await run()
    expect(probes(sent())).toBe(2)
    await host.runLoginStep('example-shop', async () => {})
    await run()
    expect(probes(sent())).toBe(3)
  })

  it('after a login, rests on the login’s own re-probe', async () => {
    let loggedInNow = true
    const { run, sent, page, authRunner, clock } = ensuring(WRITE_TOOL, 60)
    page.route('GET', SESSION_URL, () => (loggedInNow ? loggedIn : loggedOut))
    await run()
    await clock.advance(60_000)
    loggedInNow = false
    authRunner.mockImplementation(async () => {
      loggedInNow = true
      return { status: 'ok' }
    })
    // Logged out, the login, logged in.
    await run()
    expect(probes(sent())).toBe(3)
    await run()
    expect(probes(sent())).toBe(3)
    expect(authRunner).toHaveBeenCalledTimes(1)
  })
})
