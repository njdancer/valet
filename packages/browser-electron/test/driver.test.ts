import { type AdapterManifest, parseManifest, SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { type BlockedRequest, ElectronSessionDriver } from '../src/driver'
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
      tools: [{ name: 'trolley', title: 'Trolley', description: 'Reads the trolley', sideEffect: 'read' }],
    })
    const { platform } = browserLike()
    const driver = ElectronSessionDriver.forManifest(platform, manifest)
    await driver.toolPage()
    expect(platform.surfaces.map((s) => [s.partition, s.loads])).toEqual([
      ['persist:tool:woolworths', ['https://www.woolworths.com.au/']],
    ])
    const filter = platform.session('persist:tool:woolworths').filter!
    expect(filter({ url: 'https://www.woolworths.com.au/apis/ui/Trolley', method: 'GET' })).toBe(true)
    expect(filter({ url: 'https://www.example.com/', method: 'GET' })).toBe(false)
  })

  it('refuses an adapter id that is not a safe partition name', () => {
    expect(() => new ElectronSessionDriver(new FakePlatform(), { ...OPTIONS, adapterId: '../x' })).toThrow(
      SiteAdapterError,
    )
  })
})

describe('partition set-up', () => {
  it('hardens the auth partition once and gives it no request filter', async () => {
    const { platform } = browserLike()
    const driver = new ElectronSessionDriver(platform, OPTIONS)
    await driver.openAuthPage()
    await driver.openAuthPage()
    const auth = platform.session(AUTH)
    expect(auth.hardened).toBe(1)
    expect(auth.filter).toBeNull()
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
        `open with filter=${tool.filter !== null} headers=${tool.headers.length} hardened=${tool.hardened}`,
      )
      return makeSurface(partition)
    }
    await new ElectronSessionDriver(platform, OPTIONS).toolPage()
    expect(order).toEqual(['open with filter=true headers=1 hardened=1'])
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
    expect(filter({ url: 'https://www.example.com/apis/ui/Trolley', method: 'GET' })).toBe(true)
    expect(filter({ url: 'https://img.cdn.example.com/p.png', method: 'GET' })).toBe(true)
    expect(filter({ url: 'https://evil.test/collect', method: 'POST' })).toBe(false)
    expect(filter({ url: 'http://www.example.com/', method: 'GET' })).toBe(false)
    expect(filter({ url: 'https://www.example.com.evil.test/', method: 'GET' })).toBe(false)
  })

  it('reports a block with origin and path only', async () => {
    const { platform } = browserLike()
    const blocked: BlockedRequest[] = []
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked: (b) => blocked.push(b) }).toolPage()
    platform.session(TOOL).filter!({
      url: 'https://evil.test/collect?cookie=session-token-value#x',
      method: 'POST',
    })
    expect(blocked).toEqual([{ method: 'POST', target: 'https://evil.test/collect' }])
    expect(JSON.stringify(blocked)).not.toContain('session-token-value')
  })

  it('still blocks when the reporter throws', async () => {
    const { platform } = browserLike()
    const onBlocked = () => {
      throw new Error('audit log full')
    }
    await new ElectronSessionDriver(platform, { ...OPTIONS, onBlocked }).toolPage()
    expect(platform.session(TOOL).filter!({ url: 'https://evil.test/', method: 'GET' })).toBe(false)
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
