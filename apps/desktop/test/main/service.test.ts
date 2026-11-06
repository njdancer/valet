// @vitest-environment node
// The whole main-process wiring in plain Node: the real runtime, stores, audit log and auth flow,
// with a fake driver, the test credential provider, a stand-in endpoint and a recording UI.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiteAdapterError } from '@siteadapter/core'
import type { RunningEndpoint, ToolCaller } from '@siteadapter/mcp-server'
import { LoginAttemptMarker } from '@siteadapter/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { dataPaths } from '../../src/main/core/constants'
import { disabledOtpReader } from '../../src/main/core/credentials'
import { DEMO_ACCOUNT, demoCredentials } from '../../src/main/core/demo'
import { builtinAdapter } from '../../src/main/core/registry'
import { AppService, fillSelector } from '../../src/main/core/service'
import type { AppEvent, ConfirmationItem, HashRoute } from '../../src/shared/api'
import { CONFIRM_ARM_MS } from '../../src/shared/api'
import { FakeDriver, SHOP, SHOP_FILES, shopDefinition } from './fixtures'

const TOKEN = 't'.repeat(43)
const dirs: string[] = []
const services: AppService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup(options: { checkOp?: (path: string) => Promise<string | null> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sa-service-'))
  dirs.push(dir)
  const paths = dataPaths(join(dir, 'data'))
  let now = Date.parse('2026-11-07T00:00:00.000Z')
  const driver = new FakeDriver()
  const adapter = builtinAdapter(shopDefinition(), SHOP_FILES)
  const events: AppEvent[] = []
  const ui = {
    clipboard: [] as string[],
    shownConfirmations: [] as string[],
    closedConfirmations: [] as string[],
    banners: [] as string[],
    panels: [] as (HashRoute | null)[],
    loginItem: [] as boolean[],
    quits: 0,
    saveTo: null as string | null,
    opChoice: null as string | null,
  }
  const endpoint = {
    caller: null as ToolCaller | null,
    refreshes: 0,
    resets: 0,
    closes: 0,
    starts: 0,
  }
  const service = new AppService({
    paths,
    version: '0.1.0',
    demo: true,
    now: () => now,
    timers: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    sleep: async () => {},
    adapters: [adapter],
    createDriver: async () => driver,
    credentials: demoCredentials(disabledOtpReader),
    startEndpoint: async (caller): Promise<RunningEndpoint> => {
      endpoint.caller = caller
      endpoint.starts++
      writeFileSync(paths.bridgeConfig, JSON.stringify({ url: 'http://127.0.0.1:47000/mcp', token: TOKEN }))
      return {
        url: 'http://127.0.0.1:47000/mcp',
        port: 47000,
        token: TOKEN,
        refresh: () => {
          endpoint.refreshes++
          return []
        },
        resetToken: async () => {
          endpoint.resets++
        },
        close: async () => {
          endpoint.closes++
        },
      }
    },
    ui: {
      writeClipboard: (text) => ui.clipboard.push(text),
      chooseSaveFile: async () => ui.saveTo,
      chooseOpFile: async () => ui.opChoice,
      openControlPanel: (route) => ui.panels.push(route),
      showConfirmation: (id) => ui.shownConfirmations.push(id),
      closeConfirmation: (id) => ui.closedConfirmations.push(id),
      showNeedsUser: (id) => ui.banners.push(`show ${id}`),
      closeNeedsUser: (id) => ui.banners.push(`close ${id}`),
      setLaunchAtLogin: (on) => ui.loginItem.push(on),
      quit: () => ui.quits++,
    },
    emit: (event) => events.push(event),
    probeFallback: () => null,
    bridge: { command: '/repo/tsx', args: ['/repo/bridge-cli.ts', paths.bridgeConfig] },
    checkOp: options.checkOp ?? (async (path) => (path === '/good/op' ? path : null)),
  })
  services.push(service)
  await service.start()
  const api = service.api
  const call = (
    tool: string,
    input: unknown,
    client = 'Claude Code',
    callId = `call_${tool}_${Math.random().toString(36).slice(2)}`,
  ) => (endpoint.caller as ToolCaller).call({ adapterId: 'shop', tool, input, client, callId })
  return {
    service,
    api,
    adapter,
    driver,
    ui,
    endpoint,
    events,
    paths,
    call,
    advance: (ms: number) => {
      now += ms
    },
  }
}

async function approved() {
  const s = await setup()
  await s.api.approvals.approve('shop', s.adapter.hash)
  return s
}

describe('first run', () => {
  it('shows the adapter pending review, and runs nothing until it is approved', async () => {
    const s = await setup()
    expect((await s.api.adapters.list()).map((a) => a.approval)).toEqual(['unapproved'])
    expect((await s.api.attention.list()).map((i) => i.kind)).toEqual(['review'])
    const [review] = await s.api.approvals.pending()
    expect(review?.to).toEqual({ version: '1.0.0', hash: s.adapter.hash })
    expect(review?.from).toBeNull()
    expect(s.endpoint.caller?.listTools()).toEqual([])
    expect(await s.call('echo', { text: 'hi' })).toEqual({
      status: 'failed',
      stage: 'manifest',
      errorClass: 'not-granted',
    })
    expect(await s.api.endpoint.status()).toMatchObject({
      listening: true,
      url: 'http://127.0.0.1:47000/mcp',
    })
  })

  it('refuses to approve any hash but the one waiting, and approves that one with an audit record', async () => {
    const s = await setup()
    await expect(s.api.approvals.approve('shop', 'f'.repeat(64))).rejects.toThrow()
    await expect(s.api.approvals.approve('nope', s.adapter.hash)).rejects.toThrow()
    await s.api.approvals.approve('shop', s.adapter.hash)
    expect((await s.api.adapters.list())[0]?.approval).toBe('approved')
    expect(await s.api.approvals.pending()).toEqual([])
    expect(s.endpoint.caller?.listTools().map((t) => t.declaration.name)).toEqual(['echo', 'add'])
    expect(s.endpoint.refreshes).toBeGreaterThanOrEqual(2)
    const page = await s.api.audit.page({ category: 'approvals-grants' })
    expect(page.records.map((r) => r.event)).toEqual([
      {
        type: 'adapter-approved',
        adapterId: 'shop',
        adapterHash: s.adapter.hash,
        version: '1.0.0',
        previousHash: null,
      },
    ])
    expect(s.events).toContainEqual({ type: 'approvals-changed' })
    expect(s.events.some((e) => e.type === 'audit-appended')).toBe(true)
    expect((await s.api.adapters.get('shop'))?.approvedAt).toBe('2026-11-07T00:00:00.000Z')
    expect(await s.api.adapters.get('nope')).toBeNull()
  })

  it('records a rejection and leaves the adapter off', async () => {
    const s = await setup()
    await expect(s.api.approvals.reject('shop', 'f'.repeat(64))).rejects.toThrow()
    await s.api.approvals.reject('shop', s.adapter.hash)
    expect((await s.api.adapters.list())[0]?.approval).toBe('rejected')
    expect(await s.api.attention.list()).toEqual([])
  })
})

describe('an update', () => {
  it('needs a fresh approval and fresh grants, and is reviewed against the last approved bundle', async () => {
    const first = await approved()
    await first.api.grants.make({
      adapterId: 'shop',
      adapterHash: first.adapter.hash,
      secret: 'login',
      provider: 'fake',
      itemRef: 'demo-woolworths',
      origins: ['https://login.shop.test'],
    })
    await first.service.stop()
    // The same data directory, a changed bundle.
    const next = builtinAdapter(shopDefinition({ ...SHOP, version: '1.1.0' }), {
      ...SHOP_FILES,
      'src/index.ts': 'v2\n',
    })
    const restarted = new AppService({
      ...(first.service as unknown as { deps: ConstructorParameters<typeof AppService>[0] }).deps,
      adapters: [next],
    })
    services.push(restarted)
    await restarted.start()
    const [summary] = await restarted.api.adapters.list()
    expect(summary?.approval).toBe('unapproved')
    expect(summary?.pendingUpdate).toEqual({ version: '1.1.0', hash: next.hash })
    expect(summary?.secrets).toEqual([{ name: 'login', granted: false }])
    const [review] = await restarted.api.approvals.pending()
    expect(review?.from).toEqual({ version: '1.0.0', hash: first.adapter.hash })
    expect(review?.files).toEqual([{ path: 'src/index.ts', status: 'modified', added: 1, removed: 1 }])
    await restarted.api.approvals.approve('shop', next.hash)
    const page = await restarted.api.audit.page({ category: 'approvals-grants', limit: 1 })
    expect(page.records[0]?.event).toMatchObject({
      type: 'adapter-approved',
      previousHash: first.adapter.hash,
      version: '1.1.0',
    })
    expect((await restarted.api.adapters.list())[0]?.secrets).toEqual([{ name: 'login', granted: false }])
  })
})

describe('grants', () => {
  it('makes a checked grant with an audit record, lists it by title, and revokes it', async () => {
    const s = await approved()
    const request = {
      adapterId: 'shop',
      adapterHash: s.adapter.hash,
      secret: 'login',
      provider: 'fake' as const,
      itemRef: 'demo-woolworths',
      origins: ['https://login.shop.test'],
    }
    await expect(s.api.grants.make({ ...request, origins: ['https://evil.test'] })).rejects.toThrow()
    await expect(s.api.grants.make({ ...request, provider: 'onepassword-cli' })).rejects.toThrow()
    await expect(s.api.grants.make({ ...request, adapterHash: 'c'.repeat(64) })).rejects.toThrow()
    await s.api.grants.make(request)
    expect(await s.api.grants.list()).toEqual([
      expect.objectContaining({
        itemId: 'demo-woolworths',
        itemTitle: 'Woolworths (demo account)',
        provider: 'fake',
      }),
    ])
    expect((await s.api.grants.providers()).find((p) => p.kind === 'fake')?.grantCount).toBe(1)
    expect(await s.api.grants.vaultItems('fake')).toEqual([
      { id: 'demo-woolworths', title: 'Woolworths (demo account)' },
    ])
    await s.api.grants.make({ ...request, secret: 'messages', provider: 'messages', itemRef: 'ShopBank' })
    expect((await s.api.adapters.get('shop'))?.messages[0]?.grant?.itemTitle).toBe('ShopBank')
    await expect(s.api.grants.revoke('shop', 'bank')).rejects.toThrow()
    await s.api.grants.revoke('shop', 'login')
    const page = await s.api.audit.page({ category: 'approvals-grants' })
    expect(page.records.map((r) => r.event.type)).toEqual([
      'grant-revoked',
      'grant-made',
      'grant-made',
      'adapter-approved',
    ])
    expect(page.records[2]?.event).toEqual({
      type: 'grant-made',
      adapterId: 'shop',
      adapterHash: s.adapter.hash,
      secret: 'login',
      provider: 'fake',
      origins: ['https://login.shop.test'],
    })
  })
})

describe('a grant and the runtime’s login hold', () => {
  const request = (s: Awaited<ReturnType<typeof approved>>) => ({
    adapterId: 'shop',
    adapterHash: s.adapter.hash,
    secret: 'login',
    provider: 'fake' as const,
    itemRef: 'demo-woolworths',
    origins: ['https://login.shop.test'],
  })
  const markers = (s: Awaited<ReturnType<typeof approved>>) =>
    new LoginAttemptMarker(s.paths.loginMarkers, { now: () => Date.parse('2026-11-07T00:00:00.000Z') })

  it('releases a hold left by a login that couldn’t fill or was refused: granting is the person acting', async () => {
    const s = await approved()
    await markers(s).hold('shop', 1, Date.parse('2026-11-07T01:00:00.000Z'))
    await s.api.grants.make(request(s))
    expect(await markers(s).read('shop')).toEqual({ kind: 'unset' })

    await markers(s).hold('shop', 2, null, 'login-required')
    await s.api.grants.make(request(s))
    expect(await markers(s).read('shop')).toEqual({ kind: 'unset' })
  })

  it('keeps a hold no grant can fix, an unfinished attempt, and any hold while the login window is open', async () => {
    const s = await approved()
    for (const reason of ['account-locked', 'captcha', 'terms-update', 'site-changed'] as const) {
      await markers(s).hold('shop', 1, null, reason)
      await s.api.grants.make(request(s))
      expect(await markers(s).read('shop'), reason).toMatchObject({ kind: 'held', reason })
    }
    await markers(s).set('shop', 'call_1')
    await s.api.grants.make(request(s))
    expect(await markers(s).read('shop')).toEqual({ kind: 'in-progress' })

    await markers(s).clear('shop')
    await s.api.openLoginWindow('shop')
    await markers(s).hold('shop', 1, null, 'login-required')
    await s.api.grants.make(request(s))
    expect(await markers(s).read('shop')).toMatchObject({ kind: 'held', reason: 'login-required' })
  })
})

describe('tool calls', () => {
  it('runs an approved tool and shows the run with its input and output', async () => {
    const s = await approved()
    const result = await s.call('echo', { text: 'hello' }, 'Claude Code', 'call_one')
    expect(result).toEqual({ status: 'ok', output: { text: 'hello' } })
    const [run] = await s.api.runs.list()
    expect(run).toMatchObject({
      callId: 'call_one',
      tool: 'echo',
      outcome: 'ok',
      client: 'Claude Code',
      sideEffect: 'read',
    })
    const trace = await s.api.runs.trace('call_one')
    expect(JSON.stringify(trace?.input)).toContain('hello')
    expect(trace?.output).not.toBeNull()
    expect(await s.api.runs.trace('call_none')).toBeNull()
    expect((await s.api.runs.statsToday()).toolCalls).toBe(1)
    expect((await s.api.clients.list()).map((c) => [c.reportedName, c.calls7d])).toEqual([['Claude Code', 1]])
    expect((await s.api.endpoint.status()).connectedClients).toBe(1)
  })

  it('refuses every call while paused, and calls under a revoked name, and audits both', async () => {
    const s = await approved()
    await s.api.app.setPaused(true)
    expect(await s.api.app.status()).toEqual({ paused: true, version: '0.1.0', demo: true })
    // The app's refusal, not the site's: no rate limit, and the stage says it was the app's config.
    expect(await s.call('echo', { text: 'x' }, 'Claude Code', 'call_paused')).toEqual({
      status: 'failed',
      stage: 'config',
      errorClass: 'unavailable',
    })
    expect(s.driver.runs).toBe(0)
    await s.api.app.setPaused(false)
    expect((await s.call('echo', { text: 'x' })).status).toBe('ok')
    const [client] = await s.api.clients.list()
    await s.api.clients.revoke(client?.id as string)
    await expect(s.api.clients.revoke('c_0000000000000000')).rejects.toThrow()
    expect(await s.call('echo', { text: 'x' }, 'Claude Code', 'call_revoked')).toEqual({
      status: 'failed',
      stage: 'config',
      errorClass: 'not-granted',
    })
    expect((await s.call('echo', { text: 'x' }, 'Another')).status).toBe('ok')

    const page = await s.api.audit.page({ category: 'tool-calls' })
    const events = page.records.map((r) => r.event)
    for (const [callId, errorClass] of [
      ['call_paused', 'unavailable'],
      ['call_revoked', 'not-granted'],
    ] as const) {
      expect(events).toContainEqual({
        type: 'tool-called',
        adapterId: 'shop',
        adapterHash: s.adapter.hash,
        tool: 'echo',
        client: 'Claude Code',
        callId,
      })
      expect(events).toContainEqual({
        type: 'tool-finished',
        adapterId: 'shop',
        callId,
        outcome: 'failed',
        stage: 'config',
        errorClass,
        durationMs: 0,
      })
    }
    expect((await s.api.runs.list()).map((r) => r.callId)).toEqual(
      expect.arrayContaining(['call_paused', 'call_revoked']),
    )
  })

  it('audits a refused call’s undeclared tool and unprintable client the way the runtime would', async () => {
    const s = await approved()
    await s.api.app.setPaused(true)
    await s.call('no_such_tool', {}, 'Claude\u0007 Code\u200b', 'call_odd')
    // A call id the runtime wouldn't take, or an adapter that isn't installed, isn't recorded.
    await s.call('echo', {}, 'Claude Code', 'bad id!')
    await (s.endpoint.caller as ToolCaller).call({
      adapterId: 'nope',
      tool: 'echo',
      input: {},
      client: 'x',
      callId: 'call_nope',
    })
    const events = (await s.api.audit.page({ category: 'tool-calls' })).records.map((r) => r.event)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-called',
        tool: '(invalid)',
        client: 'Claude Code',
        callId: 'call_odd',
      }),
    )
    expect(JSON.stringify(events)).not.toContain('bad id!')
    expect(JSON.stringify(events)).not.toContain('call_nope')
  })

  it('asks the person in the confirmation panel, and only an armed approval from it counts', async () => {
    const s = await approved()
    const pending = s.call('add', { item: 'milk' }, 'Claude Code', 'call_add')
    for (let i = 0; i < 50 && s.ui.shownConfirmations.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    const [id] = s.ui.shownConfirmations
    const item = (await s.api.attention.list()).find((i): i is ConfirmationItem => i.kind === 'confirmation')
    expect(item).toMatchObject({
      id,
      tool: 'add',
      client: 'Claude Code',
      adapterNote: 'Add milk?',
      clientTransport: 'http',
    })
    expect(item?.approvedAt).toBe('2026-11-07T00:00:00.000Z')
    expect(JSON.stringify(item?.input)).toContain('milk')
    // Not yet shown, from the wrong window, and too soon after showing: all refused.
    await expect(
      s.api.answerConfirmation(id as string, true, { role: 'confirmation', shows: id as string }),
    ).rejects.toThrow()
    s.service.confirmationArmed(id as string)
    await expect(
      s.api.answerConfirmation(id as string, true, { role: 'control', shows: null }),
    ).rejects.toThrow()
    await expect(
      s.api.answerConfirmation(id as string, true, { role: 'confirmation', shows: id as string }),
    ).rejects.toThrow()
    s.advance(CONFIRM_ARM_MS)
    // Armed, but from a confirmation panel opened for some other request.
    await expect(
      s.api.answerConfirmation(id as string, true, { role: 'confirmation', shows: 'cf_other' }),
    ).rejects.toThrow()
    expect(s.service.confirmationPending(id as string)).toBe(true)
    await s.api.answerConfirmation(id as string, true, { role: 'confirmation', shows: id as string })
    expect(await pending).toEqual({ status: 'ok', output: { added: true } })
    expect(s.ui.closedConfirmations).toEqual([id])
    const records = await s.api.audit.page({ category: 'confirmations' })
    expect(records.records[0]?.event).toMatchObject({
      type: 'confirmation',
      answer: 'approved',
      client: 'Claude Code',
    })
  })

  it('takes a decline from any window', async () => {
    const s = await approved()
    const pending = s.call('add', { item: 'milk' })
    for (let i = 0; i < 50 && s.ui.shownConfirmations.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    await s.api.answerConfirmation(s.ui.shownConfirmations[0] as string, false, { role: 'tray', shows: null })
    expect(await pending).toEqual({ status: 'ok', output: { added: false } })
  })
})

describe('the login window', () => {
  it('opens only for an approved adapter, and hands off only once the probe passes', async () => {
    const s = await setup()
    await expect(s.api.openLoginWindow('shop')).rejects.toThrow()
    await s.api.approvals.approve('shop', s.adapter.hash)
    await s.api.openLoginWindow('shop')
    const page = s.driver.pages[0]
    expect(page?.gone).toEqual(['https://login.shop.test/login'])
    expect(page?.handedTo).toEqual(['login-required'])
    expect((await s.api.attention.list()).map((i) => i.kind)).toEqual(['needs-user'])
    expect(s.service.hasHandoff('shop')).toBe(true)
    // Opening again shows the same window rather than another.
    await s.api.openLoginWindow('shop')
    expect(s.driver.pages).toHaveLength(1)
    await expect(s.api.finishLogin('shop')).rejects.toThrow()
    if (page !== undefined) page.cookies = ['sid']
    await s.api.finishLogin('shop')
    expect(s.driver.handoffs).toHaveLength(1)
    expect((await s.api.adapters.list())[0]?.session.state).toBe('logged-in')
    await s.api.openLoginWindow('shop')
    await s.api.closeLoginWindow('shop')
    expect(s.driver.pages[1]?.closed).toBe(true)
    expect(s.ui.banners).toContain('close shop')
  })
  it('is refused while the site’s circuit breaker is open, opening and finishing alike', async () => {
    const s = await approved()
    await s.api.openLoginWindow('shop')
    const page = s.driver.pages[0]
    if (page !== undefined) page.cookies = ['sid']
    await s.api.closeLoginWindow('shop')
    const later = Date.parse('2026-11-07T01:00:00.000Z')
    writeFileSync(
      s.paths.breakers,
      JSON.stringify({ version: 1, hosts: { 'www.shop.test': { retryAt: later, cooldownMs: 60_000 } } }),
    )
    expect((await s.api.health.sites())[0]?.breaker).toBe('open')
    await expect(s.api.openLoginWindow('shop')).rejects.toEqual(new SiteAdapterError('login', 'rate-limited'))
    expect(s.driver.pages).toHaveLength(1)
    expect(s.service.hasHandoff('shop')).toBe(false)

    // A window already up when the breaker opened can't hand off either.
    writeFileSync(s.paths.breakers, JSON.stringify({ version: 1, hosts: {} }))
    await s.api.openLoginWindow('shop')
    const second = s.driver.pages[1]
    if (second !== undefined) second.cookies = ['sid']
    writeFileSync(
      s.paths.breakers,
      JSON.stringify({ version: 1, hosts: { 'www.shop.test': { retryAt: later, cooldownMs: 60_000 } } }),
    )
    await expect(s.api.finishLogin('shop')).rejects.toEqual(new SiteAdapterError('login', 'rate-limited'))
    expect(s.driver.handoffs).toEqual([])
    expect(s.service.hasHandoff('shop')).toBe(true)
    // Once the cool-down is over it goes through.
    s.advance(60 * 60_000)
    await s.api.finishLogin('shop')
    expect(s.driver.handoffs).toHaveLength(1)
  })

  it('hands off only once no call or run is going on, and holds new calls until it has', async () => {
    const s = await approved()
    await s.api.openLoginWindow('shop')
    const page = s.driver.pages[0]
    if (page !== undefined) page.cookies = ['sid']
    // A call waiting on the person's confirmation is in flight, with its run open.
    const pending = s.call('add', { item: 'milk' })
    for (let i = 0; i < 50 && s.ui.shownConfirmations.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    let handedOff = false
    const finishing = s.api.finishLogin('shop').then(() => {
      handedOff = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(handedOff).toBe(false)
    expect(s.driver.handoffs).toEqual([])
    // A call that arrives now waits for the hand-off.
    const echo = s.call('echo', { text: 'x' })
    await s.api.answerConfirmation(s.ui.shownConfirmations[0] as string, false, { role: 'tray', shows: null })
    expect(await pending).toEqual({ status: 'ok', output: { added: false } })
    await finishing
    expect((await echo).status).toBe('ok')
    // The add's run ended before the hand-off, and the echo's run began after it.
    expect(s.driver.log).toEqual(['begin', 'end', 'handoff', 'begin', 'end'])
  })
})

describe('endpoint, settings, audit and the app', () => {
  it('copies through the main process, rotates the token and stops and starts listening', async () => {
    const s = await approved()
    await s.api.endpoint.copyUrl()
    await s.api.endpoint.copyClientConfig('claude-code')
    expect(s.ui.clipboard[0]).toBe('http://127.0.0.1:47000/mcp')
    expect(s.ui.clipboard[1]).toContain('claude mcp add siteadapter-demo --')
    for (const snippet of await s.api.endpoint.snippets()) expect(snippet.text).not.toContain(TOKEN)
    await s.api.endpoint.rotateToken()
    expect(s.endpoint.resets).toBe(1)
    expect((await s.api.endpoint.status()).tokenRotatedAt).toBe('2026-11-07T00:00:00.000Z')
    await s.api.endpoint.setListening(false)
    expect(await s.api.endpoint.status()).toMatchObject({ listening: false, url: null, connectedClients: 0 })
    await expect(s.api.endpoint.copyUrl()).rejects.toThrow()
    await s.api.endpoint.setListening(false)
    await s.api.endpoint.rotateToken()
    expect(existsSync(s.paths.bridgeConfig)).toBe(false)
    await s.api.endpoint.setListening(true)
    await s.api.endpoint.setListening(true)
    expect(s.endpoint.starts).toBe(2)
  })

  it('changes settings only through the patch and the main process’s own op dialog', async () => {
    const s = await approved()
    expect((await s.api.settings.set({ launchAtLogin: true })).launchAtLogin).toBe(true)
    expect(s.ui.loginItem).toEqual([true])
    s.ui.opChoice = null
    expect((await s.api.settings.chooseOpPath()).opPath).toBeNull()
    s.ui.opChoice = '/tmp/evil/op'
    await expect(s.api.settings.chooseOpPath()).rejects.toThrow()
    expect((await s.api.settings.get()).opPath).toBeNull()
    s.ui.opChoice = '/good/op'
    expect((await s.api.settings.chooseOpPath()).opPath).toBe('/good/op')
    expect((await s.api.settings.clearOpPath()).opPath).toBeNull()
    expect(s.events).toContainEqual({ type: 'settings-changed' })
  })

  it('verifies and exports the audit log', async () => {
    const s = await approved()
    expect(await s.api.audit.chainStatus()).toEqual({ state: 'unverified' })
    const verified = await s.api.audit.verify()
    expect(verified).toMatchObject({ state: 'intact', records: 1 })
    expect(await s.api.audit.chainStatus()).toEqual(verified)
    // Every window's chain status refetches: the sidebar shows the answer at once.
    expect(s.events).toContainEqual({ type: 'audit-verified' })
    await s.api.audit.exportJsonl()
    s.ui.saveTo = join(s.paths.dir, 'export.jsonl')
    await s.api.audit.exportJsonl()
    expect(readFileSync(s.ui.saveTo, 'utf8')).toBe(readFileSync(s.paths.audit, 'utf8'))
  })

  it('passes app actions to the windows and reports health and updates', async () => {
    const s = await approved()
    await s.api.app.openControlPanel('#/audit')
    await s.api.app.openControlPanel()
    await s.api.app.copyText('hello')
    await s.api.app.quit()
    expect(s.ui.panels).toEqual(['#/audit', null])
    expect(s.ui.clipboard).toEqual(['hello'])
    expect(s.ui.quits).toBe(1)
    expect(await s.api.health.sites()).toEqual([
      expect.objectContaining({ host: 'www.shop.test', breaker: 'closed', adapterIds: ['shop'] }),
    ])
    expect(await s.api.updates.status()).toMatchObject({ current: '0.1.0', state: 'up-to-date' })
    await s.api.updates.check()
  })

  it('stops the endpoint and every driver', async () => {
    const s = await approved()
    await s.service.stop()
    expect(s.endpoint.closes).toBe(1)
    expect(s.driver.closed).toBe(true)
  })
})

describe('nothing secret crosses', () => {
  it('no read the renderer can make carries a password, the token or an item reference', async () => {
    const s = await approved()
    await s.api.grants.make({
      adapterId: 'shop',
      adapterHash: s.adapter.hash,
      secret: 'login',
      provider: 'fake',
      itemRef: 'demo-woolworths',
      origins: ['https://login.shop.test'],
    })
    s.driver.sessionValues = ['session-cookie-canary-0001']
    await s.call('echo', { text: 'x' })
    await s.api.openLoginWindow('shop')
    const reads = await Promise.all([
      s.api.adapters.list(),
      s.api.adapters.get('shop'),
      s.api.approvals.pending(),
      s.api.grants.list(),
      s.api.grants.providers(),
      s.api.runs.list(),
      s.api.runs.statsToday(),
      s.api.audit.page({}),
      s.api.endpoint.status(),
      s.api.endpoint.snippets(),
      s.api.clients.list(),
      s.api.attention.list(),
      s.api.settings.get(),
      s.api.health.sites(),
      s.api.app.status(),
    ])
    const text = JSON.stringify(reads)
    for (const canary of [
      DEMO_ACCOUNT.password,
      DEMO_ACCOUNT.username,
      TOKEN,
      'op://',
      'session-cookie-canary-0001',
    ]) {
      expect(text).not.toContain(canary)
    }
  })
})

describe('fillSelector', () => {
  it('finds the selector a secret field is typed into, nested steps and Messages codes included', () => {
    const steps = shopDefinition().manifest.auth.steps
    expect(fillSelector(steps, 'login', 'password')).toBe('#pass')
    expect(fillSelector(steps, 'messages', 'otp')).toBe('#code')
    expect(
      fillSelector(
        [
          {
            op: 'when',
            condition: { visible: '#a' },
            steps: [],
            otherwise: [
              { op: 'retry', times: 1, steps: [{ op: 'otp', selector: '#t', source: { secret: 'login' } }] },
            ],
          },
        ],
        'login',
        'otp',
      ),
    ).toBe('#t')
    expect(fillSelector(steps, 'login', 'otp')).toBe('')
  })
})
