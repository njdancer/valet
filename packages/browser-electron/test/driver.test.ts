import { type AdapterManifest, parseManifest, SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { type BlockedRequest, type DriverOptions, ElectronSessionDriver } from '../src/driver'
import type { CookieRecord } from '../src/platform'
import { FakeFrame, FakePlatform, FakeSurface, ManualTimers } from './fake-browser'
import { FakeWindow } from './fake-dom'

const OPTIONS = {
  adapterId: 'example',
  home: 'https://www.example.com/',
  navigation: ['https://www.example.com', 'https://login.example.com'],
  egress: ['www.example.com', 'login.example.com', '*.cdn.example.com'],
  stepTimeoutMs: 1000,
  typingDelayMs: 10,
}

const AUTH = 'persist:auth:example'
const TOOL = 'persist:tool:example'

async function rejection(promise: Promise<unknown>): Promise<SiteAdapterError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(error instanceof SiteAdapterError))
    throw new Error(`expected a SiteAdapterError, got ${String(error)}`)
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
      SiteAdapterError,
    )
  })
})

describe('partition set-up', () => {
  it('hardens the auth partition once and gives it no request filter or proxy', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    await driver.openAuthPage()
    const auth = platform.session(AUTH)
    expect(auth.hardened).toBe(1)
    expect(auth.filter).toBeNull()
    expect(auth.proxy).toBeNull()
    expect(auth.userAgent).toBeNull()
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

  it('leaves the user agent alone by default', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    await driver.toolPage()
    expect(platform.session(AUTH).userAgent).toBeNull()
    expect(platform.session(TOOL).userAgent).toBeNull()
  })

  it('gives both partitions the same clean Chrome user agent when asked', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, userAgent: 'chrome' })
    await driver.openAuthPage()
    await driver.toolPage()
    const ua = platform.session(AUTH).userAgent
    expect(ua).toContain('Chrome/142.0.0.0')
    expect(platform.session(TOOL).userAgent).toBe(ua)
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

  it('reports a block with the origin and a digest of the path, never the path or query', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked: (b) => blocked.push(b) }).toolPage()
    platform.session(TOOL).filter!({
      url: 'https://evil.test/session-token-value/collect?cookie=session-token-value#x',
      method: 'POST',
      resourceType: 'ping',
    })
    expect(blocked).toEqual([
      {
        method: 'POST',
        target: 'https://evil.test',
        pathDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
        resourceType: 'ping',
        reason: 'host-not-allowed',
      },
    ])
    expect(JSON.stringify(blocked)).not.toContain('session-token-value')
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

const SURFACE_OPTIONS = {
  ...OPTIONS,
  requests: [
    { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' },
    { method: 'POST', path: '/apis/ui/Trolley/Update', purpose: 'write' },
    { method: 'POST', path: '/apis/ui/Checkout/Place', purpose: 'irreversible' },
  ],
  requestsPerRun: 3,
} as const

const TROLLEY = { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' }

async function toolFilter(options: Partial<DriverOptions> = {}) {
  const { platform } = browserLike()
  const blocked: BlockedRequest[] = []
  const driver = new ElectronSessionDriver(platform, {
    ...SURFACE_OPTIONS,
    ...options,
    onBlocked: (b) => blocked.push(b),
  })
  await driver.toolPage()
  return { driver, blocked, filter: platform.session(TOOL).filter! }
}

describe('tool partition request surface', () => {
  it('cancels an evaluate()d fetch to a denied path on an allowed host, and says why', async () => {
    const { filter, blocked } = await toolFilter()
    expect(filter({ url: 'https://www.example.com/checkout/pay', method: 'POST', resourceType: 'xhr' })).toBe(
      false,
    )
    expect(blocked).toEqual([
      {
        method: 'POST',
        target: 'https://www.example.com',
        pathDigest: expect.any(String),
        resourceType: 'xhr',
        reason: 'denied-path',
      },
    ])
  })

  it('cancels a form POST to a payment path that a click submitted', async () => {
    const { filter, blocked } = await toolFilter()
    expect(
      filter({ url: 'https://www.example.com/payment', method: 'POST', resourceType: 'mainFrame' }),
    ).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['denied-path'])
  })

  it('cancels a navigation to a payments page', async () => {
    const { filter } = await toolFilter()
    expect(
      filter({ url: 'https://www.example.com/payments/new', method: 'GET', resourceType: 'mainFrame' }),
    ).toBe(false)
  })

  it('cancels an API call to an undeclared path', async () => {
    const { filter, blocked } = await toolFilter()
    expect(
      filter({ url: 'https://www.example.com/apis/ui/Orders', method: 'GET', resourceType: 'xhr' }),
    ).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['undeclared-request'])
  })

  it('makes no API call at all when it was given no declarations', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, OPTIONS).toolPage()
    expect(platform.session(TOOL).filter!(TROLLEY)).toBe(false)
  })

  it('cuts off API call N+1 in a run, and counts no page or asset toward it', async () => {
    const { filter, blocked } = await toolFilter()
    expect(filter(TROLLEY)).toBe(true)
    expect(filter({ url: 'https://www.example.com/shop', method: 'GET', resourceType: 'mainFrame' })).toBe(
      true,
    )
    expect(filter({ url: 'https://img.cdn.example.com/a.png', method: 'GET', resourceType: 'image' })).toBe(
      true,
    )
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
    expect(blocked.map((b) => b.reason)).toEqual(['request-ceiling'])
    // Pages still load once the ceiling is reached.
    expect(filter({ url: 'https://www.example.com/shop', method: 'GET', resourceType: 'mainFrame' })).toBe(
      true,
    )
  })

  it('does not count a request it blocked for another reason', async () => {
    const { filter } = await toolFilter()
    for (let i = 0; i < 5; i++) {
      filter({ url: 'https://www.example.com/apis/ui/Orders', method: 'GET', resourceType: 'xhr' })
    }
    expect(filter(TROLLEY)).toBe(true)
  })

  it('starts the count again at each run', async () => {
    const { driver, filter } = await toolFilter()
    for (let i = 0; i < 3; i++) filter(TROLLEY)
    expect(filter(TROLLEY)).toBe(false)
    driver.beginRun('read')
    expect(filter(TROLLEY)).toBe(true)
    driver.endRun()
    for (let i = 0; i < 3; i++) expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
  })

  it('uses the manifest’s default ceiling of 50 when none is given', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, { ...OPTIONS, requests: SURFACE_OPTIONS.requests }).toolPage()
    const filter = platform.session(TOOL).filter!
    for (let i = 0; i < 50; i++) expect(filter(TROLLEY)).toBe(true)
    expect(filter(TROLLEY)).toBe(false)
  })

  it('allows a declaration only up to the running tool’s side effect', async () => {
    const { driver, filter } = await toolFilter({ requestsPerRun: 50 })
    const update = {
      url: 'https://www.example.com/apis/ui/Trolley/Update',
      method: 'POST',
      resourceType: 'xhr',
    }
    const place = {
      url: 'https://www.example.com/apis/ui/Checkout/Place',
      method: 'POST',
      resourceType: 'xhr',
    }
    expect(filter(update)).toBe(false)
    driver.beginRun('write')
    expect(filter(update)).toBe(true)
    expect(filter(place)).toBe(false)
    driver.beginRun('irreversible')
    expect(filter(place)).toBe(true)
    driver.endRun()
    expect(filter(update)).toBe(false)
    expect(filter(place)).toBe(false)
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
    expect(blocked).toEqual([
      {
        method: 'CONNECT',
        target: 'https://www.example.com:3478',
        pathDigest: null,
        resourceType: 'socket',
        reason: 'host-not-allowed',
      },
      {
        method: 'CONNECT',
        target: 'https://session-token-value.evil.test',
        pathDigest: null,
        resourceType: 'socket',
        reason: 'host-not-allowed',
      },
      {
        method: 'CONNECT',
        target: 'https://127.0.0.1',
        pathDigest: null,
        resourceType: 'socket',
        reason: 'host-not-allowed',
      },
    ])
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
  it('turns a platform failure into a SiteAdapterError without its message', async () => {
    const { platform } = browserLike()
    platform.session = () => {
      throw new Error('profile directory locked: /Users/nick')
    }
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    const auth = await rejection(driver.openAuthPage())
    expect(auth).toMatchObject({ stage: 'navigate', errorClass: 'internal' })
    expect(auth.message).not.toContain('nick')
    expect(await rejection(driver.toolPage())).toMatchObject({ stage: 'egress', errorClass: 'internal' })
    expect(await rejection(driver.sessionCookieValues(['www.example.com']))).toMatchObject({
      stage: 'session-handoff',
      errorClass: 'internal',
    })
  })

  it('reports a Chrome version it cannot read as a SiteAdapterError, from every entry point', async () => {
    const { platform } = browserLike()
    Object.defineProperty(platform, 'chromeVersion', { value: 'unknown' })
    const driver = new ElectronSessionDriver(platform, { ...OPTIONS, userAgent: 'chrome' })
    expect(await rejection(driver.openAuthPage())).toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
    expect(await rejection(driver.toolPage())).toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
    expect(await rejection(driver.handoff(['www.example.com'], []))).toMatchObject({
      stage: 'manifest',
      errorClass: 'invalid',
    })
  })
})

describe('auth partition subframes', () => {
  it('lets subframes load any https page by default', async () => {
    const { platform } = browserLike()
    await new ElectronSessionDriver(platform, OPTIONS).openAuthPage()
    expect(platform.surfaces[0]!.attemptNavigation('https://widget.example.com/', false)).toBe(true)
  })

  it('pins subframes to the navigation and frame origins when given them', async () => {
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

describe('sessionCookieValues', () => {
  it('lists the tool partition’s cookie values on the domains, once each, without empties', async () => {
    const { platform } = browserLike()
    platform.session(TOOL).cookies = [
      tokenCookie,
      { ...tokenCookie, name: 'dup', value: 'session-token-value' },
      { ...tokenCookie, name: 'empty', value: '' },
      { ...tokenCookie, name: 'ads', value: 'tracker', domain: '.ads.test' },
    ]
    expect(
      await new ElectronSessionDriver(platform, OPTIONS).sessionCookieValues(['www.example.com']),
    ).toEqual(['session-token-value'])
  })

  it('reports a cookie store failure as session-handoff/internal', async () => {
    const { platform } = browserLike()
    platform.session(TOOL).getCookies = async () => {
      throw new Error('locked')
    }
    const error = await rejection(
      new ElectronSessionDriver(platform, OPTIONS).sessionCookieValues(['x.example.com']),
    )
    expect(error).toMatchObject({ stage: 'session-handoff', errorClass: 'internal' })
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
