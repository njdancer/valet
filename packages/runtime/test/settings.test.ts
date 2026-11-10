// Adapter settings (D69): a value the person picks in the app from choices the adapter fetches.
// The tools that serve a setting are adapter code, so each test here is either the runtime doing its
// part (asking for a required value, applying one before a call) or something that must stay closed
// (a client reaching a setting's tool, a choices tool returning something that isn't choices).

import { defineAdapter, parseManifest, type ToolContext, tool } from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SETTING_REAPPLY_MS, SETTINGS_CLIENT } from '../src/tool-host'
import { json } from './fakes'
import { call, fixture, HOME, loggedOut, manifest, SESSION_URL } from './fixtures'

const STORES = [
  { value: '101', label: 'Town Hall', detail: '1 George St' },
  { value: '202', label: 'Harbourside' },
]

interface Bodies {
  readonly run?: (ctx: ToolContext) => Promise<unknown>
  readonly find?: (ctx: ToolContext, query: string) => Promise<unknown>
  readonly apply?: (ctx: ToolContext, value: string) => Promise<unknown>
  readonly required?: boolean
  readonly withApply?: boolean
}

function shop({ run, find, apply, required = true, withApply = true }: Bodies = {}) {
  return defineAdapter({
    manifest: parseManifest({
      ...manifest,
      requests: [...manifest.requests, { method: 'POST', path: '/api/store', purpose: 'write' }],
      tools: [
        ...manifest.tools,
        { name: 'find_stores', title: 'Find stores', description: 'Stores to pick from', sideEffect: 'read' },
        { name: 'apply_store', title: 'Use store', description: 'Shops at the store', sideEffect: 'write' },
      ],
      settings: {
        store: {
          title: 'Store',
          description: 'The store whose prices the tools quote.',
          required,
          choices: { tool: 'find_stores', queryLabel: 'Postcode' },
          ...(withApply ? { apply: { tool: 'apply_store' } } : {}),
        },
      },
    }),
    tools: {
      run_test: tool({
        input: z.object({}),
        output: z.unknown(),
        run: (ctx) => (run ?? (async () => 'ran'))(ctx),
      }),
      find_stores: tool({
        input: z.object({ query: z.string() }),
        output: z.unknown(),
        run: (ctx, input) => (find ?? (async () => ({ choices: STORES })))(ctx, input.query),
      }),
      apply_store: tool({
        input: z.object({ value: z.string().regex(/^\d+$/) }),
        output: z.unknown(),
        run: (ctx, input) =>
          (apply ?? (async (c, value) => c.page.fetch('/api/store', { method: 'POST', json: { value } })))(
            ctx,
            input.value,
          ),
      }),
    },
  })
}

/** A settings lookup over a plain object the test can change. */
function chosen(values: Record<string, string> = {}) {
  return { values, lookup: { values: async () => values } }
}

function shopFixture(bodies: Bodies = {}, values: Record<string, string> = { store: '101' }) {
  const settings = chosen(values)
  let next = 0
  const made = fixture(shop(bodies), {
    settings: settings.lookup,
    newCallId: () => {
      next += 1
      return `apply-${next}`
    },
  })
  made.page.route('POST', `${HOME}/api/store`, json({ ok: true }))
  return { ...made, values: settings.values }
}

const tools = (audit: { events: readonly { type: string }[] }) =>
  audit.events.flatMap((e) =>
    e.type === 'tool-called' ? [(e as unknown as { tool: string; client: string }).tool] : [],
  )

describe('a required setting with no value', () => {
  it('ends every tool call needsUser setting-required, before any run begins', async () => {
    const run = vi.fn(async () => 'ran')
    const { host, driver } = shopFixture({ run }, {})
    expect(await host.call(call)).toEqual({ status: 'needsUser', reason: 'setting-required' })
    expect(run).not.toHaveBeenCalled()
    expect(driver.runEvents).toEqual([])
  })

  it('treats a stored value that is not a value as none', async () => {
    const { host } = shopFixture({}, { store: '' })
    expect(await host.call(call)).toEqual({ status: 'needsUser', reason: 'setting-required' })
  })

  it('has no value when the host was given no settings', async () => {
    const { host } = fixture(shop())
    expect(await host.call(call)).toEqual({ status: 'needsUser', reason: 'setting-required' })
  })

  it('fails the call when the values cannot be read', async () => {
    const { host, driver } = fixture(shop(), {
      settings: {
        values: async () => {
          throw new Error('unreadable')
        },
      },
    })
    expect(await host.call(call)).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'internal' })
    expect(driver.runEvents).toEqual([])
  })

  it('runs a call when the setting is optional', async () => {
    const { host, page } = shopFixture({ required: false }, {})
    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ran' })
    expect(page.toolFetches()).toEqual([])
  })
})

describe('applying a setting', () => {
  it('runs the apply tool first, as a run of its own with its own policy and audit records', async () => {
    const order: string[] = []
    const { host, driver, audit } = shopFixture({
      run: async () => {
        order.push('tool')
        return 'ran'
      },
      apply: async (ctx, value) => {
        order.push(`apply:${value}`)
        await ctx.page.fetch('/api/store', { method: 'POST', json: { value } })
      },
    })
    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ran' })

    expect(order).toEqual(['apply:101', 'tool'])
    expect(driver.runEvents).toEqual(['begin', 'end', 'begin', 'end'])
    // The apply tool writes; the tool that was called only reads.
    expect(driver.policies.map((p) => p.maxPurpose)).toEqual(['write', 'read'])
    expect(audit.types()).toEqual(['tool-called', 'tool-called', 'tool-finished', 'tool-finished'])
    expect(audit.events[1]).toMatchObject({ tool: 'apply_store', client: SETTINGS_CLIENT, callId: 'apply-1' })
    expect(audit.events[2]).toMatchObject({ callId: 'apply-1', outcome: 'ok' })
    expect(audit.events[3]).toMatchObject({ callId: 'call-1', outcome: 'ok' })
  })

  it('applies once, then again only when the value changes', async () => {
    const { host, audit, values } = shopFixture()
    await host.call(call)
    await host.call({ ...call, callId: 'call-2' })
    expect(tools(audit)).toEqual(['run_test', 'apply_store', 'run_test'])

    values['store'] = '202'
    await host.call({ ...call, callId: 'call-3' })
    expect(tools(audit)).toEqual(['run_test', 'apply_store', 'run_test', 'run_test', 'apply_store'])
  })

  it('applies again once the last time is old', async () => {
    const { host, audit, clock } = shopFixture()
    await host.call(call)
    clock.advance(SETTING_REAPPLY_MS - 60_000)
    await host.call({ ...call, callId: 'call-2' })
    expect(tools(audit).filter((t) => t === 'apply_store')).toHaveLength(1)
    clock.advance(60_000)
    await host.call({ ...call, callId: 'call-3' })
    expect(tools(audit).filter((t) => t === 'apply_store')).toHaveLength(2)
  })

  it('applies again after a login step, which may have replaced the session', async () => {
    const { host, audit } = shopFixture()
    await host.call(call)
    await host.runLoginStep('example-shop', async () => {})
    await host.call({ ...call, callId: 'call-2' })
    expect(tools(audit).filter((t) => t === 'apply_store')).toHaveLength(2)
  })

  it('applies again after a call that logged in', async () => {
    const { host, audit, page } = shopFixture({
      run: async (ctx) => (await ctx.session.ensure()).status,
    })
    let probes = 0
    page.route('GET', SESSION_URL, () => {
      probes += 1
      return probes === 1 ? loggedOut : json({ shopper: { loggedIn: true } })
    })
    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ok' })
    await host.call({ ...call, callId: 'call-2' })
    expect(tools(audit).filter((t) => t === 'apply_store')).toHaveLength(2)
  })

  it('does not run the tool when the apply tool fails, and tries again on the next call', async () => {
    const run = vi.fn(async () => 'ran')
    let fail = true
    const { host, audit } = shopFixture({
      run,
      apply: async () => {
        if (fail) throw new Error('page text that must not leave')
      },
    })
    expect(await host.call(call)).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'internal' })
    expect(run).not.toHaveBeenCalled()

    fail = false
    expect(await host.call({ ...call, callId: 'call-2' })).toEqual({ status: 'ok', output: 'ran' })
    expect(tools(audit).filter((t) => t === 'apply_store')).toHaveLength(2)
  })

  it('asks the person to choose again when the adapter no longer accepts the stored value', async () => {
    const run = vi.fn(async () => 'ran')
    const { host, driver } = shopFixture({ run }, { store: 'not-a-number' })
    expect(await host.call(call)).toEqual({ status: 'needsUser', reason: 'setting-required' })
    expect(run).not.toHaveBeenCalled()
    expect(driver.runEvents).toEqual([])
  })

  it('holds the apply tool to the request surface like any tool', async () => {
    const run = vi.fn(async () => 'ran')
    const { host } = shopFixture({
      run,
      apply: async (ctx) => {
        await ctx.page.fetch('/api/checkout/place', { method: 'POST', json: {} })
      },
    })
    const result = await host.call(call)
    expect(result).toMatchObject({ status: 'failed', stage: 'request-surface' })
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps what the apply tool returns out of every result', async () => {
    const { host, audit } = shopFixture({ apply: async () => ({ note: 'from the site' }) })
    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ran' })
    expect(JSON.stringify(audit.events)).not.toContain('from the site')
  })

  it('stores a value without applying when the setting has no apply tool', async () => {
    const { host, audit } = shopFixture({ withApply: false })
    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ran' })
    expect(tools(audit)).toEqual(['run_test'])
  })
})

describe('a setting’s tools and MCP clients', () => {
  it('lists neither of them', async () => {
    const { host } = shopFixture()
    expect((await host.listTools()).map((t) => t.declaration.name)).toEqual(['run_test'])
  })

  it('refuses a client’s call to either as not found, without running it', async () => {
    const find = vi.fn(async () => ({ choices: STORES }))
    const apply = vi.fn(async () => undefined)
    const { host, driver } = shopFixture({ find, apply })
    for (const name of ['find_stores', 'apply_store']) {
      expect(await host.call({ ...call, tool: name, input: { query: '2000', value: '999' } })).toEqual({
        status: 'failed',
        stage: 'manifest',
        errorClass: 'not-found',
      })
    }
    expect(find).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(driver.runEvents).toEqual([])
  })
})

describe('settingChoices', () => {
  const ask = { adapterId: 'example-shop', setting: 'store', query: '2000', callId: 'choices-1' }

  it('returns the choices, with no value chosen yet, under a read-only run', async () => {
    const queries: string[] = []
    const find = async (_ctx: ToolContext, query: string) => {
      queries.push(query)
      return { choices: STORES }
    }
    const { host, driver, audit } = shopFixture({ find }, {})
    expect(await host.settingChoices(ask)).toEqual({ status: 'ok', choices: STORES })
    expect(queries).toEqual(['2000'])
    expect(driver.policies.map((p) => p.maxPurpose)).toEqual(['read'])
    expect(audit.events[0]).toMatchObject({ type: 'tool-called', tool: 'find_stores', client: SETTINGS_CLIENT })
  })

  it('does not apply the current value first', async () => {
    const { host, audit } = shopFixture()
    await host.settingChoices(ask)
    expect(tools(audit)).toEqual(['find_stores'])
  })

  it.each([
    ['not an object', 'stores'],
    ['a choice without a label', { choices: [{ value: '1' }] }],
    ['an extra field', { choices: [{ value: '1', label: 'A', html: '<b>' }] }],
    ['an over-long value', { choices: [{ value: 'x'.repeat(101), label: 'A' }] }],
    ['too many choices', { choices: Array.from({ length: 51 }, (_, i) => ({ value: `${i}`, label: 'A' })) }],
  ])('refuses %s', async (_name, output) => {
    const { host } = shopFixture({ find: async () => output })
    expect(await host.settingChoices(ask)).toEqual({
      status: 'failed',
      stage: 'tool-output',
      errorClass: 'invalid',
    })
  })

  it('answers not found for a setting the manifest does not declare', async () => {
    const { host } = shopFixture()
    for (const setting of ['postcode', 'constructor', '__proto__']) {
      expect(await host.settingChoices({ ...ask, setting })).toEqual({
        status: 'failed',
        stage: 'manifest',
        errorClass: 'not-found',
      })
    }
  })

  it('answers not granted for an adapter that is unknown or not approved', async () => {
    const { host } = shopFixture()
    expect(await host.settingChoices({ ...ask, adapterId: 'other' })).toMatchObject({ errorClass: 'not-granted' })
    const unapproved = fixture(shop(), { approvals: { isApproved: async () => false } })
    expect(await unapproved.host.settingChoices(ask)).toMatchObject({ errorClass: 'not-granted' })
  })

  it('passes on a failure as its stage and class only', async () => {
    const { host } = shopFixture({
      find: async () => {
        throw new Error('page text')
      },
    })
    expect(await host.settingChoices(ask)).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'internal' })
  })
})
