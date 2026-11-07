import type { RequestDeclaration, ToolRunPolicy } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  apiRoots,
  authNavigationAllowed,
  decideToolRequest,
  egressAllowed,
  isApiCall,
  purposeAllowed,
  requestTarget,
  underApiRoot,
} from '../src/guards'

const navigation = ['https://www.example.com', 'https://login.example.com']

describe('authNavigationAllowed, main frame', () => {
  it('allows the navigation origins', () => {
    expect(
      authNavigationAllowed(
        { url: 'https://www.example.com/login?next=/', isMainFrame: true },
        navigation,
        [],
      ),
    ).toBe(true)
    expect(
      authNavigationAllowed({ url: 'https://login.example.com/', isMainFrame: true }, navigation, []),
    ).toBe(true)
  })

  it('stops an open redirect to another site', () => {
    expect(authNavigationAllowed({ url: 'https://evil.test/phish', isMainFrame: true }, navigation, [])).toBe(
      false,
    )
  })

  it('stops a sibling subdomain of an allowed origin', () => {
    expect(
      authNavigationAllowed({ url: 'https://evil.example.com/', isMainFrame: true }, navigation, []),
    ).toBe(false)
  })

  it('stops a lookalike suffix', () => {
    expect(
      authNavigationAllowed({ url: 'https://www.example.com.evil.test/', isMainFrame: true }, navigation, []),
    ).toBe(false)
  })

  it('stops the userinfo trick, where the allowed host is only the username', () => {
    expect(
      authNavigationAllowed({ url: 'https://www.example.com@evil.test/', isMainFrame: true }, navigation, []),
    ).toBe(false)
  })

  it('stops a downgrade to http on the same host', () => {
    expect(authNavigationAllowed({ url: 'http://www.example.com/', isMainFrame: true }, navigation, [])).toBe(
      false,
    )
  })

  it('stops another port on the same host', () => {
    expect(
      authNavigationAllowed({ url: 'https://www.example.com:8443/', isMainFrame: true }, navigation, []),
    ).toBe(false)
  })

  it('stops local and script schemes in the main frame', () => {
    for (const url of [
      'about:blank',
      'data:text/html,<p>hi',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'blob:x',
    ]) {
      expect(authNavigationAllowed({ url, isMainFrame: true }, navigation, []), url).toBe(false)
    }
  })

  it('stops anything that is not a URL', () => {
    expect(authNavigationAllowed({ url: 'www.example.com', isMainFrame: true }, navigation, [])).toBe(false)
  })

  it('does not let a frame origin open up the main frame', () => {
    expect(
      authNavigationAllowed({ url: 'https://captcha.test/', isMainFrame: true }, navigation, [
        'https://captcha.test',
      ]),
    ).toBe(false)
  })
})

describe('authNavigationAllowed, subframes', () => {
  const frames = ['https://captcha.test']

  it('allows the navigation origins and the manifest’s frame origins', () => {
    expect(
      authNavigationAllowed({ url: 'https://captcha.test/frame', isMainFrame: false }, navigation, frames),
    ).toBe(true)
    expect(
      authNavigationAllowed({ url: 'https://login.example.com/x', isMainFrame: false }, navigation, frames),
    ).toBe(true)
  })

  it('allows empty frames', () => {
    expect(authNavigationAllowed({ url: 'about:blank', isMainFrame: false }, navigation, [])).toBe(true)
    expect(authNavigationAllowed({ url: 'about:srcdoc', isMainFrame: false }, navigation, [])).toBe(true)
  })

  it('stops any https frame nobody declared, a sibling subdomain or another port included', () => {
    for (const url of [
      'https://widget.example.com/',
      'https://evil.test/',
      'https://captcha.test:444/',
      'https://captcha.test.evil.test/',
    ]) {
      expect(authNavigationAllowed({ url, isMainFrame: false }, navigation, frames), url).toBe(false)
    }
  })

  it('stops every other origin when the manifest declares no frame origins', () => {
    expect(
      authNavigationAllowed({ url: 'https://captcha.test/frame', isMainFrame: false }, navigation, []),
    ).toBe(false)
  })

  it('stops plain http and script schemes in a frame', () => {
    for (const url of [
      'http://www.example.com/',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///x',
      'nope',
    ]) {
      expect(authNavigationAllowed({ url, isMainFrame: false }, navigation, frames), url).toBe(false)
    }
  })

  it('takes no pattern or path for a frame origin, only exact origins', () => {
    for (const frame of ['https://*.captcha.test', 'https://captcha.test/frame', 'captcha.test']) {
      expect(
        authNavigationAllowed({ url: 'https://a.captcha.test/frame', isMainFrame: false }, navigation, [
          frame,
        ]),
        frame,
      ).toBe(false)
    }
  })
})

describe('egressAllowed', () => {
  const egress = ['www.example.com', '*.cdn.example.com']

  it('allows https and wss to declared hosts', () => {
    expect(egressAllowed('https://www.example.com/apis/ui/Trolley', egress)).toBe(true)
    expect(egressAllowed('wss://www.example.com/socket', egress)).toBe(true)
    expect(egressAllowed('https://img.cdn.example.com/a.png', egress)).toBe(true)
  })

  it('allows any port on a declared host', () => {
    expect(egressAllowed('https://www.example.com:8443/', egress)).toBe(true)
  })

  it('blocks an undeclared host', () => {
    expect(egressAllowed('https://evil.test/collect', egress)).toBe(false)
  })

  it('blocks the bare domain of a wildcard pattern', () => {
    expect(egressAllowed('https://cdn.example.com/', egress)).toBe(false)
  })

  it('blocks lookalikes and the userinfo trick', () => {
    expect(egressAllowed('https://www.example.com.evil.test/', egress)).toBe(false)
    expect(egressAllowed('https://www.example.com@evil.test/', egress)).toBe(false)
    expect(egressAllowed('https://evilwww.example.com/', egress)).toBe(false)
  })

  it('blocks plaintext and other schemes even to a declared host', () => {
    for (const url of [
      'http://www.example.com/',
      'ws://www.example.com/',
      'ftp://www.example.com/',
      'file:///etc/hosts',
      'chrome-extension://abc/x.js',
      'not a url',
    ]) {
      expect(egressAllowed(url, egress), url).toBe(false)
    }
  })

  it('lets local schemes through, since they never leave the machine', () => {
    expect(egressAllowed('data:image/png;base64,AAAA', egress)).toBe(true)
    expect(egressAllowed('blob:https://www.example.com/0d6d', egress)).toBe(true)
    expect(egressAllowed('about:blank', egress)).toBe(true)
  })

  it('matches hosts case-insensitively', () => {
    expect(egressAllowed('https://WWW.EXAMPLE.COM/', egress)).toBe(true)
  })
})

describe('requestTarget', () => {
  it('keeps the origin and path, never the query or fragment', () => {
    expect(requestTarget('https://www.example.com/apis/ui/Orders?token=abc#frag', true)).toBe(
      'https://www.example.com/apis/ui/Orders',
    )
  })

  it('keeps the origin only when asked, so a path tool code chose for a foreign host stays out', () => {
    expect(requestTarget('https://evil.test/session-token-value/collect?token=abc#frag', false)).toBe(
      'https://evil.test',
    )
    expect(requestTarget('https://www.example.com:8443/api/x', false)).toBe('https://www.example.com:8443')
  })

  it('drops userinfo', () => {
    expect(requestTarget('https://user:hunter2@evil.test/x', true)).toBe('https://evil.test/x')
  })

  it('cuts a very long path short', () => {
    const target = requestTarget(`https://www.example.com/${'a'.repeat(1000)}`, true)
    expect(target.length).toBeLessThan(340)
    expect(target.endsWith('…')).toBe(true)
  })

  it('reports a non-hierarchical URL by its scheme alone', () => {
    expect(requestTarget('data:text/plain,secret', true)).toBe('data:')
  })

  it('reports an unparseable URL without echoing it', () => {
    expect(requestTarget('::hunter2::', true)).toBe('invalid-url')
  })
})

const REQUESTS: readonly RequestDeclaration[] = [
  { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' },
  { method: 'POST', path: '/apis/ui/Search/products', purpose: 'read' },
  { method: 'POST', path: '/apis/ui/Trolley/Update', purpose: 'write' },
  { method: 'GET', path: '/apis/ui/product/detail/:stockcode', purpose: 'read' },
  { method: 'POST', path: '/apis/ui/Checkout/Place', purpose: 'irreversible' },
  { method: 'GET', path: '/checkout/review', purpose: 'irreversible' },
  { method: 'GET', path: '/live', purpose: 'read' },
]

const EGRESS = ['www.example.com', '*.cdn.example.com']

const READ: ToolRunPolicy = { egress: EGRESS, requests: REQUESTS, maxPurpose: 'read', ceiling: 50 }

describe('isApiCall', () => {
  it('counts fetches, beacons, sockets and anything unknown as API calls', () => {
    for (const resourceType of [
      'xhr',
      'ping',
      'webSocket',
      'other',
      'cspReport',
      'object',
      'something-new',
    ]) {
      expect(isApiCall({ url: 'https://x.test/', method: 'GET', resourceType }), resourceType).toBe(true)
    }
  })

  it('counts any method but GET as an API call, whatever the resource type', () => {
    for (const resourceType of ['mainFrame', 'subFrame', 'image', 'script']) {
      expect(isApiCall({ url: 'https://x.test/', method: 'POST', resourceType }), resourceType).toBe(true)
    }
    expect(isApiCall({ url: 'https://x.test/', method: 'HEAD', resourceType: 'image' })).toBe(true)
  })

  it('does not count a GET of a page or an asset', () => {
    for (const resourceType of ['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'media']) {
      expect(isApiCall({ url: 'https://x.test/', method: 'GET', resourceType }), resourceType).toBe(false)
    }
  })
})

describe('purposeAllowed', () => {
  it('allows a purpose up to the run’s, and irreversible only once unlocked', () => {
    expect(purposeAllowed('read', 'read', false)).toBe(true)
    expect(purposeAllowed('write', 'read', false)).toBe(false)
    expect(purposeAllowed('write', 'write', false)).toBe(true)
    expect(purposeAllowed('irreversible', 'write', true)).toBe(false)
    expect(purposeAllowed('irreversible', 'irreversible', false)).toBe(false)
    expect(purposeAllowed('irreversible', 'irreversible', true)).toBe(true)
  })

  it('allows nothing for a purpose or a maximum outside the vocabulary', () => {
    expect(purposeAllowed('admin' as never, 'irreversible', true)).toBe(false)
    expect(purposeAllowed('read', 'everything' as never, true)).toBe(false)
  })

  it('allows nothing for a maximum or a purpose that is a name on Object.prototype', () => {
    for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(purposeAllowed('write', name as never, false)).toBe(false)
      expect(purposeAllowed('read', name as never, true)).toBe(false)
      expect(purposeAllowed(name as never, 'irreversible', true)).toBe(false)
    }
  })
})

describe('apiRoots', () => {
  it('takes each declaration up to and including its first literal segment, lower-cased', () => {
    expect(
      apiRoots([
        { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' },
        { method: 'GET', path: '/:locale/API/cart', purpose: 'read' },
        { method: 'GET', path: '/*', purpose: 'read' },
        { method: 'POST', path: '/:id', purpose: 'read' },
        { method: 'GET', path: '/', purpose: 'read' },
      ]),
    ).toEqual([['apis'], [':locale', 'api'], ['*'], [':id'], []])
  })
})

describe('underApiRoot', () => {
  const roots = apiRoots(REQUESTS)

  it('covers every path under a declaration’s first segment, declared or not', () => {
    for (const path of ['/apis', '/apis/ui/Trolley', '/apis/ui/Trolley/Add', '/apis/anything/else']) {
      expect(underApiRoot(path, roots), path).toBe(true)
    }
  })

  it('leaves the site’s pages and assets alone', () => {
    for (const path of ['/', '/shop/browse', '/apisx/ui', '/static/apis/logo.png', '/livestream']) {
      expect(underApiRoot(path, roots), path).toBe(false)
    }
  })

  it('sees through case, encodings, double encodings, matrix parameters and empty segments', () => {
    for (const path of ['/APIS/ui/Trolley', '/%61pis/x', '/%2561pis/x', '/apis;v=1/x', '//apis/x']) {
      expect(underApiRoot(path, roots), path).toBe(true)
    }
  })

  it('sees through an encoded slash or backslash that a server might decode and resolve', () => {
    for (const path of ['/static/..%2Fapis/ui/Trolley', '/static%2F..%2Fapis/x', '/a/b/..%5C..%5Capis/x']) {
      expect(underApiRoot(path, roots), path).toBe(true)
    }
  })

  it('still covers a path a server that leaves encoded slashes alone would route to the API', () => {
    expect(underApiRoot('/apis/..%2Fstatic/logo.png', roots)).toBe(true)
  })

  it('matches a parameter in a root against any one segment', () => {
    const locale = apiRoots([{ method: 'GET', path: '/:locale/api/cart', purpose: 'read' }])
    expect(underApiRoot('/en-au/api/cart/add', locale)).toBe(true)
    expect(underApiRoot('/en-au/shop', locale)).toBe(false)
    expect(underApiRoot('/en-au', locale)).toBe(false)
  })

  it('fails closed for a declaration with no literal segment', () => {
    expect(underApiRoot('/shop/browse', apiRoots([{ method: 'GET', path: '/*', purpose: 'read' }]))).toBe(
      true,
    )
    expect(underApiRoot('/shop', apiRoots([{ method: 'POST', path: '/:id', purpose: 'read' }]))).toBe(true)
    const bare = apiRoots([{ method: 'POST', path: '/', purpose: 'read' }])
    expect(underApiRoot('/', bare)).toBe(true)
    expect(underApiRoot('/shop', bare)).toBe(false)
  })

  it('keeps a segment that does not decode as it is', () => {
    expect(underApiRoot('/%E0%A4%A/x', roots)).toBe(false)
    expect(underApiRoot('/apis/%E0%A4%A', roots)).toBe(true)
  })
})

describe('decideToolRequest', () => {
  it('allows a declared API call, and counts it', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: true, counts: 'request' })
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/product/detail/123?x=1', method: 'get', resourceType: 'xhr' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: true, counts: 'request' })
  })

  it('allows navigations and counts them toward the ceiling, and assets toward the asset budget', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/shop/browse', method: 'GET', resourceType: 'mainFrame' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: true, counts: 'request' })
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/frame', method: 'GET', resourceType: 'subFrame' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: true, counts: 'request' })
    for (const resourceType of ['image', 'script', 'stylesheet', 'font', 'media']) {
      expect(
        decideToolRequest(
          { url: 'https://img.cdn.example.com/a.png', method: 'GET', resourceType },
          READ,
          EGRESS,
          false,
        ),
        resourceType,
      ).toEqual({ allowed: true, counts: 'asset' })
    }
  })

  it('holds a GET of any type to the surface under an API root: images, scripts and frames too', () => {
    // Page script chooses the type: new Image(), <script src>, an iframe, location=.
    for (const resourceType of ['image', 'script', 'stylesheet', 'font', 'media', 'mainFrame', 'subFrame']) {
      expect(
        decideToolRequest(
          { url: 'https://www.example.com/apis/ui/Trolley/Add?id=1', method: 'GET', resourceType },
          READ,
          EGRESS,
          false,
        ),
        resourceType,
      ).toEqual({ allowed: false, reason: 'undeclared' })
    }
  })

  it('counts a declared GET under an API root toward the ceiling, whatever its type', () => {
    for (const resourceType of ['image', 'script', 'mainFrame', 'subFrame']) {
      expect(
        decideToolRequest(
          { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType },
          READ,
          EGRESS,
          false,
        ),
        resourceType,
      ).toEqual({ allowed: true, counts: 'request' })
    }
  })

  it('holds a GET under an API root on every egress host, a CDN’s included', () => {
    expect(
      decideToolRequest(
        { url: 'https://img.cdn.example.com/apis/ui/Orders', method: 'GET', resourceType: 'image' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared' })
  })

  it('refuses an image through an encoded slash into an API root as ambiguous', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/static/..%2Fapis/ui/Trolley', method: 'GET', resourceType: 'image' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'ambiguous-path' })
  })

  it('takes the API roots from the whole manifest, so a read run cannot reach write-only roots', () => {
    const declared = [{ method: 'POST', path: '/cart/update', purpose: 'write' } as const]
    const readRun = { ...READ, requests: REQUESTS.filter((d) => d.purpose === 'read') }
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/cart/update?add=1', method: 'GET', resourceType: 'image' },
        readRun,
        EGRESS,
        false,
        declared,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared' })
    // Without the manifest's declarations, /cart is just a page.
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/cart/update?add=1', method: 'GET', resourceType: 'image' },
        readRun,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: true, counts: 'asset' })
  })

  it('refuses a write declaration reached as an image in a read run', () => {
    const policy = {
      ...READ,
      requests: [{ method: 'GET', path: '/apis/cart/add', purpose: 'write' } as const],
    }
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/cart/add', method: 'GET', resourceType: 'image' },
        policy,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'purpose-exceeded' })
  })

  it('refuses an undeclared host before anything else', () => {
    expect(
      decideToolRequest(
        { url: 'https://evil.test/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'host-not-allowed' })
  })

  it('reports something that is not a URL as bad-url', () => {
    expect(
      decideToolRequest({ url: 'nope', method: 'GET', resourceType: 'xhr' }, READ, EGRESS, false),
    ).toEqual({
      allowed: false,
      reason: 'bad-url',
    })
  })

  it('lets a run narrow the egress list, but never widen it', () => {
    const trolley = { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' }
    expect(decideToolRequest(trolley, { ...READ, egress: ['img.cdn.example.com'] }, EGRESS, false)).toEqual({
      allowed: false,
      reason: 'host-not-allowed',
    })
    const evil = { url: 'https://evil.test/x.png', method: 'GET', resourceType: 'image' }
    expect(decideToolRequest(evil, { ...READ, egress: ['evil.test', ...EGRESS] }, EGRESS, false)).toEqual({
      allowed: false,
      reason: 'host-not-allowed',
    })
  })

  it('lets local schemes through without counting them toward anything', () => {
    expect(
      decideToolRequest(
        { url: 'data:text/plain,x', method: 'GET', resourceType: 'xhr' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: true, counts: null })
  })

  it('refuses an API call to an undeclared path on an allowed host, whoever made it', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Orders', method: 'GET', resourceType: 'xhr' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared' })
  })

  it('refuses a declared path with an undeclared method', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Trolley', method: 'DELETE', resourceType: 'xhr' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared' })
  })

  it('refuses a beacon or a socket that matches nothing', () => {
    for (const [url, resourceType] of [
      ['https://www.example.com/collect', 'ping'],
      ['wss://www.example.com/collect', 'webSocket'],
    ] as const) {
      expect(
        decideToolRequest({ url, method: 'GET', resourceType }, READ, EGRESS, false),
        resourceType,
      ).toEqual({ allowed: false, reason: 'undeclared' })
    }
  })

  it('matches a socket against its path as declared', () => {
    expect(
      decideToolRequest(
        { url: 'wss://www.example.com/live', method: 'GET', resourceType: 'webSocket' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: true, counts: 'request' })
  })

  it('refuses a form POST (a navigation) that matches no declaration', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/account/update', method: 'POST', resourceType: 'mainFrame' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared' })
  })

  it('refuses a denied path for every kind of request: fetch, form POST, navigation, image', () => {
    for (const [method, resourceType, path, reason] of [
      ['POST', 'xhr', '/checkout/pay', 'undeclared'],
      ['POST', 'mainFrame', '/payment', 'undeclared'],
      ['GET', 'mainFrame', '/payments/new', 'denied-path'],
      ['GET', 'subFrame', '/account/payees', 'denied-path'],
      ['GET', 'image', '/api/transfer?to=x', 'denied-path'],
    ] as const) {
      expect(
        decideToolRequest(
          { url: `https://www.example.com${path}`, method, resourceType },
          READ,
          EGRESS,
          false,
        ),
        `${method} ${resourceType} ${path}`,
      ).toEqual({ allowed: false, reason })
    }
  })

  it('refuses a denied path that a read declaration claims to cover', () => {
    const policy = {
      ...READ,
      requests: [{ method: 'POST', path: '/apis/:anything/*', purpose: 'read' } as const],
    }
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/x/checkout/pay', method: 'POST', resourceType: 'xhr' },
        policy,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'denied-path' })
  })

  it('sees through encodings and matrix parameters on a denied segment', () => {
    for (const path of ['/check%6Fut', '/checkout;jsessionid=1', '/a%5Ccheckout', '/PAYMENT']) {
      expect(
        decideToolRequest(
          { url: `https://www.example.com${path}`, method: 'GET', resourceType: 'mainFrame' },
          READ,
          EGRESS,
          false,
        ),
        path,
      ).toEqual({ allowed: false, reason: 'denied-path' })
    }
  })

  it('refuses an irreversible declaration while a read or write tool runs', () => {
    for (const maxPurpose of ['read', 'write'] as const) {
      expect(
        decideToolRequest(
          { url: 'https://www.example.com/apis/ui/Checkout/Place', method: 'POST', resourceType: 'xhr' },
          { ...READ, maxPurpose },
          EGRESS,
          true,
        ),
        maxPurpose,
      ).toEqual({ allowed: false, reason: 'purpose-exceeded' })
    }
  })

  it('refuses an irreversible declaration in an irreversible run until it is unlocked', () => {
    const place = {
      url: 'https://www.example.com/apis/ui/Checkout/Place',
      method: 'POST',
      resourceType: 'xhr',
    }
    const policy = { ...READ, maxPurpose: 'irreversible' } as const
    expect(decideToolRequest(place, policy, EGRESS, false)).toEqual({
      allowed: false,
      reason: 'purpose-exceeded',
    })
    expect(decideToolRequest(place, policy, EGRESS, true)).toEqual({ allowed: true, counts: 'request' })
  })

  it('opens a denied page only for its irreversible declaration, once unlocked', () => {
    const review = {
      url: 'https://www.example.com/checkout/review',
      method: 'GET',
      resourceType: 'mainFrame',
    }
    const policy = { ...READ, maxPurpose: 'irreversible' } as const
    expect(decideToolRequest(review, policy, EGRESS, false)).toEqual({
      allowed: false,
      reason: 'denied-path',
    })
    expect(decideToolRequest(review, policy, EGRESS, true)).toEqual({ allowed: true, counts: 'request' })
    expect(
      decideToolRequest({ ...review, url: 'https://www.example.com/checkout/pay' }, policy, EGRESS, true),
    ).toEqual({ allowed: false, reason: 'denied-path' })
  })

  it('still refuses an undeclared denied path while an unlocked irreversible tool runs', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/checkout/pay', method: 'POST', resourceType: 'xhr' },
        { ...READ, maxPurpose: 'irreversible' },
        EGRESS,
        true,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared' })
  })

  it('refuses a write declaration while a read tool runs, and allows it for a write tool', () => {
    const update = {
      url: 'https://www.example.com/apis/ui/Trolley/Update',
      method: 'POST',
      resourceType: 'xhr',
    }
    expect(decideToolRequest(update, READ, EGRESS, false)).toEqual({
      allowed: false,
      reason: 'purpose-exceeded',
    })
    expect(decideToolRequest(update, { ...READ, maxPurpose: 'write' }, EGRESS, false)).toEqual({
      allowed: true,
      counts: 'request',
    })
  })

  it('refuses an API call through an ambiguous path segment', () => {
    for (const path of [
      '/apis/ui/product/detail/..%2F..%2FOrders',
      '/apis/ui/product/detail/a%5C..%5COrders',
      '/apis/ui/product/detail/a%00b',
    ]) {
      expect(
        decideToolRequest(
          { url: `https://www.example.com${path}`, method: 'GET', resourceType: 'xhr' },
          READ,
          EGRESS,
          false,
        ),
        path,
      ).toEqual({ allowed: false, reason: 'ambiguous-path' })
    }
  })

  it('judges an encoded dot segment as the URL it resolves to, as Chromium sends it', () => {
    // "/detail/%2e%2e" is "/apis/ui/product" by the time anything routes it: undeclared here.
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/product/detail/%2e%2e', method: 'GET', resourceType: 'xhr' },
        READ,
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared' })
  })

  it('refuses everything for a maximum purpose that is a name on Object.prototype', () => {
    for (const maxPurpose of ['toString', '__proto__', 'constructor']) {
      expect(
        decideToolRequest(
          { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' },
          { ...READ, maxPurpose: maxPurpose as never },
          EGRESS,
          false,
        ),
        maxPurpose,
      ).toEqual({ allowed: false, reason: 'purpose-exceeded' })
    }
  })

  it('holds an API call to the surface even with no declarations at all', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' },
        { ...READ, requests: [] },
        EGRESS,
        false,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared' })
  })
})
