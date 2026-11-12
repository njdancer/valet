import {
  type AdapterManifest,
  type BlockedRequest,
  parseManifest,
  type SiteRefusal,
  type ToolRunPolicy,
  ValetError,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import { type DriverOptions, ElectronSessionDriver } from '../src/driver'
import type { CookieRecord, SessionFetchResponse } from '../src/platform'
import { chromeUserAgentOverride } from '../src/user-agent'
import { FakeFrame, FakePlatform, FakeSurface, flush, ManualTimers } from './fake-browser'
import { FakeWindow } from './fake-dom'

const OPTIONS = {
  adapterId: 'example',
  home: 'https://www.example.com/',
  navigation: ['https://www.example.com', 'https://login.example.com'],
  egress: ['www.example.com', 'login.example.com', '*.cdn.example.com'],
  stepTimeoutMs: 1000,
  typingDelayMs: 10,
  random: () => 0,
}

const AUTH = 'persist:auth:example'
const TOOL = 'persist:tool:example'

async function rejection(promise: Promise<unknown>): Promise<ValetError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(error instanceof ValetError)) throw new Error(`expected a ValetError, got ${String(error)}`)
  return error
}

/**
 * A platform whose pages land on whatever origin they load, and whose localStorage is shared per
 * partition and origin, as a browser's is.
 */
function browserLike() {
  const platform = new FakePlatform()
  const storage = new Map<string, Map<string, string>>()
  const storageFor = (partition: string, origin: string) => {
    const key = `${partition} ${origin}`
    let map = storage.get(key)
    if (map === undefined) {
      map = new Map()
      storage.set(key, map)
    }
    return map
  }
  platform.makeSurface = (partition) => {
    const surface = new FakeSurface(partition, [new FakeFrame('null', 'about:blank', null)])
    surface.onLoad = (url) => {
      const origin = new URL(url).origin
      surface.frameList = [
        new FakeFrame(origin, url, null, new FakeWindow({ storage: storageFor(partition, origin) })),
      ]
      surface.commit(url)
      return { ok: true }
    }
    return surface
  }
  return { platform, storageFor }
}

const tokenCookie: CookieRecord = {
  name: 'wow-auth-token',
  value: 'session-token-value',
  domain: 'www.example.com',
  path: '/',
  hostOnly: true,
  secure: true,
  httpOnly: true,
  session: false,
  expirationDate: 1_900_000_000,
  sameSite: 'lax',
}

describe('ElectronSessionDriver.forManifest', () => {
  it('takes the adapter id, home, navigation and egress from the manifest', async () => {
    const manifest: AdapterManifest = parseManifest({
      schemaVersion: 1,
      id: 'woolworths',
      name: 'Woolworths',
      version: '0.1.0',
      description: 'Groceries',
      home: 'https://www.woolworths.com.au/',
      navigation: ['https://www.woolworths.com.au'],
      egress: ['www.woolworths.com.au'],
      secrets: {},
      session: { cookieDomains: ['www.woolworths.com.au'], probe: { kind: 'cookie', name: 'x' } },
      auth: { steps: [{ op: 'assertLoggedIn' }] },
      requests: [{ method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' }],
      tools: [{ name: 'trolley', title: 'Trolley', description: 'Reads the trolley', sideEffect: 'read' }],
    })
    const { platform } = browserLike()
    const driver = ElectronSessionDriver.forManifest(platform, manifest)
    await driver.toolPage()
    expect(platform.surfaces.map((s) => [s.partition, s.loads])).toEqual([
      ['persist:tool:woolworths', ['https://www.woolworths.com.au/']],
    ])
    const filter = platform.session('persist:tool:woolworths').filter!
    expect(
      filter({ url: 'https://www.woolworths.com.au/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' }),
    ).toBe(true)
    expect(
      filter({ url: 'https://www.woolworths.com.au/apis/ui/Orders', method: 'GET', resourceType: 'xhr' }),
    ).toBe(false)
    expect(filter({ url: 'https://www.example.com/', method: 'GET', resourceType: 'mainFrame' })).toBe(false)
  })

  it('refuses an adapter id that is not a safe partition name', () => {
    expect(() => new ElectronSessionDriver(new FakePlatform(), { ...OPTIONS, adapterId: '../x' })).toThrow(
      ValetError,
    )
  })

  it('opens a trial in its own in-memory partitions, never the adapter’s', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, trialLabel: 'dr-aaaaaaaaaa-1' })
    await driver.toolPage()
    await driver.openAuthPage()
    expect(platform.surfaces.map((s) => s.partition)).toEqual([
      'trial:tool:dr-aaaaaaaaaa-1',
      'trial:auth:dr-aaaaaaaaaa-1',
    ])
    expect(() => new ElectronSessionDriver(platform, { ...OPTIONS, trialLabel: 'persist:x' })).toThrow(
      ValetError,
    )
  })
})

describe('partition set-up', () => {
  it('hardens the auth partition once and gives it a subframe filter but no proxy', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    await driver.openAuthPage()
    const auth = platform.session(AUTH)
    expect(auth.hardened).toBe(1)
    expect(auth.filter).not.toBeNull()
    expect(auth.proxy).toBeNull()
    expect(platform.surfaces.map((s) => s.partition)).toEqual([AUTH, AUTH])
  })

  it('guards the tool partition before its first page opens', async () => {
    const { platform } = browserLike()
    const order: string[] = []
    const makeSurface = platform.makeSurface
    platform.makeSurface = (partition) => {
      const tool = platform.session(TOOL)
      order.push(
        `open with filter=${tool.filter !== null} headers=${tool.headers.length} hardened=${tool.hardened} proxy=${tool.proxy?.url}`,
      )
      return makeSurface(partition)
    }
    await new ElectronSessionDriver(platform, OPTIONS).toolPage()
    expect(order).toEqual(['open with filter=true headers=1 hardened=1 proxy=http://127.0.0.1:40000'])
    expect(platform.session(TOOL).headers).toEqual([['X-DNS-Prefetch-Control', 'off']])
  })

  it('gives both partitions the clean Chrome user agent and en-AU by default', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    await driver.toolPage()
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
    for (const partition of [AUTH, TOOL]) {
      expect(platform.session(partition).userAgent, partition).toBe(chrome)
      expect(platform.session(partition).acceptLanguages, partition).toBe('en-AU,en')
    }
  })

  it('sets the user agent before any page opens in the partition', async () => {
    const { platform } = browserLike()
    const seen: (string | null)[] = []
    const makeSurface = platform.makeSurface
    platform.makeSurface = (partition) => {
      seen.push(platform.session(partition).userAgent)
      return makeSurface(partition)
    }
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    await driver.toolPage()
    expect(seen).toHaveLength(2)
    for (const ua of seen) expect(ua).toContain('Chrome/142.0.0.0')
  })

  it('leaves Electron’s own user agent alone only when asked to', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, userAgent: 'electron' })
    await driver.openAuthPage()
    await driver.toolPage()
    expect(platform.session(AUTH).userAgent).toBeNull()
    expect(platform.session(TOOL).userAgent).toBeNull()
    expect(platform.session(AUTH).acceptLanguages).toBeNull()
    expect(platform.surfaces.flatMap((s) => s.overrides)).toEqual([])
    expect(platform.defaultUserAgents).toEqual([])
  })

  it('sets the clean UA as the process default too, for service workers', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    await driver.toolPage()
    const clean = platform.session(TOOL).userAgent
    expect(clean).toMatch(/^Mozilla\/5\.0 .*Chrome\/142\.0\.0\.0 Safari\/537\.36$/)
    expect(platform.defaultUserAgents).toEqual([clean, clean])
  })

  it('overrides every page before its first load, so navigator.language is en-AU, with the engine’s own brands when asked', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, clientHints: 'engine' })
    await (await driver.openAuthPage()).goto('https://www.example.com/')
    await driver.toolPage()
    expect(platform.surfaces).toHaveLength(2)
    for (const surface of platform.surfaces) {
      expect(surface.overrides).toHaveLength(1)
      const [{ override, afterLoad }] = surface.overrides as [(typeof surface.overrides)[number]]
      expect(afterLoad).toBe(false)
      expect(override.userAgent).toBe(platform.session(surface.partition).userAgent)
      expect(override.acceptLanguage).toBe('en-AU,en')
      expect(override.userAgentMetadata.brands.map((b) => b.brand)).toEqual(['Not_A Brand', 'Chromium'])
      expect(override.userAgentMetadata).toMatchObject({ platform: 'macOS', platformVersion: '15.5.0' })
    }
  })

  it('names Google Chrome in the client hints by default (D24a)', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    const [{ override }] = platform.surfaces[0]!.overrides as [(typeof platform.surfaces)[0]['overrides'][0]]
    expect(override.userAgentMetadata.brands.map((b) => b.brand)).toContain('Google Chrome')
  })

  it('types with full key events and a jittered rhythm by default (D24, D38)', async () => {
    const { platform } = browserLike()
    const timers = new ManualTimers()
    const draws = [0.5, 0.25]
    const page = await new ElectronSessionDriver(platform, {
      ...OPTIONS,
      timers,
      random: () => draws.shift() ?? 0,
    }).openAuthPage()
    timers.requested.length = 0
    await timers.settle(page.type('abc'))
    expect(platform.surfaces[0]!.keyEvents).toEqual(['full', 'full', 'full'])
    // The default jitter is 80 ms on top of the 10 ms delay.
    expect(timers.requested.slice(-2)).toEqual([10 + 40, 10 + 20])
  })

  it('gives up on an override that never answers, and destroys the page', async () => {
    const { platform } = browserLike()
    const timers = new ManualTimers()
    const makeSurface = platform.makeSurface
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      surface.onOverride = () => new Promise(() => {})
      return surface
    }
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, clientHints: 'chrome', timers })
    const error = await timers.settle(rejection(driver.openAuthPage()))
    expect(error).toMatchObject({ stage: 'timeout', errorClass: 'timed-out' })
    expect(timers.now).toBe(1000)
    expect(platform.surfaces[0]!.isDestroyed()).toBe(true)
  })

  it('does not override client hints for Electron’s own user agent', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, {
      ...OPTIONS,
      userAgent: 'electron',
      clientHints: 'chrome',
    })
    await driver.toolPage()
    expect(platform.surfaces[0]!.overrides).toEqual([])
  })

  it('destroys a page whose override fails, and reports it without the message', async () => {
    const { platform } = browserLike()
    const makeSurface = platform.makeSurface
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      surface.onOverride = async () => {
        throw new Error('Target closed: /Users/nick')
      }
      return surface
    }
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, clientHints: 'chrome' })
    const auth = await rejection(driver.openAuthPage())
    expect(auth).toMatchObject({ stage: 'navigate', errorClass: 'internal' })
    expect(auth.message).not.toContain('nick')
    expect(await rejection(driver.toolPage())).toMatchObject({ stage: 'egress', errorClass: 'internal' })
    expect(platform.surfaces.map((s) => s.isDestroyed())).toEqual([true, true])
  })

  it('watches storage in every tool page before its first load, and in no auth page', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    await driver.toolPage()
    expect(platform.surfaces.map((s) => s.storageWatches)).toEqual([[], [{ afterLoad: false }]])
  })

  it('watches storage in tool pages with Electron’s own user agent too', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, { ...OPTIONS, userAgent: 'electron' }).toolPage()
    expect(platform.surfaces[0]!.storageWatches).toEqual([{ afterLoad: false }])
  })

  it('destroys a tool page whose storage watch fails or never answers', async () => {
    const { platform } = browserLike()
    const timers = new ManualTimers()
    const makeSurface = platform.makeSurface
    let hang = false
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      surface.onWatchStorage = hang
        ? () => new Promise(() => {})
        : async () => {
            throw new Error('Target closed: /Users/nick')
          }
      return surface
    }
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, timers })
    const failed = await rejection(driver.toolPage())
    expect(failed).toMatchObject({ stage: 'egress', errorClass: 'internal' })
    expect(failed.message).not.toContain('nick')
    hang = true
    expect(await timers.settle(rejection(driver.toolPage()))).toMatchObject({
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(platform.surfaces.map((s) => s.isDestroyed())).toEqual([true, true])
    expect(platform.surfaces.flatMap((s) => s.loads)).toEqual([])
  })
})

describe('tool partition egress guard', () => {
  it('lets declared hosts through and cancels everything else', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, OPTIONS).toolPage()
    const filter = platform.session(TOOL).filter!
    expect(filter({ url: 'https://www.example.com/shop', method: 'GET', resourceType: 'mainFrame' })).toBe(
      true,
    )
    expect(filter({ url: 'https://img.cdn.example.com/p.png', method: 'GET', resourceType: 'image' })).toBe(
      true,
    )
    expect(filter({ url: 'https://evil.test/collect', method: 'POST', resourceType: 'xhr' })).toBe(false)
    expect(filter({ url: 'http://www.example.com/', method: 'GET', resourceType: 'mainFrame' })).toBe(false)
    expect(filter({ url: 'https://www.example.com.evil.test/', method: 'GET', resourceType: 'image' })).toBe(
      false,
    )
  })

  it('reports a block to a foreign host with the origin only, never the path or query', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked: (b) => blocked.push(b) }).toolPage()
    platform.session(TOOL).filter!({
      url: 'https://evil.test/session-token-value/collect?cookie=session-token-value#x',
      method: 'POST',
      resourceType: 'ping',
    })
    expect(blocked).toEqual([
      { method: 'POST', target: 'https://evil.test', reason: 'host-not-allowed', initiator: 'page' },
    ])
    expect(JSON.stringify(blocked)).not.toContain('session-token-value')
  })

  it('reports a block on an egress host with its path, never its query', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked: (b) => blocked.push(b) }).toolPage()
    platform.session(TOOL).filter!({
      url: 'https://www.example.com/apis/ui/Orders?cookie=session-token-value',
      method: 'get',
      resourceType: 'xhr',
    })
    expect(blocked).toEqual([
      {
        method: 'GET',
        target: 'https://www.example.com/apis/ui/Orders',
        reason: 'undeclared',
        initiator: 'page',
      },
    ])
  })

  it('reports a method that is not a token as INVALID rather than echoing it', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked: (b) => blocked.push(b) }).toolPage()
    platform.session(TOOL).filter!({ url: 'https://evil.test/', method: 'GET token=x', resourceType: 'xhr' })
    expect(blocked.map((b) => b.method)).toEqual(['INVALID'])
  })

  it('reports an unparseable URL as bad-url without echoing it', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked: (b) => blocked.push(b) }).toolPage()
    expect(platform.session(TOOL).filter!({ url: '::hunter2::', method: 'GET', resourceType: 'xhr' })).toBe(
      false,
    )
    expect(blocked).toEqual([{ method: 'GET', target: 'invalid-url', reason: 'bad-url', initiator: 'page' }])
  })

  it('still blocks when the reporter throws', async () => {
    const { platform } = browserLike()
    const onBlocked = () => {
      throw new Error('audit log full')
    }
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked }).toolPage()
    expect(
      platform.session(TOOL).filter!({ url: 'https://evil.test/', method: 'GET', resourceType: 'image' }),
    ).toBe(false)
  })
})

const DECLARATIONS = [
  { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' },
  { method: 'POST', path: '/apis/ui/Trolley/Update', purpose: 'write' },
  { method: 'POST', path: '/apis/ui/Checkout/Place', purpose: 'irreversible' },
] as const

const SURFACE_OPTIONS = { ...OPTIONS, requests: DECLARATIONS, requestsPerRun: 3 } as const

/** What the runtime passes beginRun for a read tool: the manifest's egress and surface. */
const READ_RUN: ToolRunPolicy = {
  egress: OPTIONS.egress,
  requests: DECLARATIONS,
  maxPurpose: 'read',
  ceiling: 3,
}

const TROLLEY = { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' }
const UPDATE = { url: 'https://www.example.com/apis/ui/Trolley/Update', method: 'POST', resourceType: 'xhr' }
const PLACE = { url: 'https://www.example.com/apis/ui/Checkout/Place', method: 'POST', resourceType: 'xhr' }
const PLACE_UNLOCK = { method: 'POST', path: '/apis/ui/Checkout/Place' }
const SHOP = { url: 'https://www.example.com/shop', method: 'GET', resourceType: 'mainFrame' }
const IMAGE = { url: 'https://img.cdn.example.com/a.png', method: 'GET', resourceType: 'image' }

async function toolFilter(options: Partial<DriverOptions> = {}) {
  const { platform } = browserLike()
  const between: BlockedRequest[] = []
  const driver = new ElectronSessionDriver(platform, {
    ...SURFACE_OPTIONS,
    ...options,
    onBlocked: (b) => between.push(b),
  })
  const page = await driver.toolPage()
  const blocked: BlockedRequest[] = []
  const begin = (policy: Partial<ToolRunPolicy> = {}) =>
    driver.beginRun({ ...READ_RUN, ...policy }, (b) => blocked.push(b))
  return { driver, page, platform, between, blocked, begin, filter: platform.session(TOOL).filter! }
}

describe('tool partition request surface, in a run', () => {
  it('cancels a page-initiated fetch to a denied path on an allowed host, and says why', async () => {
    const { filter, blocked, begin } = await toolFilter()
    begin({ requests: [{ method: 'POST', path: '/checkout/*', purpose: 'write' }], maxPurpose: 'write' })
    expect(filter({ url: 'https://www.example.com/checkout/pay', method: 'POST', resourceType: 'xhr' })).toBe(
      false,
    )
    expect(blocked).toEqual([
      {
        method: 'POST',
        target: 'https://www.example.com/checkout/pay',
        reason: 'denied-path',
        initiator: 'page',
      },
    ])
  })

  it('cancels a form POST to a payment path that a click submitted', async () => {
    const { filter, blocked, begin } = await toolFilter()
    begin()
    expect(
      filter({ url: 'https://www.example.com/payment', method: 'POST', resourceType: 'mainFrame' }),
    ).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['undeclared'])
  })

  it('cancels a navigation to a payments page', async () => {
    const { filter, blocked, begin } = await toolFilter()
    begin()
    expect(
      filter({ url: 'https://www.example.com/payments/new', method: 'GET', resourceType: 'mainFrame' }),
    ).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['denied-path'])
  })

  it('cancels the site’s own undeclared API call, and reports it as the page’s', async () => {
    const { filter, blocked, begin } = await toolFilter()
    begin()
    expect(
      filter({ url: 'https://www.example.com/api/ui/v2/bootstrap', method: 'GET', resourceType: 'xhr' }),
    ).toBe(false)
    expect(blocked).toEqual([
      {
        method: 'GET',
        target: 'https://www.example.com/api/ui/v2/bootstrap',
        reason: 'undeclared',
        initiator: 'page',
      },
    ])
  })

  it('lets the site’s static resources on egress hosts through, not counted toward the ceiling', async () => {
    const { filter, begin } = await toolFilter()
    begin({ ceiling: 0 })
    for (const resourceType of ['script', 'stylesheet', 'image', 'font', 'media']) {
      expect(
        filter({ url: 'https://img.cdn.example.com/x', method: 'GET', resourceType }),
        resourceType,
      ).toBe(true)
    }
  })

  it('reports a refused request tool code made through page.fetch as the tool’s', async () => {
    const { page, platform, blocked, begin } = await toolFilter()
    begin()
    const frame = platform.surfaces[0]!.frameList[0]!
    const filter = platform.session(TOOL).filter!
    // The page's fetch reaches the network layer while the capability call is in flight.
    frame.run = async () => {
      filter({ url: 'https://www.example.com/apis/ui/Orders?x=1', method: 'GET', resourceType: 'xhr' })
      return { error: 'network' }
    }
    await rejection(page.fetch('/apis/ui/Orders?x=1'))
    // Once it settled, the same request is the page's again.
    filter({ url: 'https://www.example.com/apis/ui/Orders?x=1', method: 'GET', resourceType: 'xhr' })
    expect(blocked.map((b) => b.initiator)).toEqual(['tool', 'page'])
  })

  it('reports a refused navigation tool code asked for through page.goto as the tool’s', async () => {
    const { page, platform, blocked, begin } = await toolFilter()
    begin()
    const surface = platform.surfaces[0]!
    const filter = platform.session(TOOL).filter!
    surface.onLoad = (url) => {
      const allowed = filter({ url, method: 'GET', resourceType: 'mainFrame' })
      return allowed ? { ok: true } : { ok: false, code: 'ERR_BLOCKED_BY_CLIENT' }
    }
    expect(await rejection(page.goto('https://www.example.com/payments#top'))).toMatchObject({
      stage: 'egress',
      errorClass: 'host-not-allowed',
    })
    expect(blocked).toEqual([
      { method: 'GET', target: 'https://www.example.com/payments', reason: 'denied-path', initiator: 'tool' },
    ])
  })

  it('cuts off navigation or API call N+1 in a run, and counts no asset toward it', async () => {
    const { filter, blocked, begin } = await toolFilter()
    begin()
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(IMAGE)).toBe(true)
    expect(filter(SHOP)).toBe(true)
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
    expect(filter(SHOP)).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['request-ceiling', 'request-ceiling'])
    // Assets still load once the ceiling is reached.
    expect(filter(IMAGE)).toBe(true)
  })

  it('holds an image, a script or a frame under an API root to the surface, and counts it as a request', async () => {
    const { filter, blocked, begin } = await toolFilter()
    begin()
    const add = 'https://www.example.com/apis/ui/Trolley/Add?id=1'
    for (const resourceType of ['image', 'script', 'subFrame', 'mainFrame']) {
      expect(filter({ url: add, method: 'GET', resourceType }), resourceType).toBe(false)
    }
    expect(blocked.map((b) => `${b.reason} ${b.target}`)).toEqual(
      Array(4).fill('undeclared https://www.example.com/apis/ui/Trolley/Add'),
    )
    // The declared GET, as an image, counts toward the ceiling of 3.
    const asImage = { ...TROLLEY, resourceType: 'image' }
    for (let i = 0; i < 3; i++) expect(filter(asImage)).toBe(true)
    expect(filter(asImage)).toBe(false)
    expect(blocked.at(-1)?.reason).toBe('request-ceiling')
  })

  it('takes the API roots from every declaration in the manifest, even between runs', async () => {
    const { filter } = await toolFilter({
      requests: [...DECLARATIONS, { method: 'POST', path: '/cart/update', purpose: 'write' }],
    })
    const sneaky = { url: 'https://www.example.com/cart/update?add=1', method: 'GET', resourceType: 'image' }
    expect(filter(sneaky)).toBe(false)
  })

  it('cuts off asset N+1 past the asset budget, and reports it as the ceiling', async () => {
    const { filter, blocked, begin } = await toolFilter({ assetsPerRun: 2 })
    begin()
    expect(filter(IMAGE)).toBe(true)
    expect(filter({ ...IMAGE, resourceType: 'script' })).toBe(true)
    expect(filter(IMAGE)).toBe(false)
    expect(blocked).toEqual([
      {
        method: 'GET',
        target: 'https://img.cdn.example.com/a.png',
        reason: 'request-ceiling',
        initiator: 'page',
      },
    ])
    // The budgets are separate: navigations and API calls still go.
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(SHOP)).toBe(true)
  })

  it('starts the asset count again at each run and at endRun()', async () => {
    const { driver, filter, begin } = await toolFilter({ assetsPerRun: 1 })
    expect(filter(IMAGE)).toBe(true)
    expect(filter(IMAGE)).toBe(false)
    begin()
    expect(filter(IMAGE)).toBe(true)
    expect(filter(IMAGE)).toBe(false)
    driver.endRun()
    expect(filter(IMAGE)).toBe(true)
    expect(filter(IMAGE)).toBe(false)
  })

  it('allows 100 assets per request the ceiling allows by default, and never fewer than 1000', async () => {
    const { filter, begin } = await toolFilter()
    begin({ ceiling: 3 })
    for (let i = 0; i < 1000; i++) expect(filter(IMAGE)).toBe(true)
    expect(filter(IMAGE)).toBe(false)
    begin({ ceiling: 20 })
    for (let i = 0; i < 2000; i++) expect(filter(IMAGE)).toBe(true)
    expect(filter(IMAGE)).toBe(false)
  })

  it('allows no asset under an asset budget that is not a whole, non-negative number', async () => {
    for (const assetsPerRun of [-1, 1.5, Number.NaN]) {
      const { filter } = await toolFilter({ assetsPerRun })
      expect(filter(IMAGE), String(assetsPerRun)).toBe(false)
    }
  })

  it('does not count a request it blocked for another reason', async () => {
    const { filter, begin } = await toolFilter()
    begin()
    for (let i = 0; i < 5; i++) {
      filter({ url: 'https://www.example.com/apis/ui/Orders', method: 'GET', resourceType: 'xhr' })
    }
    expect(filter(TROLLEY)).toBe(true)
  })

  it('starts the count again at each run, and takes each run’s own ceiling', async () => {
    const { driver, filter, begin } = await toolFilter()
    begin({ ceiling: 1 })
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
    begin({ ceiling: 2 })
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
    driver.endRun()
    for (let i = 0; i < 3; i++) expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
  })

  it('allows nothing that counts under a ceiling that is not a whole, non-negative number', async () => {
    const { filter, begin } = await toolFilter()
    for (const ceiling of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      begin({ ceiling })
      expect(filter(TROLLEY), String(ceiling)).toBe(false)
      expect(filter(IMAGE), String(ceiling)).toBe(true)
    }
  })

  it('allows a declaration only up to the run’s purpose', async () => {
    const { filter, blocked, begin } = await toolFilter()
    begin({ ceiling: 50 })
    expect(filter(UPDATE)).toBe(false)
    begin({ maxPurpose: 'write', ceiling: 50 })
    expect(filter(UPDATE)).toBe(true)
    expect(filter(PLACE)).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['purpose-exceeded', 'purpose-exceeded'])
  })

  it('refuses irreversible declarations until unlockIrreversible(), and only for that run', async () => {
    const { driver, filter, blocked, begin } = await toolFilter()
    begin({ maxPurpose: 'irreversible', ceiling: 50, unlocks: [PLACE_UNLOCK] })
    expect(filter(UPDATE)).toBe(true)
    expect(filter(PLACE)).toBe(false)
    driver.unlockIrreversible()
    expect(filter(PLACE)).toBe(true)
    // A new run starts locked again.
    begin({ maxPurpose: 'irreversible', ceiling: 50, unlocks: [PLACE_UNLOCK] })
    expect(filter(PLACE)).toBe(false)
    driver.unlockIrreversible()
    driver.endRun()
    expect(filter(PLACE)).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['purpose-exceeded', 'purpose-exceeded'])
  })

  it('unlocks nothing for a run that names no declaration (C15)', async () => {
    const { driver, filter, blocked, begin } = await toolFilter()
    begin({ maxPurpose: 'irreversible', ceiling: 50 })
    driver.unlockIrreversible()
    expect(filter(PLACE)).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['purpose-exceeded'])
  })

  it('ignores unlockIrreversible() in a read or write run, and between runs', async () => {
    const { driver, filter, begin } = await toolFilter()
    driver.unlockIrreversible()
    expect(filter(PLACE)).toBe(false)
    for (const maxPurpose of ['read', 'write'] as const) {
      begin({ maxPurpose, ceiling: 50 })
      driver.unlockIrreversible()
      expect(filter(PLACE), maxPurpose).toBe(false)
    }
  })

  it('lets a run narrow the egress list but never widen it', async () => {
    const { filter, blocked, begin } = await toolFilter()
    begin({ egress: ['img.cdn.example.com'] })
    expect(filter(SHOP)).toBe(false)
    expect(filter(IMAGE)).toBe(true)
    begin({ egress: [...OPTIONS.egress, 'evil.test'] })
    expect(filter({ url: 'https://evil.test/x.png', method: 'GET', resourceType: 'image' })).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['host-not-allowed', 'host-not-allowed'])
  })

  it('reports to the run’s reporter during a run, and to the driver’s between runs', async () => {
    const { driver, filter, between, blocked, begin } = await toolFilter()
    filter({ url: 'https://evil.test/a', method: 'GET', resourceType: 'image' })
    begin()
    filter({ url: 'https://evil.test/b', method: 'GET', resourceType: 'image' })
    driver.endRun()
    filter({ url: 'https://evil.test/c', method: 'GET', resourceType: 'image' })
    expect(between).toHaveLength(2)
    expect(blocked).toHaveLength(1)
  })

  it('still blocks when the run’s reporter throws', async () => {
    const { driver, filter } = await toolFilter()
    driver.beginRun(READ_RUN, () => {
      throw new Error('audit log full')
    })
    expect(filter({ url: 'https://evil.test/', method: 'GET', resourceType: 'image' })).toBe(false)
  })
})

describe('tool partition request surface, between runs', () => {
  it('allows only read declarations, whatever the manifest declares', async () => {
    const { filter, between } = await toolFilter({ requestsPerRun: 50 })
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(UPDATE)).toBe(false)
    expect(filter(PLACE)).toBe(false)
    expect(between.map((b) => b.reason)).toEqual(['undeclared', 'undeclared'])
  })

  it('makes no API call at all when it was given no declarations', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, OPTIONS).toolPage()
    expect(platform.session(TOOL).filter!(TROLLEY)).toBe(false)
  })

  it('counts toward the manifest’s ceiling from the last endRun()', async () => {
    const { driver, filter } = await toolFilter()
    for (let i = 0; i < 3; i++) expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
    driver.endRun()
    for (let i = 0; i < 3; i++) expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
  })

  it('uses the manifest’s default ceiling of 50 when none is given', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, { ...OPTIONS, requests: DECLARATIONS }).toolPage()
    const filter = platform.session(TOOL).filter!
    for (let i = 0; i < 50; i++) expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
  })

  it('takes the request surface and ceiling from the manifest', async () => {
    const manifest = parseManifest({
      schemaVersion: 1,
      id: 'example',
      name: 'Example',
      version: '0.1.0',
      description: 'Example',
      home: 'https://www.example.com/',
      navigation: ['https://www.example.com'],
      egress: ['www.example.com'],
      secrets: {},
      session: { cookieDomains: ['www.example.com'], probe: { kind: 'cookie', name: 'x' } },
      auth: { steps: [{ op: 'assertLoggedIn' }] },
      requests: [{ method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' }],
      limits: { requestsPerRun: 1 },
      tools: [{ name: 'trolley', title: 'Trolley', description: 'Reads the trolley', sideEffect: 'read' }],
    })
    const { platform } = browserLike()
    await ElectronSessionDriver.forManifest(platform, manifest).toolPage()
    const filter = platform.session(TOOL).filter!
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
  })
})

describe('tool partition proxy', () => {
  it('allows a connection only to an egress host on port 443, and reports what it refuses', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked: (b) => blocked.push(b) }).toolPage()
    const allow = platform.proxies[0]!.policy
    expect(allow('www.example.com', 443)).toBe(true)
    expect(allow('img.cdn.example.com', 443)).toBe(true)
    expect(allow('www.example.com', 3478)).toBe(false)
    expect(allow('session-token-value.evil.test', 443)).toBe(false)
    expect(allow('127.0.0.1', 443)).toBe(false)
    const connect = (target: string) =>
      ({ method: 'CONNECT', target, reason: 'host-not-allowed', initiator: 'page' }) as const
    expect(blocked).toEqual([
      connect('https://www.example.com:3478'),
      connect('https://session-token-value.evil.test'),
      connect('https://127.0.0.1'),
    ])
  })

  it('holds sockets to the run’s narrower egress too, and reports to the run', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    const blocked: BlockedRequest[] = []
    driver.beginRun({ egress: ['img.cdn.example.com'], requests: [], maxPurpose: 'read', ceiling: 5 }, (b) =>
      blocked.push(b),
    )
    const allow = platform.proxies[0]!.policy
    expect(allow('www.example.com', 443)).toBe(false)
    expect(allow('img.cdn.example.com', 443)).toBe(true)
    driver.endRun()
    expect(allow('www.example.com', 443)).toBe(true)
    expect(blocked.map((b) => b.target)).toEqual(['https://www.example.com'])
  })

  it('takes other ports only when told to', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, { ...OPTIONS, egressPorts: [8443] }).toolPage()
    const allow = platform.proxies[0]!.policy
    expect(allow('www.example.com', 8443)).toBe(true)
    expect(allow('www.example.com', 443)).toBe(false)
  })

  it('still refuses when the reporter throws', async () => {
    const { platform } = browserLike()
    const onBlocked = () => {
      throw new Error('audit log full')
    }
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked }).toolPage()
    expect(platform.proxies[0]!.policy('evil.test', 443)).toBe(false)
  })

  it('stops the proxy on close, and the next tool page gets a new one', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    await driver.close()
    expect(platform.proxies.map((p) => p.closed)).toEqual([true])
    await driver.toolPage()
    expect(platform.proxies.map((p) => p.closed)).toEqual([true, false])
    expect(platform.session(TOOL).proxy).toBe(platform.proxies[1]!.handle)
  })

  it('opens no tool window when the proxy fails to start, and tries again next time', async () => {
    const { platform } = browserLike()
    const start = platform.onStartProxy
    platform.onStartProxy = async () => {
      platform.onStartProxy = start
      throw new Error('EADDRINUSE')
    }
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const error = await rejection(driver.toolPage())
    expect(error).toMatchObject({ stage: 'egress', errorClass: 'unavailable' })
    expect(platform.surfaces).toEqual([])
    await expect(driver.toolPage()).resolves.toBeDefined()
    expect(platform.surfaces).toHaveLength(1)
  })

  it('reports a handoff whose tool partition cannot be set up without opening anything', async () => {
    const { platform } = browserLike()
    platform.onStartProxy = async () => {
      throw new Error('EADDRINUSE')
    }
    const error = await rejection(
      new ElectronSessionDriver(platform, OPTIONS).handoff(['www.example.com'], []),
    )
    expect(error).toMatchObject({ stage: 'egress', errorClass: 'unavailable' })
  })
})

describe('partition set-up failures', () => {
  it('turns a platform failure into a ValetError without its message', async () => {
    const { platform } = browserLike()
    platform.session = () => {
      throw new Error('profile directory locked: /Users/nick')
    }
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const auth = await rejection(driver.openAuthPage())
    expect(auth).toMatchObject({ stage: 'navigate', errorClass: 'internal' })
    expect(auth.message).not.toContain('nick')
    expect(await rejection(driver.toolPage())).toMatchObject({ stage: 'egress', errorClass: 'internal' })
    expect(await rejection(driver.sessionSecrets(['www.example.com'], []))).toMatchObject({
      stage: 'session-handoff',
      errorClass: 'internal',
    })
    expect(await rejection(driver.cookieNames(['www.example.com']))).toMatchObject({
      stage: 'session-handoff',
      errorClass: 'internal',
    })
  })

  it('reports a Chrome version it cannot read as a ValetError, from every entry point', async () => {
    const { platform } = browserLike()
    Object.defineProperty(platform, 'chromeVersion', { value: 'unknown' })
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    expect(await rejection(driver.openAuthPage())).toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
    expect(await rejection(driver.toolPage())).toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
    expect(await rejection(driver.handoff(['www.example.com'], []))).toMatchObject({
      stage: 'manifest',
      errorClass: 'invalid',
    })
  })
})

describe('auth partition subframes', () => {
  it('lets subframes load only the navigation origins when no frame origins are given', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, OPTIONS).openAuthPage()
    const surface = platform.surfaces[0]!
    expect(surface.attemptNavigation('https://widget.example.com/', false)).toBe(false)
    expect(surface.attemptNavigation('https://login.example.com/frame', false)).toBe(true)
  })

  it('pins subframes to the navigation and frame origins', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, {
      ...OPTIONS,
      frameOrigins: ['https://captcha.test'],
    }).openAuthPage()
    const surface = platform.surfaces[0]!
    expect(surface.attemptNavigation('https://captcha.test/frame', false)).toBe(true)
    expect(surface.attemptNavigation('https://login.example.com/frame', false)).toBe(true)
    expect(surface.attemptNavigation('https://widget.example.com/', false)).toBe(false)
  })

  it('cancels a subframe request the navigation events never offered, at the network layer', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, {
      ...OPTIONS,
      frameOrigins: ['https://captcha.test'],
    }).openAuthPage()
    const filter = platform.session(AUTH).filter!
    const frame = (url: string) => filter({ url, method: 'GET', resourceType: 'subFrame' })
    expect(frame('https://widget.example.com/')).toBe(false)
    expect(frame('https://captcha.test.evil.test/')).toBe(false)
    expect(frame('http://captcha.test/')).toBe(false)
    expect(frame('https://captcha.test/frame')).toBe(true)
    expect(frame('https://login.example.com/frame')).toBe(true)
  })

  it('leaves the auth page’s own requests alone: the site’s scripts are out of scope there', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, OPTIONS).openAuthPage()
    const filter = platform.session(AUTH).filter!
    expect(filter({ url: 'https://cdn.other.test/app.js', method: 'GET', resourceType: 'script' })).toBe(true)
    expect(filter({ url: 'https://www.example.com/login', method: 'GET', resourceType: 'mainFrame' })).toBe(
      true,
    )
  })

  it('takes the frame origins and site name from the manifest', async () => {
    const manifest = parseManifest({
      schemaVersion: 1,
      id: 'example',
      name: 'Example Shop',
      version: '0.1.0',
      description: 'Example',
      home: 'https://www.example.com/',
      navigation: ['https://www.example.com'],
      egress: ['www.example.com'],
      secrets: {},
      session: { cookieDomains: ['www.example.com'], probe: { kind: 'cookie', name: 'x' } },
      auth: { steps: [{ op: 'assertLoggedIn' }], frameOrigins: ['https://captcha.test'] },
      tools: [{ name: 'trolley', title: 'Trolley', description: 'Reads the trolley', sideEffect: 'read' }],
    })
    const { platform } = browserLike()
    const page = await ElectronSessionDriver.forManifest(platform, manifest).openAuthPage()
    const surface = platform.surfaces[0]!
    expect(surface.attemptNavigation('https://captcha.test/frame', false)).toBe(true)
    expect(surface.attemptNavigation('https://widget.test/frame', false)).toBe(false)
    const handed = page.handToUser('login-required')
    surface.requestClose()
    await handed
    expect(surface.shown).toEqual(['Example Shop needs you to log in. Close this window when you’re done.'])
  })

  it('pins the storage handoff’s helper page the same way', async () => {
    const { platform, storageFor } = browserLike()
    storageFor(AUTH, 'https://login.example.com').set('jwt', 'abc')
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, frameOrigins: [] })
    const makeSurface = platform.makeSurface
    const frameChecks: boolean[] = []
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      const load = surface.onLoad
      surface.onLoad = (url) => {
        if (partition === AUTH)
          frameChecks.push(surface.attemptNavigation('https://widget.example.com/', false))
        return load(url)
      }
      return surface
    }
    await driver.handoff([], [{ origin: 'https://login.example.com', keys: ['jwt'] }])
    expect(frameChecks).toEqual([false])
  })
})

describe('toolPage', () => {
  it('opens once at home and hands out the same page', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const [a, b] = await Promise.all([driver.toolPage(), driver.toolPage()])
    expect(a).toBe(b)
    expect(await driver.toolPage()).toBe(a)
    expect(platform.surfaces).toHaveLength(1)
    expect(a.currentUrl()).toBe('https://www.example.com/')
  })

  it('opens a fresh page once the old window is gone', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const first = await driver.toolPage()
    platform.surfaces[0]!.destroy()
    expect(await driver.toolPage()).not.toBe(first)
    expect(platform.surfaces).toHaveLength(2)
  })

  it('destroys the window and tries again next time when home fails to load', async () => {
    const { platform } = browserLike()
    const makeSurface = platform.makeSurface
    let failNext = true
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      if (failNext) surface.onLoad = () => ({ ok: false, code: 'ERR_CONNECTION_REFUSED' })
      failNext = false
      return surface
    }
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    expect(await rejection(driver.toolPage())).toMatchObject({ stage: 'navigate', errorClass: 'unavailable' })
    expect(platform.surfaces[0]!.isDestroyed()).toBe(true)
    await expect(driver.toolPage()).resolves.toBeDefined()
  })
})

describe('handoff: cookies', () => {
  it('copies cookies for the listed domains from auth to tool, keeping their attributes', async () => {
    const { platform } = browserLike()
    const auth = platform.session(AUTH)
    auth.cookies = [
      tokenCookie,
      { ...tokenCookie, name: '_abck', value: 'akamai', domain: '.example.com', hostOnly: false },
      { ...tokenCookie, name: 'ads', value: 'tracker', domain: '.ads.test', hostOnly: false },
    ]
    await new ElectronSessionDriver(platform, OPTIONS).handoff(['www.example.com', 'example.com'], [])
    expect(platform.session(TOOL).setCalls).toEqual([
      {
        url: 'https://www.example.com/',
        name: 'wow-auth-token',
        value: 'session-token-value',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1_900_000_000,
      },
      {
        url: 'https://example.com/',
        name: '_abck',
        value: 'akamai',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1_900_000_000,
      },
    ])
  })

  it('never writes to the auth partition or reads the tool partition’s cookies', async () => {
    const { platform } = browserLike()
    platform.session(AUTH).cookies = [tokenCookie]
    const tool = platform.session(TOOL)
    tool.cookies = [{ ...tokenCookie, value: 'planted-by-tool-code' }]
    await new ElectronSessionDriver(platform, OPTIONS).handoff(['www.example.com'], [])
    expect(platform.session(AUTH).setCalls).toEqual([])
    expect(tool.getCalls).toBe(0)
  })

  it('reports a cookie store failure as session-handoff/internal', async () => {
    const { platform } = browserLike()
    platform.session(AUTH).getCookies = async () => {
      throw new Error('cookie db locked')
    }
    const error = await rejection(
      new ElectronSessionDriver(platform, OPTIONS).handoff(['www.example.com'], []),
    )
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'internal' })
  })
})

describe('handoff: storage', () => {
  it('reads keys in the open auth page and writes them through a short-lived tool page', async () => {
    const { platform, storageFor } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const authPage = await driver.openAuthPage()
    await authPage.goto('https://www.example.com/login')
    storageFor(AUTH, 'https://www.example.com').set('token', 'storage-token').set('other', 'not-asked-for')
    await driver.handoff([], [{ origin: 'https://www.example.com', keys: ['token', 'missing'] }])
    expect([...storageFor(TOOL, 'https://www.example.com')]).toEqual([['token', 'storage-token']])
    const [authSurface, toolHelper] = platform.surfaces
    expect(authSurface!.loads).toEqual(['https://www.example.com/login'])
    expect(toolHelper!.partition).toBe(TOOL)
    expect(toolHelper!.loads).toEqual(['https://www.example.com/robots.txt'])
    expect(toolHelper!.isDestroyed()).toBe(true)
  })

  it('only reads on the auth side and only writes on the tool side', async () => {
    const { platform, storageFor } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await (await driver.openAuthPage()).goto('https://www.example.com/')
    await driver.toolPage()
    storageFor(AUTH, 'https://www.example.com').set('token', 'from-auth')
    storageFor(TOOL, 'https://www.example.com').set('token', 'planted-by-tool-code')
    await driver.handoff([], [{ origin: 'https://www.example.com', keys: ['token'] }])
    expect(storageFor(AUTH, 'https://www.example.com').get('token')).toBe('from-auth')
    expect(storageFor(TOOL, 'https://www.example.com').get('token')).toBe('from-auth')
    const authScripts = platform.surfaces[0]!.frameList[0]!.scripts
    const toolScripts = platform.surfaces[1]!.frameList[0]!.scripts
    expect(authScripts.every((s) => !s.includes('setItem'))).toBe(true)
    expect(toolScripts.every((s) => !s.includes('getItem'))).toBe(true)
    // The open tool page was reused rather than a helper opened.
    expect(platform.surfaces).toHaveLength(2)
  })

  it('opens a short-lived auth page when none is on the origin, at the configured path', async () => {
    const { platform, storageFor } = browserLike()
    storageFor(AUTH, 'https://login.example.com').set('jwt', 'abc')
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, storageDocumentPath: '/favicon.ico' })
    await driver.handoff([], [{ origin: 'https://login.example.com', keys: ['jwt'] }])
    expect(platform.surfaces.map((s) => [s.partition, s.loads, s.isDestroyed()])).toEqual([
      [AUTH, ['https://login.example.com/favicon.ico'], true],
      [TOOL, ['https://login.example.com/favicon.ico'], true],
    ])
    expect(storageFor(TOOL, 'https://login.example.com').get('jwt')).toBe('abc')
  })

  it('opens nothing on the tool side when none of the keys exist', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, OPTIONS).handoff(
      [],
      [{ origin: 'https://www.example.com', keys: ['token'] }],
    )
    expect(platform.surfaces.map((s) => s.partition)).toEqual([AUTH])
  })

  it('refuses an origin off the navigation list, without opening anything', async () => {
    const { platform } = browserLike()
    const error = await rejection(
      new ElectronSessionDriver(platform, OPTIONS).handoff(
        [],
        [{ origin: 'https://evil.test', keys: ['token'] }],
      ),
    )
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'origin-mismatch' })
    expect(platform.surfaces).toEqual([])
  })

  it('refuses something that is not a bare https origin', async () => {
    const { platform } = browserLike()
    for (const origin of ['https://www.example.com/path', 'http://www.example.com', 'www.example.com']) {
      const error = await rejection(
        new ElectronSessionDriver(platform, OPTIONS).handoff([], [{ origin, keys: ['t'] }]),
      )
      expect(error, origin).toMatchObject({ stage: 'session-handoff', errorClass: 'invalid' })
    }
  })

  it('refuses an origin the tool partition may not reach', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, egress: ['www.example.com'] })
    const error = await rejection(driver.handoff([], [{ origin: 'https://login.example.com', keys: ['t'] }]))
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'host-not-allowed' })
  })

  it('refuses when the helper page ends up on another origin, and destroys it', async () => {
    const { platform } = browserLike()
    const makeSurface = platform.makeSurface
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      const load = surface.onLoad
      // A redirect to another listed origin: allowed by the guard, but not where the keys live.
      surface.onLoad = () => load('https://login.example.com/elsewhere')
      return surface
    }
    const error = await rejection(
      new ElectronSessionDriver(platform, OPTIONS).handoff(
        [],
        [{ origin: 'https://www.example.com', keys: ['t'] }],
      ),
    )
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'origin-mismatch' })
    expect(platform.surfaces[0]!.isDestroyed()).toBe(true)
  })

  it('reports a helper page that fails to load as unavailable', async () => {
    const { platform } = browserLike()
    const makeSurface = platform.makeSurface
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      surface.onLoad = () => ({ ok: false, code: 'ERR_CONNECTION_REFUSED' })
      return surface
    }
    const error = await rejection(
      new ElectronSessionDriver(platform, OPTIONS).handoff(
        [],
        [{ origin: 'https://www.example.com', keys: ['t'] }],
      ),
    )
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'unavailable' })
    expect(platform.surfaces[0]!.isDestroyed()).toBe(true)
  })

  it('does not trust a malformed answer from the auth page', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await (await driver.openAuthPage()).goto('https://www.example.com/')
    platform.surfaces[0]!.frameList[0]!.run = async () => 'token=abc'
    const error = await rejection(driver.handoff([], [{ origin: 'https://www.example.com', keys: ['t'] }]))
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'internal' })
  })

  it('reports a failing script in an open page as internal', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await (await driver.openAuthPage()).goto('https://www.example.com/')
    platform.surfaces[0]!.frameList[0]!.fail = true
    const error = await rejection(driver.handoff([], [{ origin: 'https://www.example.com', keys: ['t'] }]))
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'internal' })
  })

  it('reports an open page with no frame as internal', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await (await driver.openAuthPage()).goto('https://www.example.com/')
    const surface = platform.surfaces[0]!
    const frames = surface.frameList
    let calls = 0
    // Present when the driver picks the page, gone by the time it runs the script.
    surface.frames = () => (calls++ === 0 ? frames : [])
    const error = await rejection(driver.handoff([], [{ origin: 'https://www.example.com', keys: ['t'] }]))
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'internal' })
  })
})

describe('sessionSecrets', () => {
  it('lists the tool partition’s cookie values on the domains, once each, without empties', async () => {
    const { platform } = browserLike()
    platform.session(TOOL).cookies = [
      tokenCookie,
      { ...tokenCookie, name: 'dup', value: 'session-token-value' },
      { ...tokenCookie, name: 'empty', value: '' },
      { ...tokenCookie, name: 'ads', value: 'tracker', domain: '.ads.test' },
    ]
    expect(
      await new ElectronSessionDriver(platform, OPTIONS).sessionSecrets(['www.example.com'], []),
    ).toEqual(['session-token-value'])
  })

  it('adds the storage values it handed off, even once the tool page has gone', async () => {
    const { platform, storageFor } = browserLike()
    storageFor(AUTH, 'https://login.example.com').set('jwt', 'storage-token').set('other', 'not-asked-for')
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.handoff([], [{ origin: 'https://login.example.com', keys: ['jwt', 'other'] }])
    const storage = [{ origin: 'https://login.example.com', keys: ['jwt'] }]
    expect(await driver.sessionSecrets([], storage)).toEqual(['storage-token'])
    // Every page the handoff opened is gone, so this came from what the driver remembered.
    expect(platform.surfaces.every((s) => s.isDestroyed())).toBe(true)
  })

  it('adds the current values in the open tool page, where the site may have rotated them', async () => {
    const { platform, storageFor } = browserLike()
    storageFor(AUTH, 'https://www.example.com').set('token', 'first')
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    await driver.handoff([], [{ origin: 'https://www.example.com', keys: ['token'] }])
    storageFor(TOOL, 'https://www.example.com').set('token', 'rotated')
    const secrets = await driver.sessionSecrets([], [{ origin: 'https://www.example.com', keys: ['token'] }])
    expect([...secrets].sort()).toEqual(['first', 'rotated'])
  })

  it('still lists a handed-off cookie value after the tool page overwrote it', async () => {
    const { platform } = browserLike()
    platform.session(AUTH).cookies = [tokenCookie]
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.handoff(['www.example.com'], [])
    // document.cookie = 'wow-auth-token=x': the store now holds only the new value.
    platform.session(TOOL).cookies = [{ ...tokenCookie, value: 'overwritten-by-tool' }]
    const secrets = await driver.sessionSecrets(['www.example.com'], [])
    expect([...secrets].sort()).toEqual(['overwritten-by-tool', 'session-token-value'])
  })

  it('still lists a cookie the site rotated mid-run after tool code expired it', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    const tool = platform.session(TOOL)
    // Set-Cookie rotates the session, then document.cookie = 'sid=; max-age=0' removes it: each
    // change event carries the value, the removal the one removed.
    tool.emitCookie({ ...tokenCookie, value: 'rotated-mid-run' })
    tool.emitCookie({ ...tokenCookie, value: 'rotated-mid-run' })
    tool.cookies = []
    expect(await driver.sessionSecrets(['www.example.com'], [])).toEqual(['rotated-mid-run'])
  })

  it('lists only the remembered cookie values on the domains asked for', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    platform.session(TOOL).emitCookie({ ...tokenCookie, name: 'ads', value: 'tracker', domain: '.ads.test' })
    expect(await driver.sessionSecrets(['www.example.com'], [])).toEqual([])
  })

  it('still lists a storage value the site rotated after tool code overwrote it', async () => {
    const { platform, storageFor } = browserLike()
    storageFor(AUTH, 'https://www.example.com').set('token', 'handed-off')
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    await driver.handoff([], [{ origin: 'https://www.example.com', keys: ['token'] }])
    const surface = platform.surfaces.find((s) => s.partition === TOOL && !s.isDestroyed())!
    const tool = storageFor(TOOL, 'https://www.example.com')
    // The site rotates the token; tool code reads it and overwrites it before anyone asks.
    tool.set('token', 'rotated')
    surface.emitStorage({ origin: 'https://www.example.com', key: 'token', value: 'rotated' })
    tool.set('token', 'decoy')
    surface.emitStorage({ origin: 'https://www.example.com', key: 'token', value: 'rotated' })
    surface.emitStorage({ origin: 'https://www.example.com', key: 'token', value: 'decoy' })
    const secrets = await driver.sessionSecrets([], [{ origin: 'https://www.example.com', keys: ['token'] }])
    expect([...secrets].sort()).toEqual(['decoy', 'handed-off', 'rotated'])
  })

  it('waits for storage events still on their way before it answers', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    const storage = [{ origin: 'https://www.example.com', keys: ['token'] }]
    await driver.sessionSecrets([], storage)
    platform.surfaces[0]!.pendingStorage.push({
      origin: 'https://www.example.com',
      key: 'token',
      value: 'late',
    })
    expect(await driver.sessionSecrets([], storage)).toEqual(['late'])
  })

  it('records no storage write to a key nobody asked to hand off or redact', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    platform.surfaces[0]!.emitStorage({ origin: 'https://www.example.com', key: 'token', value: 'early' })
    platform.surfaces[0]!.emitStorage({ origin: 'https://www.example.com', key: 'theme', value: 'dark' })
    const storage = [{ origin: 'https://www.example.com', keys: ['token'] }]
    expect(await driver.sessionSecrets([], storage)).toEqual([])
    platform.surfaces[0]!.emitStorage({ origin: 'https://www.example.com', key: 'token', value: 'later' })
    expect(await driver.sessionSecrets([], storage)).toEqual(['later'])
  })

  it('reads the watched keys when a run begins and ends, before tool code can remove them', async () => {
    const { platform, storageFor } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    const storage = [{ origin: 'https://www.example.com', keys: ['token'] }]
    await driver.sessionSecrets([], storage)
    const tool = storageFor(TOOL, 'https://www.example.com')
    // Left from an earlier app session: never written while the driver watched.
    tool.set('token', 'persisted')
    driver.beginRun(READ_RUN, () => {})
    tool.delete('token')
    expect(await driver.sessionSecrets([], storage)).toEqual(['persisted'])
    tool.set('token', 'second')
    driver.endRun()
    tool.delete('token')
    expect([...(await driver.sessionSecrets([], storage))].sort()).toEqual(['persisted', 'second'])
  })

  it('reads nothing when a run begins with no tool page open or no watched key', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    driver.beginRun(READ_RUN, () => {})
    await driver.toolPage()
    const frame = platform.surfaces[0]!.frameList[0]!
    driver.endRun()
    expect(frame.scripts).toEqual([])
  })

  it('ignores a run-start read that fails or answers nonsense', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    const storage = [{ origin: 'https://www.example.com', keys: ['token'] }]
    await driver.sessionSecrets([], storage)
    const frame = platform.surfaces[0]!.frameList[0]!
    const run = frame.run.bind(frame)
    frame.run = async () => {
      throw new Error('frame detached')
    }
    driver.beginRun(READ_RUN, () => {})
    frame.run = async () => 'nonsense'
    driver.endRun()
    frame.run = run
    expect(await driver.sessionSecrets([], storage)).toEqual([])
  })

  it('reports storage events that cannot be settled as internal', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    platform.surfaces[0]!.onStorageSettled = async () => {
      throw new Error('Target closed: /Users/nick')
    }
    const error = await rejection(
      driver.sessionSecrets([], [{ origin: 'https://www.example.com', keys: ['token'] }]),
    )
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'internal' })
    expect(error.message).not.toContain('nick')
  })

  it('opens no page to look, and never reads the auth partition', async () => {
    const { platform, storageFor } = browserLike()
    storageFor(AUTH, 'https://www.example.com').set('token', 'auth-only')
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    expect(await driver.sessionSecrets([], [{ origin: 'https://www.example.com', keys: ['token'] }])).toEqual(
      [],
    )
    expect(platform.surfaces).toEqual([])
  })

  it('refuses something that is not a bare https origin', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    for (const origin of ['https://www.example.com/path', 'http://www.example.com', 'nope']) {
      const error = await rejection(driver.sessionSecrets([], [{ origin, keys: ['t'] }]))
      expect(error, origin).toMatchObject({ stage: 'session-handoff', errorClass: 'invalid' })
    }
  })

  it('does not trust a malformed answer from the tool page', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.toolPage()
    platform.surfaces[0]!.frameList[0]!.run = async () => 'token=abc'
    const error = await rejection(
      driver.sessionSecrets([], [{ origin: 'https://www.example.com', keys: ['token'] }]),
    )
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'internal' })
  })

  it('reports a cookie store failure as session-handoff/internal', async () => {
    const { platform } = browserLike()
    platform.session(TOOL).getCookies = async () => {
      throw new Error('locked')
    }
    const error = await rejection(
      new ElectronSessionDriver(platform, OPTIONS).sessionSecrets(['x.example.com'], []),
    )
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'internal' })
  })
})

describe('cookieNames', () => {
  it('lists the names, never the values, of the tool partition’s cookies on the domains', async () => {
    const { platform } = browserLike()
    platform.session(TOOL).cookies = [
      tokenCookie,
      { ...tokenCookie, value: 'second-copy', path: '/account' },
      { ...tokenCookie, name: '_abck', value: 'akamai', domain: '.example.com', hostOnly: false },
      { ...tokenCookie, name: 'ads', value: 'tracker', domain: '.ads.test' },
    ]
    const names = await new ElectronSessionDriver(platform, OPTIONS).cookieNames([
      'www.example.com',
      'example.com',
    ])
    expect(names).toEqual(['wow-auth-token', '_abck'])
    expect(JSON.stringify(names)).not.toContain('session-token-value')
  })

  it('never reads the auth partition', async () => {
    const { platform } = browserLike()
    platform.session(AUTH).cookies = [tokenCookie]
    expect(await new ElectronSessionDriver(platform, OPTIONS).cookieNames(['www.example.com'])).toEqual([])
    expect(platform.session(AUTH).getCalls).toBe(0)
  })
})

describe('close', () => {
  it('destroys every window it opened, and can open new ones after', async () => {
    const { platform } = browserLike()
    const timers = new ManualTimers()
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, timers })
    await driver.openAuthPage()
    await driver.openAuthPage()
    await driver.toolPage()
    await driver.close()
    expect(platform.surfaces.map((s) => s.isDestroyed())).toEqual([true, true, true])
    await driver.toolPage()
    expect(platform.surfaces).toHaveLength(4)
  })

  it('forgets an auth page whose window was destroyed elsewhere', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    platform.surfaces[0]!.destroy()
    await driver.close()
    expect(platform.surfaces[0]!.isDestroyed()).toBe(true)
  })
})

describe('auth page probe', () => {
  it('fetches through the auth partition’s session, presenting as the page: hints, clean UA, en-AU', async () => {
    const { platform } = browserLike()
    const page = await new ElectronSessionDriver(platform, {
      ...OPTIONS,
      clientHints: 'engine',
    }).openAuthPage()
    await page.goto('https://www.example.com/login')
    await page.fetch('https://www.example.com/api/ui/v2/bootstrap')
    const auth = platform.session(AUTH)
    expect(auth.fetches.map((f) => f.url)).toEqual(['https://www.example.com/api/ui/v2/bootstrap'])
    expect(auth.fetches[0]?.headers).toEqual([
      ['sec-ch-ua-platform', '"macOS"'],
      [
        'User-Agent',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      ],
      ['sec-ch-ua', '"Not_A Brand";v="99", "Chromium";v="142"'],
      ['Accept-Language', 'en-AU,en;q=0.9'],
      ['sec-ch-ua-mobile', '?0'],
      ['Accept', '*/*'],
      ['Sec-Fetch-Site', 'same-origin'],
      ['Sec-Fetch-Mode', 'cors'],
      ['Sec-Fetch-Dest', 'empty'],
    ])
    expect(auth.fetches[0]).toMatchObject({
      initiator: 'https://www.example.com',
      referrer: 'https://www.example.com/login',
    })
    // The tool partition is never touched by the auth probe.
    expect(platform.sessions.has(TOOL)).toBe(false)
  })

  it('names Google Chrome in the probe’s client hints only when the pages’ do (D24a)', async () => {
    const { platform } = browserLike()
    const page = await new ElectronSessionDriver(platform, {
      ...OPTIONS,
      clientHints: 'chrome',
    }).openAuthPage()
    await page.fetch('https://www.example.com/api')
    const brands = new Map(platform.session(AUTH).fetches[0]?.headers).get('sec-ch-ua')
    const override = chromeUserAgentOverride(platform, 'chrome')
    expect(brands).toBe(
      override.userAgentMetadata.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    )
    expect(brands).toContain('"Google Chrome";v="142"')
  })

  it('restates no UA or hints with Electron’s own, leaving the session’s', async () => {
    const { platform } = browserLike()
    const page = await new ElectronSessionDriver(platform, {
      ...OPTIONS,
      userAgent: 'electron',
    }).openAuthPage()
    await page.fetch('https://www.example.com/api')
    expect(platform.session(AUTH).fetches[0]?.headers).toEqual([
      ['Accept', '*/*'],
      ['Sec-Fetch-Site', 'same-origin'],
      ['Sec-Fetch-Mode', 'cors'],
      ['Sec-Fetch-Dest', 'empty'],
    ])
  })

  it('cancels a probe in flight on close(), failing it as aborted', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const page = await driver.openAuthPage()
    const signals: AbortSignal[] = []
    let answer: (response: SessionFetchResponse) => void = () => {}
    platform.session(AUTH).onFetch = (request) => {
      signals.push(request.signal)
      return new Promise((resolve) => {
        answer = resolve
      })
    }
    const pending = rejection(page.fetch('https://www.example.com/api'))
    await flush()
    await driver.close()
    expect(signals.map((signal) => signal.aborted)).toEqual([true])
    answer({ kind: 'response', status: 200, contentType: null, body: new Uint8Array() })
    expect(await pending).toMatchObject({ stage: 'probe', errorClass: 'aborted' })
  })

  it('holds the probe to the driver’s navigation origins', async () => {
    const { platform } = browserLike()
    const page = await new ElectronSessionDriver(platform, OPTIONS).openAuthPage()
    const error = await rejection(page.fetch('https://cdn.example.com/api'))
    expect(error).toMatchObject({ stage: 'probe', errorClass: 'host-not-allowed' })
    expect(platform.session(AUTH).fetches).toEqual([])
  })

  it('lists the auth partition’s cookie names, not the tool partition’s', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    platform.session(AUTH).cookies = [{ ...tokenCookie, name: 'auth-only' }]
    platform.session(TOOL).cookies = [{ ...tokenCookie, name: 'tool-only' }]
    const page = await driver.openAuthPage()
    expect(await page.cookieNames(['www.example.com'])).toEqual(['auth-only'])
    expect(await driver.cookieNames(['www.example.com'])).toEqual(['tool-only'])
  })
})

describe('auth partition block reports', () => {
  const frameRequest = (url: string) => ({ url, method: 'GET', resourceType: 'subFrame' })

  it('reports the guard’s and the request filter’s refusals to onAuthBlocked, as the page’s', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, {
      ...OPTIONS,
      onAuthBlocked: (b) => blocked.push(b),
    }).openAuthPage()
    const surface = platform.surfaces[0]!
    surface.attemptNavigation('https://evil.test/landing?c=1', true)
    platform.session(AUTH).filter!(frameRequest('https://widget.test/frame?t=2'))
    expect(blocked).toEqual([
      { method: 'GET', target: 'https://evil.test', reason: 'host-not-allowed', initiator: 'page' },
      { method: 'GET', target: 'https://widget.test', reason: 'host-not-allowed', initiator: 'page' },
    ])
  })

  it('never sends auth refusals to the tool partition’s reporters', async () => {
    const { platform } = browserLike()
    const toolBlocked: BlockedRequest[] = []
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked: (b) => toolBlocked.push(b) })
    driver.beginRun({ egress: OPTIONS.egress, requests: [], maxPurpose: 'read', ceiling: 5 }, (b) =>
      toolBlocked.push(b),
    )
    await driver.openAuthPage()
    platform.surfaces[0]!.attemptNavigation('https://evil.test/', true)
    platform.session(AUTH).filter!(frameRequest('https://widget.test/'))
    expect(toolBlocked).toEqual([])
  })

  it('gives a page’s own reporter its refusals instead of onAuthBlocked', async () => {
    const { platform } = browserLike()
    const fallback: BlockedRequest[] = []
    const mine: BlockedRequest[] = []
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, onAuthBlocked: (b) => fallback.push(b) })
    await driver.openAuthPage({ onBlocked: (b) => mine.push(b) })
    platform.surfaces[0]!.attemptNavigation('https://evil.test/', true)
    platform.session(AUTH).filter!(frameRequest('https://widget.test/'))
    expect(mine.map((b) => b.target)).toEqual(['https://evil.test', 'https://widget.test'])
    expect(fallback).toEqual([])
  })

  it('sends a filter refusal to the newest open page, and to onAuthBlocked once none is open', async () => {
    const { platform } = browserLike()
    const fallback: BlockedRequest[] = []
    const first: BlockedRequest[] = []
    const second: BlockedRequest[] = []
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, onAuthBlocked: (b) => fallback.push(b) })
    const one = await driver.openAuthPage({ onBlocked: (b) => first.push(b) })
    const two = await driver.openAuthPage({ onBlocked: (b) => second.push(b) })
    const filter = platform.session(AUTH).filter!
    filter(frameRequest('https://a.test/'))
    await two.close()
    filter(frameRequest('https://b.test/'))
    await one.close()
    filter(frameRequest('https://c.test/'))
    expect(second.map((b) => b.target)).toEqual(['https://a.test'])
    expect(first.map((b) => b.target)).toEqual(['https://b.test'])
    expect(fallback.map((b) => b.target)).toEqual(['https://c.test'])
  })

  it('keeps each page’s guard refusals with that page, whichever is newest', async () => {
    const { platform } = browserLike()
    const first: BlockedRequest[] = []
    const second: BlockedRequest[] = []
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage({ onBlocked: (b) => first.push(b) })
    await driver.openAuthPage({ onBlocked: (b) => second.push(b) })
    platform.surfaces[0]!.attemptNavigation('https://evil.test/', true)
    expect(first.map((b) => b.target)).toEqual(['https://evil.test'])
    expect(second).toEqual([])
  })

  it('reports each distinct refusal once per page, however often it is offered', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, OPTIONS).openAuthPage({ onBlocked: (b) => blocked.push(b) })
    const surface = platform.surfaces[0]!
    // will-frame-navigate and will-navigate both offer a main-frame navigation; a page may retry.
    for (let i = 0; i < 3; i++) surface.attemptNavigation(`https://evil.test/try-${i}`, true)
    for (let i = 0; i < 3; i++) platform.session(AUTH).filter!(frameRequest(`https://widget.test/${i}`))
    expect(blocked.map((b) => b.target)).toEqual(['https://evil.test', 'https://widget.test'])
  })

  it('reports at most 200 distinct subframe refusals per page, still refuses past that, and says so once', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    let dropped = 0
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage({ onBlocked: (b) => blocked.push(b), onReportsDropped: () => dropped++ })
    const surface = platform.surfaces[0]!
    for (let i = 0; i < 250; i++) {
      expect(surface.attemptNavigation(`https://w${i}.evil.test/`, false)).toBe(false)
    }
    expect(blocked).toHaveLength(200)
    expect(dropped).toBe(1)
    expect(driver.droppedAuthReports()).toBe(50)
  })

  it('still reports an escape after the subframe budget is spent, apart from an earlier widget', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, OPTIONS).openAuthPage({ onBlocked: (b) => blocked.push(b) })
    const surface = platform.surfaces[0]!
    // The escape's origin was refused as a widget first: the same method, target and reason.
    surface.attemptNavigation('https://evil.test/widget', false)
    for (let i = 0; i < 250; i++) platform.session(AUTH).filter!(frameRequest(`https://w${i}.evil.test/`))
    expect(surface.attemptNavigation('https://evil.test/landing', true)).toBe(false)
    expect(blocked).toHaveLength(201)
    expect(blocked[0]?.target).toBe('https://evil.test')
    expect(blocked[200]).toEqual({
      method: 'GET',
      target: 'https://evil.test',
      reason: 'host-not-allowed',
      initiator: 'page',
    })
  })

  it('budgets a poisoned page’s repeated escapes on their own, and counts what it drops', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    let dropped = 0
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, onAuthReportsDropped: () => dropped++ })
    await driver.openAuthPage({ onBlocked: (b) => blocked.push(b) })
    const surface = platform.surfaces[0]!
    for (let i = 0; i < 60; i++)
      expect(surface.attemptNavigation(`https://e${i}.evil.test/`, true)).toBe(false)
    expect(blocked).toHaveLength(50)
    expect(driver.droppedAuthReports()).toBe(10)
    // The page brought its own reporter but no drop callback: onAuthReportsDropped is onAuthBlocked's.
    expect(dropped).toBe(0)
  })

  it('tells onAuthReportsDropped when onAuthBlocked’s own budget is spent', async () => {
    const { platform } = browserLike()
    let dropped = 0
    const driver = new ElectronSessionDriver(platform, {
      ...OPTIONS,
      onAuthBlocked: () => {},
      onAuthReportsDropped: () => {
        dropped++
        throw new Error('audit log full')
      },
    })
    await driver.openAuthPage()
    const surface = platform.surfaces[0]!
    for (let i = 0; i < 210; i++)
      expect(surface.attemptNavigation(`https://w${i}.evil.test/`, false)).toBe(false)
    expect(dropped).toBe(1)
  })

  it('still refuses when the reporter throws', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, {
      ...OPTIONS,
      onAuthBlocked: () => {
        throw new Error('audit log full')
      },
    })
    await driver.openAuthPage()
    expect(platform.surfaces[0]!.attemptNavigation('https://widget.test/', false)).toBe(false)
    expect(platform.session(AUTH).filter!(frameRequest('https://widget.test/'))).toBe(false)
  })

  it('reports nothing, and still refuses, with no reporter at all', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, OPTIONS).openAuthPage()
    expect(platform.surfaces[0]!.attemptNavigation('https://evil.test/', true)).toBe(false)
    expect(platform.session(AUTH).filter!(frameRequest('https://widget.test/'))).toBe(false)
  })

  it('forgets a page’s reporter when the page closes, and every page’s on close()', async () => {
    const { platform } = browserLike()
    const fallback: BlockedRequest[] = []
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, onAuthBlocked: (b) => fallback.push(b) })
    const mine: BlockedRequest[] = []
    await driver.openAuthPage({ onBlocked: (b) => mine.push(b) })
    await driver.close()
    platform.session(AUTH).filter!(frameRequest('https://widget.test/'))
    expect(mine).toEqual([])
    expect(fallback.map((b) => b.target)).toEqual(['https://widget.test'])
  })

  it('sends filter refusals to the login page, not to a handoff helper open beside it', async () => {
    const { platform, storageFor } = browserLike()
    storageFor(AUTH, 'https://login.example.com').set('jwt', 'abc')
    const mine: BlockedRequest[] = []
    // No onAuthBlocked: a refusal routed to the helper would have nowhere to go.
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const page = await driver.openAuthPage({ onBlocked: (b) => mine.push(b) })
    await page.goto('https://www.example.com/login')
    const filter = platform.session(AUTH).filter!
    const makeSurface = platform.makeSurface
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      const load = surface.onLoad
      surface.onLoad = (url) => {
        const result = load(url)
        // The login page's widget is refused at the network layer while the helper is the newest page.
        if (partition === AUTH) filter(frameRequest('https://widget.test/frame'))
        // And the helper's own refused frame goes where the filter's would: the login page's reporter.
        if (partition === AUTH) surface.attemptNavigation('https://helper-widget.test/', false)
        return result
      }
      return surface
    }
    await driver.handoff([], [{ origin: 'https://login.example.com', keys: ['jwt'] }])
    expect(mine.map((b) => b.target)).toEqual(['https://widget.test', 'https://helper-widget.test'])
  })

  it('passes over a newer page with no reporter for one that has one', async () => {
    const { platform } = browserLike()
    const mine: BlockedRequest[] = []
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage({ onBlocked: (b) => mine.push(b) })
    await driver.openAuthPage()
    platform.session(AUTH).filter!(frameRequest('https://widget.test/'))
    expect(mine.map((b) => b.target)).toEqual(['https://widget.test'])
  })

  it('reports the storage handoff helper page’s refusals to onAuthBlocked, and forgets it afterwards', async () => {
    const { platform, storageFor } = browserLike()
    storageFor(AUTH, 'https://login.example.com').set('jwt', 'abc')
    const fallback: BlockedRequest[] = []
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, onAuthBlocked: (b) => fallback.push(b) })
    const makeSurface = platform.makeSurface
    platform.makeSurface = (partition) => {
      const surface = makeSurface(partition)
      const load = surface.onLoad
      surface.onLoad = (url) => {
        if (partition === AUTH) surface.attemptNavigation('https://widget.example.com/', false)
        return load(url)
      }
      return surface
    }
    await driver.handoff([], [{ origin: 'https://login.example.com', keys: ['jwt'] }])
    expect(fallback.map((b) => b.target)).toEqual(['https://widget.example.com'])
    // The helper is gone: a later filter refusal goes to onAuthBlocked again, not to a dead page.
    platform.session(AUTH).filter!(frameRequest('https://other.test/'))
    expect(fallback.map((b) => b.target)).toEqual(['https://widget.example.com', 'https://other.test'])
  })
})

describe('the site’s breaker (D55)', () => {
  function watched() {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const refusals: SiteRefusal[] = []
    const breaker = { open: false }
    driver.watchSite({
      refused: (refusal) => {
        refusals.push(refusal)
        breaker.open = true
      },
      held: () => breaker.open,
    })
    return { platform, driver, refusals, breaker }
  }

  it('reports a block signature from either partition, with no query string', async () => {
    const { platform, driver, refusals } = watched()
    await driver.openAuthPage()
    await driver.toolPage()
    platform.session(AUTH).respond({ url: 'https://login.example.com/u/login/password?state=s', status: 403 })
    platform.session(TOOL).respond({
      url: 'https://www.example.com/apis/ui/Trolley?x=1',
      status: 429,
      resourceType: 'xhr',
      contentType: 'application/json',
    })
    expect(refusals).toEqual([
      {
        partition: 'auth',
        cause: 'blocked-by-site',
        status: 403,
        target: 'https://login.example.com/u/login/password',
        resourceType: 'mainFrame',
      },
      {
        partition: 'tool',
        cause: 'rate-limited',
        status: 429,
        target: 'https://www.example.com/apis/ui/Trolley',
        resourceType: 'xhr',
      },
    ])
  })

  it('ignores answers that are not the site refusing us', async () => {
    const { platform, driver, refusals } = watched()
    await driver.openAuthPage()
    await driver.toolPage()
    const tool = platform.session(TOOL)
    tool.respond({ url: 'https://www.example.com/', status: 200 })
    // A JSON 403 is an API's own answer; an image's 403 says nothing about us; a widget is not the site.
    tool.respond({
      url: 'https://www.example.com/api',
      status: 403,
      resourceType: 'xhr',
      contentType: 'application/json',
    })
    tool.respond({ url: 'https://www.example.com/a.png', status: 403, resourceType: 'image' })
    platform.session(AUTH).respond({ url: 'https://captcha.example.net/', status: 429 })
    tool.respond({ url: 'not a url', status: 429 })
    expect(refusals).toEqual([])
  })

  it('sends nothing from the tool partition while the breaker holds, without reporting each request', async () => {
    const { platform, driver, breaker } = watched()
    const reported: BlockedRequest[] = []
    driver.beginRun({ egress: OPTIONS.egress, requests: [], maxPurpose: 'read', ceiling: 10 }, (blocked) =>
      reported.push(blocked),
    )
    await driver.toolPage()
    const filter = platform.session(TOOL).filter!
    const home = { url: 'https://www.example.com/', method: 'GET', resourceType: 'mainFrame' }
    expect(filter(home)).toBe(true)
    breaker.open = true
    expect(filter(home)).toBe(false)
    expect(filter({ url: 'https://www.example.com/a.js', method: 'GET', resourceType: 'script' })).toBe(false)
    expect(reported).toEqual([])
  })

  it('holds when the watcher fails, and survives a reporter that throws', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    driver.watchSite({
      refused: () => {
        throw new Error('boom')
      },
      held: () => {
        throw new Error('boom')
      },
    })
    await driver.toolPage()
    const tool = platform.session(TOOL)
    expect(() => tool.respond({ url: 'https://www.example.com/', status: 429 })).not.toThrow()
    expect(tool.filter!({ url: 'https://www.example.com/', method: 'GET', resourceType: 'mainFrame' })).toBe(
      false,
    )
  })

  it('reports nothing before a watcher is connected', async () => {
    const { platform, driver } = (() => {
      const { platform } = browserLike()
      return { platform, driver: new ElectronSessionDriver(platform, OPTIONS) }
    })()
    await driver.toolPage()
    expect(() =>
      platform.session(TOOL).respond({ url: 'https://www.example.com/', status: 429 }),
    ).not.toThrow()
  })
})

describe('pacing the tool partition’s navigations (D55)', () => {
  function paced(open = { value: false }) {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const waits: string[] = []
    let release: () => void = () => {}
    driver.watchSite({
      refused: () => {},
      held: () => open.value,
      pace: () => {
        waits.push('pace')
        return new Promise<void>((resolve) => {
          release = resolve
        })
      },
    })
    return { platform, driver, waits, open, release: () => release() }
  }
  const nav = (url: string, id: number) => ({ url, method: 'GET', resourceType: 'mainFrame', id })

  it('holds a navigation the page starts until the budget lets it go', async () => {
    const { platform, driver, waits, release } = paced()
    await driver.toolPage()
    const filter = platform.session(TOOL).filter!
    const decision = filter(nav('https://www.example.com/shop', 1))
    expect(decision).toBeInstanceOf(Promise)
    await flush()
    expect(waits).toEqual(['pace'])
    release()
    expect(await decision).toBe(true)
  })

  it('counts a server redirect chain as one navigation, and paces nothing else', async () => {
    const { platform, driver, waits } = paced()
    await driver.toolPage()
    const filter = platform.session(TOOL).filter!
    void filter(nav('https://www.example.com/a', 7))
    expect(filter(nav('https://login.example.com/b', 7))).toBe(true)
    expect(
      filter({ url: 'https://www.example.com/a.js', method: 'GET', resourceType: 'script', id: 8 }),
    ).toBe(true)
    await flush()
    expect(waits).toEqual(['pace'])
  })

  it('does not pace again what the runtime already paced: tool code’s goto, and a tool click’s navigation', async () => {
    const { platform, driver, waits } = paced()
    const page = await driver.toolPage()
    const filter = platform.session(TOOL).filter!
    const surface = platform.surfaces.find((s) => s.partition === TOOL)!
    const load = surface.onLoad
    const seen: unknown[] = []
    surface.onLoad = (url) => {
      seen.push(filter(nav(url, 20)))
      return load(url)
    }
    await page.goto('https://www.example.com/shop')
    expect(seen).toEqual([true])
    await page.click('#home').catch(() => {})
    expect(filter(nav('https://www.example.com/after-click', 21))).toBe(true)
    // Only the first navigation after the click counts as the click's.
    void filter(nav('https://www.example.com/later', 22))
    await flush()
    expect(waits).toEqual(['pace'])
  })

  it('cancels a navigation whose wait was refused, or whose breaker opened while it waited', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    driver.watchSite({ refused: () => {}, held: () => false, pace: () => Promise.reject(new Error('open')) })
    await driver.toolPage()
    expect(await platform.session(TOOL).filter!(nav('https://www.example.com/x', 30))).toBe(false)

    const later = paced()
    await later.driver.toolPage()
    const decision = later.platform.session(TOOL).filter!(nav('https://www.example.com/y', 31))
    await flush()
    later.open.value = true
    later.release()
    expect(await decision).toBe(false)
  })
})
