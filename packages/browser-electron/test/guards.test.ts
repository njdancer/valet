import type { RequestDeclaration } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import {
  ambiguousPath,
  authNavigationAllowed,
  decideToolRequest,
  deniedPath,
  egressAllowed,
  isApiCall,
  pathDigest,
  requestTarget,
  type SurfacePolicy,
} from '../src/guards'

const navigation = ['https://www.example.com', 'https://login.example.com']

describe('authNavigationAllowed, main frame', () => {
  it('allows the navigation origins', () => {
    expect(
      authNavigationAllowed({ url: 'https://www.example.com/login?next=/', isMainFrame: true }, navigation),
    ).toBe(true)
    expect(authNavigationAllowed({ url: 'https://login.example.com/', isMainFrame: true }, navigation)).toBe(
      true,
    )
  })

  it('stops an open redirect to another site', () => {
    expect(authNavigationAllowed({ url: 'https://evil.test/phish', isMainFrame: true }, navigation)).toBe(
      false,
    )
  })

  it('stops a sibling subdomain of an allowed origin', () => {
    expect(authNavigationAllowed({ url: 'https://evil.example.com/', isMainFrame: true }, navigation)).toBe(
      false,
    )
  })

  it('stops a lookalike suffix', () => {
    expect(
      authNavigationAllowed({ url: 'https://www.example.com.evil.test/', isMainFrame: true }, navigation),
    ).toBe(false)
  })

  it('stops the userinfo trick, where the allowed host is only the username', () => {
    expect(
      authNavigationAllowed({ url: 'https://www.example.com@evil.test/', isMainFrame: true }, navigation),
    ).toBe(false)
  })

  it('stops a downgrade to http on the same host', () => {
    expect(authNavigationAllowed({ url: 'http://www.example.com/', isMainFrame: true }, navigation)).toBe(
      false,
    )
  })

  it('stops another port on the same host', () => {
    expect(
      authNavigationAllowed({ url: 'https://www.example.com:8443/', isMainFrame: true }, navigation),
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
      expect(authNavigationAllowed({ url, isMainFrame: true }, navigation), url).toBe(false)
    }
  })

  it('stops anything that is not a URL', () => {
    expect(authNavigationAllowed({ url: 'www.example.com', isMainFrame: true }, navigation)).toBe(false)
  })
})

describe('authNavigationAllowed, subframes', () => {
  it('allows https frames from other origins, which login pages embed for bot checks', () => {
    expect(authNavigationAllowed({ url: 'https://captcha.test/frame', isMainFrame: false }, navigation)).toBe(
      true,
    )
  })

  it('allows empty frames', () => {
    expect(authNavigationAllowed({ url: 'about:blank', isMainFrame: false }, navigation)).toBe(true)
    expect(authNavigationAllowed({ url: 'about:srcdoc', isMainFrame: false }, navigation)).toBe(true)
  })

  it('stops plain http and script schemes in a frame', () => {
    for (const url of [
      'http://www.example.com/',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///x',
      'nope',
    ]) {
      expect(authNavigationAllowed({ url, isMainFrame: false }, navigation), url).toBe(false)
    }
  })
})

describe('authNavigationAllowed, subframes pinned to a list', () => {
  const frames = ['https://captcha.test']

  it('allows the navigation origins and the listed frame origins', () => {
    expect(
      authNavigationAllowed({ url: 'https://captcha.test/frame', isMainFrame: false }, navigation, frames),
    ).toBe(true)
    expect(
      authNavigationAllowed({ url: 'https://login.example.com/x', isMainFrame: false }, navigation, frames),
    ).toBe(true)
    expect(authNavigationAllowed({ url: 'about:blank', isMainFrame: false }, navigation, frames)).toBe(true)
  })

  it('stops any other https frame, a sibling subdomain included', () => {
    for (const url of ['https://widget.example.com/', 'https://evil.test/', 'https://captcha.test:444/']) {
      expect(authNavigationAllowed({ url, isMainFrame: false }, navigation, frames), url).toBe(false)
    }
  })

  it('does not let a frame origin open up the main frame', () => {
    expect(
      authNavigationAllowed({ url: 'https://captcha.test/', isMainFrame: true }, navigation, frames),
    ).toBe(false)
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
  it('keeps the origin only, so a token in the path or query never reaches a report', () => {
    expect(requestTarget('https://evil.test/session-token-value/collect?token=abc#frag')).toBe(
      'https://evil.test',
    )
    expect(requestTarget('https://www.example.com:8443/api/x')).toBe('https://www.example.com:8443')
  })

  it('drops userinfo', () => {
    expect(requestTarget('https://user:hunter2@evil.test/x')).toBe('https://evil.test')
  })

  it('reports a non-hierarchical URL by its scheme alone', () => {
    expect(requestTarget('data:text/plain,secret')).toBe('data:')
  })

  it('reports an unparseable URL without echoing it', () => {
    expect(requestTarget('::hunter2::')).toBe('invalid-url')
  })
})

describe('pathDigest', () => {
  it('tells paths apart without carrying them', () => {
    const a = pathDigest('https://evil.test/session-token-value')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toContain('session-token-value')
    expect(pathDigest('https://evil.test/other')).not.toBe(a)
  })

  it('ignores the query and fragment', () => {
    expect(pathDigest('https://evil.test/x?token=1#f')).toBe(pathDigest('https://evil.test/x'))
  })

  it('has nothing to digest for an opaque or unparseable URL', () => {
    expect(pathDigest('data:text/plain,secret')).toBeNull()
    expect(pathDigest('::hunter2::')).toBeNull()
  })
})

const REQUESTS: readonly RequestDeclaration[] = [
  { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' },
  { method: 'POST', path: '/apis/ui/Search/products', purpose: 'read' },
  { method: 'POST', path: '/apis/ui/Trolley/Update', purpose: 'write' },
  { method: 'GET', path: '/apis/ui/product/detail/:stockcode', purpose: 'read' },
  { method: 'POST', path: '/apis/ui/Checkout/Place', purpose: 'irreversible' },
]

const READ: SurfacePolicy = {
  egress: ['www.example.com', '*.cdn.example.com'],
  requests: REQUESTS,
  sideEffect: 'read',
}

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

describe('decideToolRequest', () => {
  it('allows a declared API call, and counts it', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' },
        READ,
      ),
    ).toEqual({ allowed: true, counts: true })
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/product/detail/123?x=1', method: 'get', resourceType: 'xhr' },
        READ,
      ),
    ).toEqual({ allowed: true, counts: true })
  })

  it('allows pages and assets on egress hosts without counting them', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/shop/browse', method: 'GET', resourceType: 'mainFrame' },
        READ,
      ),
    ).toEqual({ allowed: true, counts: false })
    expect(
      decideToolRequest(
        { url: 'https://img.cdn.example.com/a.png', method: 'GET', resourceType: 'image' },
        READ,
      ),
    ).toEqual({ allowed: true, counts: false })
  })

  it('refuses an undeclared host before anything else', () => {
    expect(
      decideToolRequest(
        { url: 'https://evil.test/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' },
        READ,
      ),
    ).toEqual({ allowed: false, reason: 'host-not-allowed' })
    expect(decideToolRequest({ url: 'nope', method: 'GET', resourceType: 'xhr' }, READ)).toEqual({
      allowed: false,
      reason: 'host-not-allowed',
    })
  })

  it('lets local schemes through without counting them', () => {
    expect(decideToolRequest({ url: 'data:text/plain,x', method: 'GET', resourceType: 'xhr' }, READ)).toEqual(
      {
        allowed: true,
        counts: false,
      },
    )
  })

  it('refuses an evaluate()d fetch to an undeclared API path on an allowed host', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Orders', method: 'GET', resourceType: 'xhr' },
        READ,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared-request' })
  })

  it('refuses a declared path with an undeclared method', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Trolley', method: 'DELETE', resourceType: 'xhr' },
        READ,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared-request' })
  })

  it('refuses a beacon or a socket that matches nothing', () => {
    for (const resourceType of ['ping', 'webSocket']) {
      expect(
        decideToolRequest({ url: 'https://www.example.com/collect', method: 'GET', resourceType }, READ),
        resourceType,
      ).toEqual({ allowed: false, reason: 'undeclared-request' })
    }
  })

  it('refuses a form POST (a navigation) that matches no declaration', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/account/update', method: 'POST', resourceType: 'mainFrame' },
        READ,
      ),
    ).toEqual({ allowed: false, reason: 'undeclared-request' })
  })

  it('refuses a denied path for every kind of request: fetch, form POST, navigation, image', () => {
    for (const [method, resourceType, path] of [
      ['POST', 'xhr', '/checkout/pay'],
      ['POST', 'mainFrame', '/payment'],
      ['GET', 'mainFrame', '/payments/new'],
      ['GET', 'subFrame', '/account/payees'],
      ['GET', 'image', '/api/transfer?to=x'],
    ] as const) {
      expect(
        decideToolRequest({ url: `https://www.example.com${path}`, method, resourceType }, READ),
        `${method} ${resourceType} ${path}`,
      ).toEqual({ allowed: false, reason: 'denied-path' })
    }
  })

  it('sees through encodings and matrix parameters on a denied segment', () => {
    for (const path of ['/check%6Fut', '/checkout;jsessionid=1', '/a%5Ccheckout', '/PAYMENT']) {
      expect(
        decideToolRequest(
          { url: `https://www.example.com${path}`, method: 'GET', resourceType: 'mainFrame' },
          READ,
        ),
        path,
      ).toEqual({ allowed: false, reason: 'denied-path' })
    }
  })

  it('refuses an irreversible declaration while a read or write tool runs', () => {
    for (const sideEffect of ['read', 'write'] as const) {
      expect(
        decideToolRequest(
          { url: 'https://www.example.com/apis/ui/Checkout/Place', method: 'POST', resourceType: 'xhr' },
          { ...READ, sideEffect },
        ),
        sideEffect,
      ).toEqual({ allowed: false, reason: 'denied-path' })
    }
  })

  it('allows an irreversible declaration only while an irreversible tool runs', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Checkout/Place', method: 'POST', resourceType: 'xhr' },
        { ...READ, sideEffect: 'irreversible' },
      ),
    ).toEqual({ allowed: true, counts: true })
  })

  it('still refuses an undeclared denied path while an irreversible tool runs', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/checkout/pay', method: 'POST', resourceType: 'xhr' },
        { ...READ, sideEffect: 'irreversible' },
      ),
    ).toEqual({ allowed: false, reason: 'denied-path' })
  })

  it('refuses a write declaration while a read tool runs, and allows it for a write tool', () => {
    const update = {
      url: 'https://www.example.com/apis/ui/Trolley/Update',
      method: 'POST',
      resourceType: 'xhr',
    }
    expect(decideToolRequest(update, READ)).toEqual({ allowed: false, reason: 'denied-path' })
    expect(decideToolRequest(update, { ...READ, sideEffect: 'write' })).toEqual({
      allowed: true,
      counts: true,
    })
  })

  it('matches no declaration through an ambiguous path segment', () => {
    for (const path of [
      '/apis/ui/product/detail/..%2F..%2FOrders',
      '/apis/ui/product/detail/%2e%2e',
      '/apis/ui/product/detail/a%00b',
    ]) {
      expect(
        decideToolRequest(
          { url: `https://www.example.com${path}`, method: 'GET', resourceType: 'xhr' },
          READ,
        ),
        path,
      ).toEqual({ allowed: false, reason: 'undeclared-request' })
    }
  })

  it('holds an API call to the surface even with no declarations at all', () => {
    expect(
      decideToolRequest(
        { url: 'https://www.example.com/apis/ui/Trolley', method: 'GET', resourceType: 'xhr' },
        { ...READ, requests: [] },
      ),
    ).toEqual({ allowed: false, reason: 'undeclared-request' })
  })
})

describe('deniedPath and ambiguousPath', () => {
  it('leaves ordinary paths alone', () => {
    expect(deniedPath('/apis/ui/Trolley')).toBe(false)
    expect(ambiguousPath('/apis/ui/Trolley')).toBe(false)
  })

  it('keeps a segment that does not decode as it is', () => {
    expect(deniedPath('/%E0%A4%A/checkout')).toBe(true)
    expect(deniedPath('/%E0%A4%A')).toBe(false)
  })

  it('treats a literal backslash as ambiguous', () => {
    expect(ambiguousPath('/a\\b')).toBe(true)
  })
})
