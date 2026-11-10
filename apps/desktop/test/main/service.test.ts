// @vitest-environment node
// The whole main-process wiring in plain Node: the real runtime, stores, audit log and auth flow,
// with a fake driver, the test credential provider, a stand-in endpoint and a recording UI.

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CredentialError, ValetError } from '@valet/core'
import type { LiveSessions, SessionReportingEndpoint, ToolCall, ToolCaller } from '@valet/mcp-server'
import { LoginAttemptMarker } from '@valet/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { dataPaths } from '../../src/main/core/constants'
import { type Credentials, disabledOtpReader } from '../../src/main/core/credentials'
import { DEMO_ACCOUNT, demoCredentials } from '../../src/main/core/demo'
import { builtinAdapter } from '../../src/main/core/registry'
import type { RemoteAccess } from '../../src/main/core/remote'
import { AppService, fillSelector } from '../../src/main/core/service'
import { disabledUpdates, type UpdatesHooks, type UpdatesPort } from '../../src/main/core/updates'
import type { AppEvent, ConfirmationItem, HashRoute } from '../../src/shared/api'
import { CONFIRM_ARM_MS } from '../../src/shared/api'
import { FakeAuthPage, FakeDriver, SHOP, SHOP_FILES, shopDefinition } from './fixtures'
import { tunnelFetch } from './tunnel-fetch'

const TOKEN = 't'.repeat(43)
const dirs: string[] = []
const services: AppService[] = []
const clientsToClose: Client[] = []
afterEach(async () => {
  for (const c of clientsToClose.splice(0)) await c.close().catch(() => undefined)
  for (const s of services.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup(
  options: {
    checkOp?: (path: string) => Promise<string | null>
    updates?: (hooks: UpdatesHooks) => Promise<UpdatesPort>
    version?: string
    dir?: string
    /** breakers.json as the runtime finds it at start. */
    breakers?: unknown
    credentials?: Credentials
  } = {},
) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'sa-service-'))
  if (options.dir === undefined) dirs.push(dir)
  const paths = dataPaths(join(dir, 'data'))
  if (options.breakers !== undefined) {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    writeFileSync(paths.breakers, JSON.stringify(options.breakers))
  }
  let now = Date.parse('2026-11-07T00:00:00.000Z')
  const driver = new FakeDriver()
  const adapter = builtinAdapter(shopDefinition(), SHOP_FILES)
  const events: AppEvent[] = []
  const ui = {
    clipboard: [] as string[],
    shownConfirmations: [] as string[],
    remoteConsents: 0,
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
    /** The clients holding a token, by id, and each operation on them. */
    clients: new Map<string, string>(),
    ops: [] as string[],
    live: { total: 0, bridge: 0, http: 0, sessions: [] } as LiveSessions,
    sessionsChanged: null as ((sessions: LiveSessions) => void) | null,
  }
  const service = new AppService({
    paths,
    version: options.version ?? '0.1.0',
    demo: true,
    now: () => now,
    timers: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    sleep: async () => {},
    adapters: [adapter],
    createDriver: async (_manifest, reporters) => {
      driver.reporters = reporters
      return driver
    },
    credentials: options.credentials ?? demoCredentials(disabledOtpReader),
    startEndpoint: async (caller, clients, onSessionsChanged): Promise<SessionReportingEndpoint> => {
      endpoint.caller = caller
      endpoint.sessionsChanged = onSessionsChanged
      endpoint.starts++
      const issue = (id: string, configPath: string) => {
        endpoint.clients.set(id, configPath)
        writeFileSync(configPath, JSON.stringify({ url: 'http://127.0.0.1:47000/mcp', token: TOKEN }))
      }
      for (const client of clients) issue(client.id, client.configPath)
      return {
        url: 'http://127.0.0.1:47000/mcp',
        port: 47000,
        refresh: () => {
          endpoint.refreshes++
          return []
        },
        addClient: async ({ id, configPath }) => {
          endpoint.ops.push(`add ${id}`)
          issue(id, configPath)
        },
        resetClient: async (id) => {
          endpoint.resets++
          endpoint.ops.push(`reset ${id}`)
        },
        removeClient: async (id) => {
          endpoint.ops.push(`remove ${id}`)
          endpoint.clients.delete(id)
        },
        clientIds: () => [...endpoint.clients.keys()],
        close: async () => {
          endpoint.closes++
        },
        sessions: () => endpoint.live,
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
      showRemoteConsent: () => {
        ui.remoteConsents++
      },
      setLaunchAtLogin: (on) => ui.loginItem.push(on),
      quit: () => ui.quits++,
    },
    emit: (event) => events.push(event),
    bridge: (configPath) => ({ command: '/repo/tsx', args: ['/repo/bridge-cli.ts', configPath] }),
    checkOp: options.checkOp ?? (async (path) => (path === '/good/op' ? path : null)),
    updates: options.updates ?? (async () => disabledUpdates('0.1.0', 'development', false)),
    // The site's rate budget waits on the test's clock.
    pacingSleep: async (ms) => {
      now += ms
    },
  })
  services.push(service)
  await service.start()
  const api = service.api
  const call = (
    tool: string,
    input: unknown,
    client = 'Claude Code',
    callId = `call_${tool}_${Math.random().toString(36).slice(2)}`,
    extra: Pick<ToolCall, 'signal' | 'transport' | 'identity'> = { transport: 'http' },
  ) => (endpoint.caller as ToolCaller).call({ adapterId: 'shop', tool, input, client, callId, ...extra })
  return {
    service,
    api,
    adapter,
    driver,
    ui,
    endpoint,
    events,
    paths,
    dir,
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
  /** The demo credentials plus a Keychain copy that records what it is asked to do. */
  function copyingCredentials(fail = false) {
    const demo = demoCredentials(disabledOtpReader)
    const copied: { itemRef: string; fields: readonly string[] }[] = []
    const forgotten: string[] = []
    const credentials: Credentials = {
      ...demo,
      async status() {
        return [...(await demo.status()), { kind: 'keychain-copy', available: true, unavailableReason: null }]
      },
      async vaultItems(provider) {
        return provider === 'keychain-copy'
          ? [{ id: 'vaultid1-itemid1', title: 'Woolworths (Personal)' }]
          : demo.vaultItems(provider)
      },
      async copyItem(itemRef, fields) {
        if (fail) throw new CredentialError('locked')
        copied.push({ itemRef, fields })
      },
      async forgetCopy(itemRef) {
        forgotten.push(itemRef)
      },
    }
    return { credentials, copied, forgotten }
  }

  it('copies a Keychain-copy grant’s item before storing it, re-syncs it, and forgets it on revoke', async () => {
    const { credentials, copied, forgotten } = copyingCredentials()
    const s = await setup({ credentials })
    await s.api.approvals.approve('shop', s.adapter.hash)
    const request = {
      adapterId: 'shop',
      adapterHash: s.adapter.hash,
      secret: 'login',
      provider: 'keychain-copy' as const,
      itemRef: 'vaultid1-itemid1',
      origins: ['https://login.shop.test'],
    }
    await s.api.grants.make(request)
    expect(copied).toEqual([{ itemRef: 'op://vaultid1/itemid1', fields: ['username', 'password'] }])
    expect(await s.api.grants.list()).toEqual([
      expect.objectContaining({
        provider: 'keychain-copy',
        itemId: 'vaultid1-itemid1',
        itemTitle: 'Woolworths (Personal)',
      }),
    ])
    await s.api.grants.resync('shop', 'login')
    expect(copied).toHaveLength(2)
    await expect(s.api.grants.resync('shop', 'nope')).rejects.toEqual(new ValetError('grant', 'not-found'))
    await s.api.grants.revoke('shop', 'login')
    expect(forgotten).toEqual(['op://vaultid1/itemid1'])
    const page = await s.api.audit.page({ category: 'approvals-grants' })
    expect(page.records.map((r) => r.event.type)).toEqual([
      'grant-revoked',
      'grant-copied',
      'grant-made',
      'grant-copied',
      'adapter-approved',
    ])
  })

  it('makes no grant when 1Password won’t give the item up', async () => {
    const { credentials } = copyingCredentials(true)
    const s = await setup({ credentials })
    await s.api.approvals.approve('shop', s.adapter.hash)
    await expect(
      s.api.grants.make({
        adapterId: 'shop',
        adapterHash: s.adapter.hash,
        secret: 'login',
        provider: 'keychain-copy',
        itemRef: 'vaultid1-itemid1',
        origins: ['https://login.shop.test'],
      }),
    ).rejects.toEqual(new ValetError('credential', 'locked'))
    expect(await s.api.grants.list()).toEqual([])
  })

  it('refuses to re-sync a grant that isn’t a Keychain copy', async () => {
    const s = await approved()
    await s.api.grants.make({
      adapterId: 'shop',
      adapterHash: s.adapter.hash,
      secret: 'login',
      provider: 'fake',
      itemRef: 'demo-woolworths',
      origins: ['https://login.shop.test'],
    })
    await expect(s.api.grants.resync('shop', 'login')).rejects.toEqual(new ValetError('grant', 'not-found'))
  })

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

  it('counts a provider’s grants only for an installed hash that is approved', async () => {
    const s = await approved()
    await s.api.grants.make({
      adapterId: 'shop',
      adapterHash: s.adapter.hash,
      secret: 'login',
      provider: 'fake',
      itemRef: 'demo-woolworths',
      origins: ['https://login.shop.test'],
    })
    const count = async () => (await s.api.grants.providers()).find((p) => p.kind === 'fake')?.grantCount
    expect(await count()).toBe(1)
    await s.api.approvals.reject('shop', s.adapter.hash)
    expect(await count()).toBe(0)
    await s.api.approvals.approve('shop', s.adapter.hash)
    expect(await count()).toBe(1)
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
    await markers(s).markAttempted('shop')
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
  })

  it('attributes calls to the client whose token made them, with what it says beside it', async () => {
    const s = await approved()
    const code = await s.api.clients.add('Claude Code')
    const desktop = await s.api.clients.add('Claude Desktop')
    const as = (id: string) => ({
      transport: 'stdio-bridge' as const,
      identity: { origin: 'local' as const, clientId: id },
    })
    await s.call('echo', { text: 'x' }, 'claude-code', 'call_a', as(code.id))
    await s.call('echo', { text: 'x' }, 'claude-code', 'call_b', as(code.id))
    // Another client claiming the same name is still counted as itself.
    await s.call('echo', { text: 'x' }, 'claude-code', 'call_c', as(desktop.id))
    expect((await s.api.clients.list()).map((c) => [c.name, c.reportedName, c.calls7d, c.transport])).toEqual(
      [
        ['Claude Code', 'claude-code', 2, 'stdio'],
        ['Claude Desktop', 'claude-code', 1, 'stdio'],
      ],
    )
    const called = (await s.api.audit.page({ clientId: `local:${desktop.id}` })).records.map((r) => r.event)
    expect(called).toEqual([
      expect.objectContaining({ type: 'tool-called', callId: 'call_c', clientId: `local:${desktop.id}` }),
    ])
  })

  it('shows the endpoint’s live sessions, and the transport each client came by', async () => {
    const s = await approved()
    expect((await s.api.endpoint.status()).connectedClients).toBe(0)
    s.endpoint.live = {
      total: 2,
      bridge: 1,
      http: 1,
      sessions: [
        {
          identity: { origin: 'local', clientId: 'c_0000000000000001' },
          transport: 'stdio-bridge',
          client: 'Claude Desktop',
        },
        {
          identity: { origin: 'local', clientId: 'c_0000000000000002' },
          transport: 'http',
          client: 'Claude Code',
        },
      ],
    }
    s.events.splice(0)
    s.endpoint.sessionsChanged?.(s.endpoint.live)
    expect(s.events).toEqual([{ type: 'endpoint-changed' }])
    expect((await s.api.endpoint.status()).connectedClients).toBe(2)
    const desktop = await s.api.clients.add('Desktop')
    const code = await s.api.clients.add('Code')
    const id = (clientId: string) => ({ origin: 'local' as const, clientId })
    await s.call('echo', { text: 'x' }, 'Claude Desktop', 'call_bridge', {
      transport: 'stdio-bridge',
      identity: id(desktop.id),
    })
    await s.call('echo', { text: 'x' }, 'Claude Code', 'call_http', {
      transport: 'http',
      identity: id(code.id),
    })
    expect((await s.api.clients.list()).map((c) => [c.reportedName, c.transport])).toEqual([
      ['Claude Desktop', 'stdio'],
      ['Claude Code', 'http'],
    ])
  })

  it('ends a call the client cancels, and every call still running when the app stops', async () => {
    const s = await approved()
    const client = new AbortController()
    const cancelled = s.call('add', { item: 'milk' }, 'Claude Code', 'call_cancelled', {
      signal: client.signal,
    })
    for (let i = 0; i < 50 && s.ui.shownConfirmations.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    client.abort()
    expect(await cancelled).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'aborted' })
    // The panel closed with the call, and the answer is on record as declined.
    expect(s.ui.closedConfirmations).toEqual(s.ui.shownConfirmations)
    expect(s.service.confirmationPending(s.ui.shownConfirmations[0] as string)).toBe(false)
    const events = (await s.api.audit.page({})).records.map((r) => r.event)
    expect(events).toContainEqual(expect.objectContaining({ type: 'confirmation', answer: 'declined' }))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-finished',
        callId: 'call_cancelled',
        outcome: 'failed',
        stage: 'tool-run',
        errorClass: 'aborted',
      }),
    )

    const running = s.call('add', { item: 'eggs' }, 'Claude Code', 'call_on_quit')
    for (let i = 0; i < 50 && s.ui.shownConfirmations.length < 2; i++)
      await new Promise((r) => setTimeout(r, 10))
    await s.service.stop()
    expect(await running).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'aborted' })
  })

  it('keeps setup unfinished until the person finishes it, across a restart', async () => {
    const s = await setup()
    expect(await s.api.setup.status()).toEqual({ completedAt: null })
    expect(await s.api.setup.finish()).toEqual({ completedAt: '2026-11-07T00:00:00.000Z' })
    expect(s.events).toContainEqual({ type: 'app-changed' })
    await s.service.stop()
    const again = await setup({ dir: s.dir })
    expect(await again.api.setup.status()).toEqual({ completedAt: '2026-11-07T00:00:00.000Z' })
  })

  it('refuses every call while paused, and audits it with the client’s id', async () => {
    const s = await approved()
    const code = await s.api.clients.add('Claude Code')
    await s.api.app.setPaused(true)
    expect(await s.api.app.status()).toEqual({ paused: true, version: '0.1.0', demo: true })
    // The app's refusal, not the site's: no rate limit, and the stage says it was the app's config.
    expect(
      await s.call('echo', { text: 'x' }, 'Claude Code', 'call_paused', {
        identity: { origin: 'local', clientId: code.id },
      }),
    ).toEqual({ status: 'failed', stage: 'config', errorClass: 'unavailable' })
    expect(s.driver.runs).toBe(0)
    await s.api.app.setPaused(false)
    expect((await s.call('echo', { text: 'x' })).status).toBe('ok')

    const events = (await s.api.audit.page({ category: 'tool-calls' })).records.map((r) => r.event)
    expect(events).toContainEqual({
      type: 'tool-called',
      adapterId: 'shop',
      adapterHash: s.adapter.hash,
      tool: 'echo',
      client: 'Claude Code',
      clientId: `local:${code.id}`,
      callId: 'call_paused',
    })
    expect(events).toContainEqual({
      type: 'tool-finished',
      adapterId: 'shop',
      callId: 'call_paused',
      outcome: 'failed',
      stage: 'config',
      errorClass: 'unavailable',
      durationMs: 0,
    })
    expect((await s.api.runs.list()).map((r) => r.callId)).toContain('call_paused')
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
    const pending = s.call('add', { item: 'milk' }, 'Claude Code', 'call_add', { transport: 'stdio-bridge' })
    for (let i = 0; i < 50 && s.ui.shownConfirmations.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    const [id] = s.ui.shownConfirmations
    const item = (await s.api.attention.list()).find((i): i is ConfirmationItem => i.kind === 'confirmation')
    expect(item).toMatchObject({
      id,
      tool: 'add',
      client: 'Claude Code',
      adapterNote: 'Add milk?',
      clientTransport: 'stdio',
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

describe('updates', () => {
  function audited(paths: { audit: string }) {
    return readFileSync(paths.audit, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line).event)
  }

  it('says why a build doesn’t update, and checks nothing', async () => {
    const s = await setup()
    expect(await s.api.updates.status()).toEqual({
      current: '0.1.0',
      state: 'disabled',
      available: null,
      checkedAt: null,
      signed: false,
      disabledReason: 'development',
    })
    await s.api.updates.check()
    expect(s.events).toContainEqual({ type: 'app-changed' })
  })

  it('audits update-installed on the first launch of a newer version, and only then', async () => {
    const first = await setup({ version: '0.1.0' })
    await first.service.stop()
    const second = await setup({ version: '0.2.0', dir: first.dir })
    await second.service.stop()
    const third = await setup({ version: '0.2.0', dir: first.dir })
    await third.service.stop()
    // An older build started by hand afterwards is no update either.
    const older = await setup({ version: '0.1.5', dir: first.dir })
    await older.service.stop()
    expect(audited(first.paths).filter((e) => e.type === 'update-installed')).toEqual([
      { type: 'update-installed', from: '0.1.0', to: '0.2.0' },
    ])
    expect(JSON.parse(readFileSync(first.paths.versions, 'utf8'))).toEqual({
      lastRun: '0.1.5',
      highestRun: '0.2.0',
    })
  })

  it('gives the updater the settings, versions and idleness it reads, and audits a download', async () => {
    let hooks: UpdatesHooks | null = null
    let started = 0
    let stopped = 0
    let checks = 0
    const s = await setup({
      version: '0.2.0',
      updates: async (given) => {
        hooks = given
        return {
          status: () => ({
            current: '0.2.0',
            state: 'not-checked',
            available: null,
            checkedAt: null,
            signed: true,
            disabledReason: null,
          }),
          check: async () => {
            checks++
          },
          start: () => started++,
          stop: () => stopped++,
        }
      },
    })
    const h = hooks as unknown as UpdatesHooks
    expect(started).toBe(1)
    expect(h.channel()).toBe('stable')
    expect(h.autoInstallOnQuit()).toBe(false)
    await s.api.settings.set({ updateChannel: 'beta', autoInstallUpdates: true })
    expect(h.channel()).toBe('beta')
    expect(h.autoInstallOnQuit()).toBe(true)
    expect(h.highestVersionRun()).toBe('0.2.0')
    await h.whenIdle()
    expect((await s.api.updates.status()).state).toBe('not-checked')
    await s.api.updates.check()
    expect(checks).toBe(1)
    s.events.splice(0)
    h.changed()
    expect(s.events).toEqual([{ type: 'app-changed' }])
    h.downloaded('0.2.0', '0.3.0')
    await s.service.stop()
    expect(stopped).toBe(1)
    expect(audited(s.paths).filter((e) => e.type === 'update-downloaded')).toEqual([
      { type: 'update-downloaded', from: '0.2.0', to: '0.3.0' },
    ])
  })

  it('is idle for an install only once no call holds an adapter, and a paused site counts as idle', async () => {
    let hooks: UpdatesHooks | null = null
    const s = await setup({
      updates: async (given) => {
        hooks = given
        return disabledUpdates('0.1.0', 'development', false)
      },
    })
    const h = hooks as unknown as UpdatesHooks
    // Nothing approved: nothing can run.
    await h.whenIdle()
    await s.api.approvals.approve('shop', s.adapter.hash)
    const pending = s.call('add', { item: 'milk' })
    for (let i = 0; i < 50 && s.ui.shownConfirmations.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10))
    let idle = false
    const waiting = h.whenIdle().then(() => {
      idle = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(idle).toBe(false)
    await s.api.answerConfirmation(s.ui.shownConfirmations[0] as string, false, { role: 'tray', shows: null })
    await pending
    await waiting
    expect(idle).toBe(true)
  })

  it('counts a site whose breaker is open as idle for an install', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-service-'))
    dirs.push(dir)
    let hooks: UpdatesHooks | null = null
    const s = await setup({
      dir,
      breakers: {
        version: 1,
        hosts: { 'www.shop.test': { retryAt: Date.parse('2026-11-07T01:00:00.000Z'), cooldownMs: 60_000 } },
      },
      updates: async (given) => {
        hooks = given
        return disabledUpdates('0.1.0', 'development', false)
      },
    })
    await s.api.approvals.approve('shop', s.adapter.hash)
    await (hooks as unknown as UpdatesHooks).whenIdle()
  })

  it('checks nothing when the updater can’t be built', async () => {
    const s = await setup({
      updates: async () => {
        throw new Error('config: invalid')
      },
    })
    expect(await s.api.updates.status()).toMatchObject({
      state: 'disabled',
      disabledReason: 'not-configured',
    })
  })
})

describe('refusals outside a run', () => {
  function auditTypes(paths: { audit: string }) {
    return readFileSync(paths.audit, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event)
  }

  it('audits the person’s login window as the auth partition’s, with no call', async () => {
    const s = await approved()
    await s.api.openLoginWindow('shop')
    s.driver.authOptions[0]?.onBlocked?.({
      method: 'GET',
      target: 'https://widgets.example',
      reason: 'host-not-allowed',
      initiator: 'page',
    })
    await s.service.stop()
    expect(auditTypes(s.paths).filter((e) => e.type === 'request-blocked')).toEqual([
      {
        type: 'request-blocked',
        adapterId: 'shop',
        method: 'GET',
        target: 'https://widgets.example',
        reason: 'host-not-allowed',
        initiator: 'page',
        partition: 'auth',
        callId: null,
      },
    ])
  })

  it('audits the tool partition between runs, the target redacted against its session values', async () => {
    const s = await setup()
    s.driver.sessionValues = ['SESSIONTOKEN123']
    const reporters = s.driver.reporters
    reporters?.onBlocked({
      method: 'POST',
      target: 'https://sessiontoken123.evil.test',
      reason: 'host-not-allowed',
      initiator: 'page',
    })
    reporters?.onBlocked({
      method: 'GET',
      target: 'https://www.shop.test/apis/x',
      reason: 'undeclared',
      initiator: 'page',
    })
    reporters?.onAuthBlocked({
      method: 'GET',
      target: 'https://frames.example',
      reason: 'host-not-allowed',
      initiator: 'page',
    })
    reporters?.onAuthReportsDropped()
    await s.service.stop()
    const blocked = auditTypes(s.paths).filter((e) => e.type === 'request-blocked')
    expect(blocked.map((e) => [e.partition, e.target, e.callId])).toEqual([
      ['tool', '[redacted]', null],
      ['tool', 'https://www.shop.test/apis/x', null],
      ['auth', 'https://frames.example', null],
    ])
    expect(JSON.stringify(blocked).toLowerCase()).not.toContain('sessiontoken123')
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
  it('is refused while the site’s circuit breaker is open, persisted state included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-service-'))
    dirs.push(dir)
    const later = Date.parse('2026-11-07T01:00:00.000Z')
    // A block from an earlier launch: in force before anything is sent.
    const s = await setup({
      dir,
      breakers: { version: 1, hosts: { 'www.shop.test': { retryAt: later, cooldownMs: 60_000 } } },
    })
    await s.api.approvals.approve('shop', s.adapter.hash)
    expect(await s.api.health.sites()).toEqual([
      {
        host: 'www.shop.test',
        adapterIds: ['shop'],
        breaker: 'open',
        retryAt: '2026-11-07T01:00:00.000Z',
        cause: 'blocked-by-site',
        lastOpenedAt: null,
        // The persisted minute, doubled.
        nextCooldownSeconds: 120,
      },
    ])
    await expect(s.api.openLoginWindow('shop')).rejects.toEqual(new ValetError('login', 'rate-limited'))
    expect(s.driver.pages).toEqual([])
    expect(s.service.hasHandoff('shop')).toBe(false)
    // Once the cool-down is over it opens.
    s.advance(60 * 60_000)
    expect((await s.api.health.sites())[0]?.breaker).toBe('closed')
    await s.api.openLoginWindow('shop')
    expect(s.service.hasHandoff('shop')).toBe(true)
  })

  it('opens the breaker when the login page is the block page, and then no hand-off reaches the site', async () => {
    const s = await approved()
    // The first window: the site answers normally, and the person signs in.
    await s.api.openLoginWindow('shop')
    const first = s.driver.pages[0]
    if (first !== undefined) first.cookies = ['sid']
    await s.api.closeLoginWindow('shop')
    // The next one lands on Akamai's page: the breaker opens, and the window is closed, not shown.
    s.driver.nextPage = () => {
      const page = new FakeAuthPage()
      page.text = ['Access Denied … Reference #18.abc']
      return page
    }
    await expect(s.api.openLoginWindow('shop')).rejects.toEqual(new ValetError('login', 'blocked-by-site'))
    expect(s.driver.pages[1]?.closed).toBe(true)
    expect(s.service.hasHandoff('shop')).toBe(false)
    expect((await s.api.health.sites())[0]).toMatchObject({ breaker: 'open', cause: 'blocked-by-site' })
    // The runtime audits the opening as no call's, and the site's health shows when.
    await expect
      .poll(async () => (await s.api.audit.page({})).records.map((r) => r.event))
      .toContainEqual(
        expect.objectContaining({ type: 'breaker-opened', host: 'www.shop.test', callId: null }),
      )
    expect((await s.api.health.sites())[0]?.lastOpenedAt).not.toBeNull()
    expect((await s.call('echo', { text: 'x' })).status).toBe('blocked')
    // Open: no window opens, and no page is even made.
    s.driver.nextPage = () => new FakeAuthPage()
    await expect(s.api.openLoginWindow('shop')).rejects.toEqual(new ValetError('login', 'rate-limited'))
    expect(s.driver.pages).toHaveLength(2)
    // After the cool-down a window opens, and a hand-off goes through.
    s.advance(60 * 60_000)
    await s.api.openLoginWindow('shop')
    const third = s.driver.pages[2]
    if (third !== undefined) third.cookies = ['sid']
    await s.api.finishLogin('shop')
    expect(s.driver.handoffs).toHaveLength(1)
    await expect(s.api.finishLogin('shop')).rejects.toEqual(new ValetError('login', 'not-found'))
  })

  it('takes a slot of the site’s rate budget for each step', async () => {
    const s = await approved()
    const start = (await s.api.health.sites())[0]
    expect(start).toMatchObject({ breaker: 'closed' })
    await s.api.openLoginWindow('shop')
    const page = s.driver.pages[0]
    if (page !== undefined) page.cookies = ['sid']
    // SHOP's minGapMs is 1 s: the hand-off waited for the next slot, on the test's clock.
    const before = Date.parse((await s.api.adapters.list())[0]?.session.checkedAt ?? '') || 0
    await s.api.finishLogin('shop')
    const after = Date.parse((await s.api.adapters.list())[0]?.session.checkedAt ?? '')
    expect(after - Math.max(before, Date.parse('2026-11-07T00:00:00.000Z'))).toBe(1000)
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
  it('copies through the main process, and stops and starts listening', async () => {
    const s = await approved()
    await s.api.endpoint.copyUrl()
    expect(s.ui.clipboard[0]).toBe('http://127.0.0.1:47000/mcp')
    await s.api.endpoint.setListening(false)
    expect(await s.api.endpoint.status()).toMatchObject({ listening: false, url: null, connectedClients: 0 })
    await expect(s.api.endpoint.copyUrl()).rejects.toThrow()
    await s.api.endpoint.setListening(false)
    await s.api.endpoint.setListening(true)
    await s.api.endpoint.setListening(true)
    expect(s.endpoint.starts).toBe(2)
  })

  it('adds a client with its own config file and setup snippets that name it, never the token', async () => {
    const s = await approved()
    const code = await s.api.clients.add('Claude Code')
    expect(code).toMatchObject({ name: 'Claude Code', revokedAt: null, calls7d: 0 })
    expect(s.endpoint.ops).toEqual([`add ${code.id}`])
    const configPath = join(s.paths.clientConfigs, `${code.id}.json`)
    expect(s.endpoint.clients.get(code.id)).toBe(configPath)
    const snippets = await s.api.clients.snippets(code.id)
    expect(snippets.map((x) => x.client)).toEqual(['claude-code', 'claude-desktop'])
    for (const snippet of snippets) {
      expect(snippet.text).toContain(code.id)
      expect(snippet.text).not.toContain(TOKEN)
    }
    await s.api.clients.copyConfig(code.id, 'claude-code')
    expect(s.ui.clipboard[0]).toContain('claude mcp add valet-demo --')
    expect(s.ui.clipboard[0]).toContain(configPath)
    expect(await s.api.clients.snippets('c_0000000000000000')).toEqual([])
    await expect(s.api.clients.copyConfig('c_0000000000000000', 'claude-code')).rejects.toThrow()
    await expect(s.api.clients.add('  ')).rejects.toThrow()
  })

  it('resets one client’s access on the running endpoint, or drops its saved token while stopped', async () => {
    const s = await approved()
    const code = await s.api.clients.add('Claude Code')
    s.advance(60_000)
    await s.api.clients.resetAccess(code.id)
    expect(s.endpoint.ops).toEqual([`add ${code.id}`, `reset ${code.id}`])
    expect((await s.api.clients.list())[0]?.accessResetAt).toBe('2026-11-07T00:01:00.000Z')
    await s.api.endpoint.setListening(false)
    const configPath = join(s.paths.clientConfigs, `${code.id}.json`)
    expect(existsSync(configPath)).toBe(true)
    await s.api.clients.resetAccess(code.id)
    expect(existsSync(configPath)).toBe(false)
    await expect(s.api.clients.resetAccess('c_0000000000000000')).rejects.toThrow()
  })

  it('revokes a client: its token is withdrawn, its file deleted, and it gets none at the next start', async () => {
    const s = await approved()
    const code = await s.api.clients.add('Claude Code')
    const desktop = await s.api.clients.add('Claude Desktop')
    await s.api.clients.revoke(code.id)
    expect(s.endpoint.ops).toContain(`remove ${code.id}`)
    expect(existsSync(join(s.paths.clientConfigs, `${code.id}.json`))).toBe(false)
    expect((await s.api.clients.list()).map((c) => [c.name, c.revokedAt !== null])).toEqual([
      ['Claude Code', true],
      ['Claude Desktop', false],
    ])
    await expect(s.api.clients.revoke(code.id)).rejects.toThrow()
    await expect(s.api.clients.resetAccess(code.id)).rejects.toThrow()
    expect(await s.api.clients.snippets(code.id)).toEqual([])
    await s.api.endpoint.setListening(false)
    s.endpoint.clients.clear()
    await s.api.endpoint.setListening(true)
    expect([...s.endpoint.clients.keys()]).toEqual([desktop.id])
  })

  it('deletes the shared bridge config left from before per-client tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-service-'))
    dirs.push(dir)
    const paths = dataPaths(join(dir, 'data'))
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      paths.legacyBridgeConfig,
      JSON.stringify({ url: 'http://127.0.0.1:47000/mcp', token: TOKEN }),
    )
    await setup({ dir })
    expect(existsSync(paths.legacyBridgeConfig)).toBe(false)
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
    expect(await s.api.updates.status()).toMatchObject({ current: '0.1.0', state: 'disabled' })
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

describe('remote access', () => {
  const HOST = 'mac.example-tailnet.ts.net'
  const REMOTE_RESOURCE = `https://${HOST}/mcp`

  /** A client the person approved for `tools`, as the authorisation server would leave it. */
  function approvedClient(s: { service: { remote: RemoteAccess } }, tools: readonly string[]) {
    const { registration } = s.service.remote.clients.register(
      { redirectUris: ['https://claude.example/cb'], clientName: null, authMethod: 'none' },
      null,
    )
    s.service.remote.clients.grant(registration.id, tools, REMOTE_RESOURCE)
    return { id: registration.id, token: s.service.remote.tokens.issue(registration.id, REMOTE_RESOURCE) }
  }

  async function remoteClient(port: number, token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://${HOST}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: tunnelFetch(port, HOST),
    })
    const client = new Client({ name: 'claude.ai', version: '1' })
    await client.connect(transport)
    clientsToClose.push(client)
    return client
  }

  function audited(paths: { audit: string }) {
    return readFileSync(paths.audit, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event)
  }

  it('is off until the person turns it on, with no file and nothing listening', async () => {
    const s = await approved()
    expect(s.service.remote.status()).toEqual({
      enabled: false,
      listening: false,
      url: null,
      hosts: [],
      sessions: 0,
      tools: [],
      clients: 0,
      pendingConsents: 0,
    })
    expect(existsSync(s.paths.remote)).toBe(false)
  })

  it('serves only remote-enabled tools through the same runtime, audited as remote', async () => {
    const s = await approved()
    await s.service.remote.setHosts([HOST])
    await s.service.remote.setEnabled(true)
    const { url } = s.service.remote.status()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const port = Number(new URL(url as string).port)
    const phone = approvedClient(s, ['shop.echo', 'shop.add'])
    const client = await remoteClient(port, phone.token)

    expect((await client.listTools()).tools).toEqual([])
    await s.service.setRemoteTool('shop', 'echo', true)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['shop_echo'])

    const ok = await client.callTool({ name: 'shop_echo', arguments: { text: 'hi' } })
    expect(ok.structuredContent).toEqual({ text: 'hi' })
    expect(s.driver.runs).toBe(1)

    const events = audited(s.paths)
    expect(events).toContainEqual({ type: 'remote-state', state: 'on', revokedTokens: 0 })
    expect(events).toContainEqual({
      type: 'remote-tool',
      adapterId: 'shop',
      tool: 'echo',
      enabled: true,
      sideEffect: 'read',
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-called',
        tool: 'echo',
        client: 'claude.ai',
        clientId: `remote:${phone.id}`,
      }),
    )
    expect(s.service.remote.status()).toMatchObject({
      enabled: true,
      listening: true,
      sessions: 1,
      tools: ['shop.echo'],
    })
  })

  it('refuses and audits a call to a tool turned off since the client listed it', async () => {
    const s = await approved()
    await s.service.remote.setHosts([HOST])
    await s.service.remote.setEnabled(true)
    await s.service.setRemoteTool('shop', 'add', true)
    const port = Number(new URL(s.service.remote.status().url as string).port)
    const phone = approvedClient(s, ['shop.add'])
    const client = await remoteClient(port, phone.token)
    await client.listTools()
    // Off in the store, but the client still holds the old listing.
    ;(s.service.remote as unknown as { current: { tools: object } }).current.tools = {}

    const refused = await client.callTool({ name: 'shop_add', arguments: { item: 'milk' } })

    expect(refused.isError).toBe(true)
    expect(s.driver.runs).toBe(0)
    const events = audited(s.paths)
    const called = events.find((e) => e.type === 'tool-called' && e.tool === 'add')
    expect(called).toMatchObject({ clientId: `remote:${phone.id}` })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-finished',
        callId: called.callId,
        outcome: 'failed',
        stage: 'config',
        errorClass: 'not-found',
      }),
    )
  })

  it('refuses remote calls while the adapters are paused, as it does local ones', async () => {
    const s = await approved()
    await s.service.remote.setHosts([HOST])
    await s.service.remote.setEnabled(true)
    await s.service.setRemoteTool('shop', 'echo', true)
    const port = Number(new URL(s.service.remote.status().url as string).port)
    const client = await remoteClient(port, approvedClient(s, ['shop.echo']).token)
    await s.api.app.setPaused(true)
    const result = await client.callTool({ name: 'shop_echo', arguments: { text: 'x' } })
    expect(JSON.stringify(result.content)).toContain('config: unavailable')
    expect(s.driver.runs).toBe(0)
  })

  it('pauses with the kill switch: tokens revoked, listener closed, audited, and still paused after a restart', async () => {
    const s = await approved()
    await s.service.remote.setHosts([HOST])
    await s.service.remote.setEnabled(true)
    const port = Number(new URL(s.service.remote.status().url as string).port)
    const token = s.service.remote.tokens.issue('phone', REMOTE_RESOURCE)
    await remoteClient(port, token)

    await s.service.remote.setEnabled(false)

    expect(s.service.remote.tokens.identify(token, REMOTE_RESOURCE)).toBeNull()
    expect(s.service.remote.status()).toMatchObject({ enabled: false, listening: false, url: null })
    expect(audited(s.paths)).toContainEqual({ type: 'remote-state', state: 'paused', revokedTokens: 1 })
    expect(s.events).toContainEqual({ type: 'app-changed' })

    await s.service.stop()
    services.splice(services.indexOf(s.service), 1)
    const again = await setup({ dir: s.dir })
    expect(again.service.remote.status()).toMatchObject({ enabled: false, listening: false, hosts: [HOST] })
  })

  it('starts listening again at launch, on the same port, when the person left it on', async () => {
    const s = await approved()
    await s.service.remote.setHosts([HOST])
    await s.service.remote.setEnabled(true)
    const first = s.service.remote.status().url
    await s.service.stop()
    services.splice(services.indexOf(s.service), 1)

    const again = await setup({ dir: s.dir })
    expect(again.service.remote.status()).toMatchObject({ enabled: true, listening: true, url: first })
  })

  it('adds a connector end to end: registration, the browser’s code typed on the Mac, tokens, ticked tools only', async () => {
    const s = await approved()
    await s.service.remote.setHosts([HOST])
    await s.service.remote.setEnabled(true)
    await s.service.setRemoteTool('shop', 'echo', true)
    await s.service.setRemoteTool('shop', 'add', true)
    const port = Number(new URL(s.service.remote.status().url as string).port)
    const web = tunnelFetch(port, HOST)
    const base = `http://${HOST}`

    const registered = await web(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.8' },
      body: JSON.stringify({
        redirect_uris: ['https://claude.example/cb'],
        token_endpoint_auth_method: 'none',
        client_name: 'Claude',
      }),
    })
    expect(registered.status).toBe(201)
    const { client_id: clientId } = (await registered.json()) as { client_id: string }

    const verifier = 'x'.repeat(64)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.example/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'abc',
      resource: REMOTE_RESOURCE,
    })
    const page = await (
      await web(`${base}/authorize?${query}`, { headers: { 'cf-connecting-ip': '203.0.113.8' } })
    ).text()
    const shown = /class="code">([0-9A-Z]{4}-[0-9A-Z]{4})</.exec(page)?.[1] as string
    const waitUrl = /url=([^"]+)"/.exec(page)?.[1] as string
    const wait = waitUrl.replace(/&amp;/g, '&')
    expect(s.ui.remoteConsents).toBe(1)

    // The Mac lists the request by its claimed host, never with the code.
    const consents = await s.api.remote.consents()
    expect(consents.requests).toEqual([
      expect.objectContaining({
        clientId,
        clientHost: 'claude.example',
        clientName: 'Claude',
        source: '203.0.113.8',
      }),
    ])
    expect(JSON.stringify(consents)).not.toContain(shown.replace('-', ''))
    expect(consents.tools.map((t) => [t.ref, t.toolTitle, t.sideEffect])).toEqual([
      ['shop.add', 'Add', 'write'],
      ['shop.echo', 'Echo', 'read'],
    ])
    await expect(s.api.remote.approveConsent(shown, ['shop.nope'])).rejects.toBeInstanceOf(ValetError)
    expect(await s.api.remote.approveConsent('AAAA-AAAA', ['shop.echo'])).toBe('wrong-code')
    expect(await s.api.remote.approveConsent(shown.toLowerCase(), ['shop.echo'])).toBe('approved')

    const back = await web(`${base}${wait}`)
    expect(back.status).toBe(302)
    const code = new URL(back.headers.get('location') as string).searchParams.get('code') as string
    const tokenRes = await web(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
      }).toString(),
    })
    expect(tokenRes.status).toBe(200)
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string }

    const client = await remoteClient(port, tokens.access_token)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['shop_echo'])
    expect(audited(s.paths)).toContainEqual({
      type: 'remote-consent',
      clientId: `remote:${clientId}`,
      clientHost: 'claude.example',
      source: '203.0.113.8',
      tools: ['shop.echo'],
      answer: 'approved',
    })
    expect(s.events).toContainEqual({ type: 'remote-changed' })

    // The client is kept across a restart, and its refresh token still works.
    await s.service.stop()
    services.splice(services.indexOf(s.service), 1)
    const again = await setup({ dir: s.dir })
    expect((await again.api.remote.clients()).map((c) => [c.id, c.grant?.tools])).toEqual([
      [clientId, ['shop.echo']],
    ])
    const port2 = Number(new URL(again.service.remote.status().url as string).port)
    const refresh = (token: string) =>
      tunnelFetch(port2, HOST)(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: token,
        }).toString(),
      })
    const rotated = (await (await refresh(tokens.refresh_token)).json()) as { refresh_token: string }
    expect(rotated.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    await again.api.remote.revokeClient(clientId)
    expect((await refresh(rotated.refresh_token)).status).toBe(401)
    expect(await again.api.remote.clients()).toEqual([])
    expect(audited(again.paths)).toContainEqual({
      type: 'remote-revoked',
      clientId: `remote:${clientId}`,
      clients: 1,
    })
  })

  it('audits declined and cancelled consent, and revoking every client', async () => {
    const s = await approved()
    await s.service.remote.setHosts([HOST])
    await s.service.remote.setEnabled(true)
    const port = Number(new URL(s.service.remote.status().url as string).port)
    const web = tunnelFetch(port, HOST)
    const base = `http://${HOST}`
    const register = async () => {
      const res = await web(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://claude.example/cb'],
          token_endpoint_auth_method: 'none',
        }),
      })
      return ((await res.json()) as { client_id: string }).client_id
    }
    const ask = async (clientId: string) => {
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
      })
      expect((await web(`${base}/authorize?${query}`)).status).toBe(200)
    }
    const a = await register()
    await ask(a)
    const [request] = (await s.api.remote.consents()).requests
    await s.api.remote.declineConsent(request?.id as string)
    await expect(s.api.remote.declineConsent('cs_gone')).rejects.toBeInstanceOf(ValetError)
    await ask(a)
    for (let i = 0; i < 3; i++) await s.api.remote.approveConsent('AAAA-AAAA', [])
    await ask(a)
    await s.api.remote.declineAllConsents()
    // A paused Mac declines whatever is still waiting.
    await ask(a)
    await s.service.remote.setEnabled(false)
    const answers = audited(s.paths)
      .filter((e) => e.type === 'remote-consent')
      .map((e) => e.answer)
    expect(answers).toEqual(['declined', 'cancelled', 'declined', 'declined'])

    await s.service.remote.setEnabled(true)
    await register()
    expect(s.service.remote.status().clients).toBe(2)
    expect(await s.api.remote.revokeAllClients()).toBe(2)
    await expect(s.api.remote.revokeClient(a)).rejects.toBeInstanceOf(ValetError)
    expect(audited(s.paths)).toContainEqual({ type: 'remote-revoked', clientId: null, clients: 2 })
  })

  it('refuses to turn on a tool the adapter doesn’t declare, and a host that isn’t a DNS name', async () => {
    const s = await approved()
    await expect(s.service.setRemoteTool('shop', 'nope', true)).rejects.toEqual(
      new ValetError('config', 'not-found'),
    )
    await expect(s.service.remote.setHosts(['127.0.0.1'])).rejects.toEqual(
      new ValetError('config', 'invalid'),
    )
    expect(s.service.remote.status().hosts).toEqual([])
  })
})

describe('trace retention (D27)', () => {
  it('prunes traces older than the setting at start, and again when the setting shortens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-service-'))
    dirs.push(dir)
    const paths = dataPaths(join(dir, 'data'))
    mkdirSync(paths.traces, { recursive: true })
    const now = Date.parse('2026-11-07T00:00:00.000Z')
    const day = 24 * 60 * 60_000
    for (const [name, age] of [
      ['run-old', 20],
      ['run-week', 7],
      ['run-today', 0],
    ] as const) {
      mkdirSync(join(paths.traces, name))
      writeFileSync(join(paths.traces, name, 'shot.png'), 'x')
      const at = new Date(now - age * day - 60_000)
      utimesSync(join(paths.traces, name), at, at)
    }
    const s = await setup({ dir })
    expect((await s.api.settings.get()).traceRetentionDays).toBe(14)
    expect(readdirSync(paths.traces).sort()).toEqual(['run-today', 'run-week'])
    expect((await s.api.settings.set({ traceRetentionDays: 1 })).traceRetentionDays).toBe(1)
    expect(readdirSync(paths.traces)).toEqual(['run-today'])
  })
})
