// The site's hourly cap (D28) at the tool host: asked about when a call starts, never during one.

import { defineAdapter, parseManifest, tool } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { call, fixture, HOME, manifest } from './fixtures'

const HOUR = 3_600_000
const TROLLEY = `GET ${HOME}/api/trolley`

/** Three reads of the trolley a call, at the fixture's 1 s gap, under a cap of ten an hour. */
function setup(sideEffect: 'read' | 'irreversible' = 'read') {
  const definition = defineAdapter({
    manifest: parseManifest({
      ...manifest,
      tools: [{ ...manifest.tools[0], sideEffect }],
      limits: { ...manifest.limits, requestsPerHour: 10 },
    }),
    tools: {
      run_test: tool({
        input: z.object({}),
        output: z.number(),
        run: async (ctx) => {
          for (let i = 0; i < 3; i++) await ctx.page.fetch('/api/trolley')
          return 3
        },
      }),
    },
  })
  const f = fixture(definition)
  let calls = 0
  const run = () => f.host.call({ ...call, callId: `call-${++calls}` })
  const sent = () => f.page.fetches.filter((x) => `GET ${x.url}` === TROLLEY).length
  return { ...f, run, sent }
}

describe('the hourly cap', () => {
  it('lets a call that starts under the cap finish over it, then refuses the next with a time to try again', async () => {
    const { run, sent, clock, audit } = setup()
    const started = clock.now()
    for (let i = 0; i < 4; i++) expect(await run()).toEqual({ status: 'ok', output: 3 })
    // The fourth call started with nine sent and one left, and sent its three.
    expect(sent()).toBe(12)

    const refused = await run()
    // Room again when the third request, sent 2 s in, is an hour old: twelve less ten leaves two out.
    expect(refused).toEqual({
      status: 'blocked',
      retryAfterMs: started + 2_000 + HOUR - clock.now(),
      cause: 'hourly-cap',
    })
    expect(sent()).toBe(12)
    // In the log, `blocked` is the site refusing us. This is our own budget.
    expect(audit.events.at(-1)).toMatchObject({
      type: 'tool-finished',
      callId: 'call-5',
      outcome: 'failed',
      stage: 'tool-run',
      errorClass: 'rate-limited',
    })
  })

  it('has room again once enough of the hour’s requests are an hour old', async () => {
    const { run, sent, clock } = setup()
    for (let i = 0; i < 4; i++) await run()
    const refused = await run()
    if (refused.status !== 'blocked') throw new Error('expected the cap to refuse')
    await clock.advance(refused.retryAfterMs - 1)
    expect((await run()).status).toBe('blocked')
    await clock.advance(1)
    expect(await run()).toEqual({ status: 'ok', output: 3 })
    expect(sent()).toBe(15)
  })

  it('refuses before the person is asked to confirm anything', async () => {
    const { run, prompt } = setup('irreversible')
    for (let i = 0; i < 4; i++) expect((await run()).status).toBe('ok')
    expect(prompt.requests).toHaveLength(4)
    expect(await run()).toMatchObject({ status: 'blocked', cause: 'hourly-cap' })
    expect(prompt.requests).toHaveLength(4)
  })

  it('leaves the site’s breaker alone, and never holds up a login step the person drives', async () => {
    const { run, host } = setup()
    for (let i = 0; i < 4; i++) await run()
    expect((await run()).status).toBe('blocked')
    const [health] = await host.siteHealth()
    expect(health?.breaker).toBe('closed')
    await expect(host.runLoginStep('example-shop', async () => 'done')).resolves.toBe('done')
  })
})

describe('a live trial’s guards', () => {
  it('are the installed adapter’s own for its host, and fresh defaults for any other', async () => {
    const { run, host } = setup()
    for (let i = 0; i < 4; i++) await run()
    const shared = host.siteGuards(new URL(HOME).hostname.toUpperCase())
    // The installed adapter spent the hour's budget; a trial on its site waits on the same one.
    expect(shared.budget.waitMs()).toBeGreaterThan(0)
    expect((await run()).status).toBe('blocked')
    const other = host.siteGuards('elsewhere.test')
    expect(other).not.toBe(shared)
    expect(other.budget.gapMs).toBe(2000)
    expect(host.siteGuards('elsewhere.test')).toBe(other)
  })
})
