// The manifest's `runtime` field and the rules each kind brings (docs/adapter-kinds.md).

import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_RUNTIMES,
  homeUnreachable,
  type ManifestInput,
  manifestSchema,
  parseManifest,
  runtimeOf,
} from '../src/manifest'

const HTTP: ManifestInput = {
  schemaVersion: 1,
  id: 'calendar-feed',
  name: 'Calendar',
  version: '0.1.0',
  description: 'Reads a calendar and a feed over HTTPS.',
  runtime: 'http',
  egress: ['caldav.example.com', 'news.example.org'],
  requests: [
    { method: 'PROPFIND', host: 'caldav.example.com', path: '/calendars/:user/', purpose: 'read' },
    { method: 'REPORT', host: 'caldav.example.com', path: '/calendars/:user/:cal/', purpose: 'read' },
    { method: 'MKCALENDAR', host: 'caldav.example.com', path: '/calendars/:user/:cal/', purpose: 'write' },
    { method: 'GET', host: 'news.example.org', path: '/feed.xml', purpose: 'read' },
  ],
  tools: [{ name: 'list_events', title: 'List events', description: 'Lists events.', sideEffect: 'read' }],
}

const copy = (): ManifestInput & Record<string, unknown> =>
  structuredClone(HTTP) as ManifestInput & Record<string, unknown>
const issues = (input: unknown): string[] => {
  const result = manifestSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => i.message)
}

describe('runtime: http', () => {
  it('parses, with home set to its first endpoint and no navigation', () => {
    const manifest = parseManifest(copy())
    expect(manifest.runtime).toBe('http')
    expect(runtimeOf(manifest)).toBe('http')
    expect(manifest.home).toBe('https://caldav.example.com/')
    expect(manifest.navigation).toEqual([])
    expect(homeUnreachable(manifest)).toBeNull()
  })

  it('is available', () => {
    expect(AVAILABLE_RUNTIMES).toContain('http')
  })

  it('refuses the parts of a browser adapter it has no use for', () => {
    const withHome = copy()
    withHome.home = 'https://caldav.example.com/'
    expect(issues(withHome)).toContain('an http adapter has no home: it opens no pages')
    const withNav = copy()
    withNav.navigation = ['https://caldav.example.com']
    expect(issues(withNav)).toContain('an http adapter has no navigation origins')
    const withCart = copy()
    withCart.cartUrl = 'https://caldav.example.com/cart'
    expect(issues(withCart)).toContain('an http adapter has no cartUrl')
  })

  it('refuses a login', () => {
    const login = copy()
    login.secrets = { a: { description: 'x', fields: ['password'], origins: ['https://caldav.example.com'] } }
    expect(issues(login).length).toBeGreaterThan(0)
  })

  it('names exact hosts only', () => {
    const wild = copy()
    wild.egress = ['*.example.com']
    wild.requests = []
    expect(issues(wild)).toContain('egress *.example.com: an http adapter names exact hosts, no "*."')
  })

  it('needs an endpoint', () => {
    const none = copy()
    none.egress = []
    none.requests = []
    expect(issues(none)).toContain('an http adapter needs an egress host or a private host')
  })

  it('names the host of every request', () => {
    const bare = copy()
    bare.requests = [{ method: 'GET', path: '/feed.xml', purpose: 'read' }]
    expect(issues(bare)).toContain('GET /feed.xml: an http adapter names the host of every request')
  })

  it('refuses a request to a host it does not declare', () => {
    const off = copy()
    off.requests = [{ method: 'GET', host: 'other.example.net', path: '/x', purpose: 'read' }]
    expect(issues(off).join('\n')).toMatch(/is not on an egress host or a declared private host/)
  })

  it('lets only PROPFIND and REPORT of the WebDAV methods be reads', () => {
    for (const method of ['MKCOL', 'MKCALENDAR', 'COPY', 'MOVE'] as const) {
      const read = copy()
      read.requests = [{ method, host: 'caldav.example.com', path: '/a', purpose: 'read' }]
      expect(issues(read), method).toContain(
        `${method} caldav.example.com/a: ${method} changes something, so it can't be a read`,
      )
    }
  })

  it('takes a websocket on a GET only', () => {
    const ok = copy()
    ok.requests = [
      { method: 'GET', host: 'news.example.org', path: '/live', purpose: 'read', websocket: true },
    ]
    expect(issues(ok)).toEqual([])
    const post = copy()
    post.requests = [
      { method: 'POST', host: 'news.example.org', path: '/live', purpose: 'write', websocket: true },
    ]
    expect(issues(post)).toContain('POST news.example.org/live: a websocket is opened with GET')
  })

  it('takes upload budgets', () => {
    const limits = copy()
    limits.limits = { uploadBytesPerRun: 4096, writeUploadBytesPerRun: 1_000_000 }
    expect(parseManifest(limits).limits).toMatchObject({
      uploadBytesPerRun: 4096,
      writeUploadBytesPerRun: 1_000_000,
    })
    const tiny = copy()
    tiny.limits = { uploadBytesPerRun: 10 }
    expect(issues(tiny).length).toBeGreaterThan(0)
  })

  it('lets an irreversible tool unlock a WebDAV request', () => {
    const unlock = copy()
    unlock.requests = [
      { method: 'MOVE', host: 'caldav.example.com', path: '/calendars/:user/:cal/', purpose: 'irreversible' },
    ]
    unlock.tools = [
      {
        name: 'move_calendar',
        title: 'Move',
        description: 'Moves a calendar.',
        sideEffect: 'irreversible',
        unlocks: [{ method: 'MOVE', path: '/calendars/:user/:cal/' }],
      },
    ]
    expect(issues(unlock)).toEqual([])
  })
})

describe('private hosts', () => {
  const withPrivate = () => {
    const input = copy()
    input.egress = []
    input.privateHosts = [
      { address: '192.168.1.20', port: 8123, scheme: 'http' },
      { address: 'fd00::5', port: 8443, certSha256: 'a'.repeat(64) },
    ]
    input.requests = [
      { method: 'GET', host: '192.168.1.20:8123', path: '/api/states', purpose: 'read' },
      { method: 'POST', host: '[fd00::5]:8443', path: '/api/services/:domain/:service', purpose: 'write' },
    ]
    return input
  }

  it('parses, with home set to the first private host', () => {
    const manifest = parseManifest(withPrivate())
    expect(manifest.home).toBe('https://192.168.1.20/')
    expect(manifest.privateHosts).toHaveLength(2)
  })

  it.each([
    'nas.local',
    '127.0.0.1',
    '169.254.169.254',
    '8.8.8.8',
    '0.0.0.0',
    'fe80::1',
    '::1',
    'FD00::5',
    '192.168.001.020',
    '::ffff:192.168.1.20',
  ])('refuses %s as an address', (address) => {
    const input = withPrivate()
    input.privateHosts = [{ address, port: 80, scheme: 'http' }]
    input.requests = []
    expect(issues(input).length).toBeGreaterThan(0)
  })

  it('refuses a pinned certificate on plain http', () => {
    const input = withPrivate()
    input.privateHosts = [{ address: '192.168.1.20', port: 80, scheme: 'http', certSha256: 'a'.repeat(64) }]
    input.requests = []
    expect(issues(input)).toContain('certSha256 pins an https certificate; a plain http host has none')
  })

  it('refuses the same address and port twice', () => {
    const input = withPrivate()
    input.privateHosts = [
      { address: '10.0.0.5', port: 443 },
      { address: '10.0.0.5', port: 443, scheme: 'https' },
    ]
    input.requests = []
    expect(issues(input)).toContain('privateHosts lists the same address and port twice')
  })

  it('refuses a request host that is not written as declared', () => {
    for (const host of [
      '192.168.1.20',
      '192.168.1.20:80',
      '[fd00:0::5]:8443',
      'fd00::5:8443',
      '10.0.0.9:80',
    ]) {
      const input = withPrivate()
      input.requests = [{ method: 'GET', host, path: '/x', purpose: 'read' }]
      expect(issues(input).length, host).toBeGreaterThan(0)
    }
  })

  it('refuses private hosts in a browser adapter', () => {
    const input = withPrivate()
    delete input.runtime
    expect(issues(input)).toContain('privateHosts is only for adapters whose runtime is not browser')
  })
})

describe('runtime: browser', () => {
  const browser = (): ManifestInput & Record<string, unknown> => ({
    schemaVersion: 1,
    id: 'shop',
    name: 'Shop',
    version: '0.1.0',
    description: 'A shop.',
    home: 'https://www.example.com/',
    navigation: ['https://www.example.com'],
    egress: ['www.example.com'],
    requests: [{ method: 'GET', path: '/api/x', purpose: 'read' }],
    tools: [{ name: 'x', title: 'X', description: 'X.', sideEffect: 'read' }],
  })

  it('is what a manifest without runtime is', () => {
    const manifest = parseManifest(browser())
    expect(manifest.runtime).toBeUndefined()
    expect(runtimeOf(manifest)).toBe('browser')
  })

  it('needs home, navigation and egress', () => {
    const none = browser()
    delete none.home
    none.navigation = []
    none.egress = []
    expect(issues(none)).toEqual(
      expect.arrayContaining([
        'a browser adapter needs home',
        'a browser adapter needs at least one navigation origin',
        'a browser adapter needs at least one egress host',
      ]),
    )
  })

  it('refuses WebDAV methods, websockets and upload budgets', () => {
    const dav = browser()
    dav.requests = [{ method: 'PROPFIND', path: '/dav', purpose: 'read' }]
    expect(issues(dav)).toContain('PROPFIND /dav: PROPFIND is only for http adapters')
    const ws = browser()
    ws.requests = [{ method: 'GET', path: '/ws', purpose: 'read', websocket: true }]
    expect(issues(ws)).toContain('GET /ws: websocket is only for http adapters')
    const limits = browser()
    limits.limits = { uploadBytesPerRun: 4096 }
    expect(issues(limits)).toContain(
      'limits.uploadBytesPerRun is only for adapters whose runtime is not browser',
    )
  })

  it.each(['protocol', 'raw'])('refuses %s until it is built', (runtime) => {
    const input = browser()
    input.runtime = runtime as 'raw'
    expect(issues(input)).toContain(`runtime ${runtime} is not available yet`)
  })
})
