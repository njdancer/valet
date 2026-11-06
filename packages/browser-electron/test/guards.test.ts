import { describe, expect, it } from 'vitest'
import { authNavigationAllowed, egressAllowed, requestTarget } from '../src/guards'

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
  it('keeps origin and path only', () => {
    expect(requestTarget('https://evil.test/collect?token=abc#frag')).toBe('https://evil.test/collect')
  })

  it('drops userinfo', () => {
    expect(requestTarget('https://user:hunter2@evil.test/x')).toBe('https://evil.test/x')
  })

  it('reports a non-hierarchical URL by its scheme alone', () => {
    expect(requestTarget('data:text/plain,secret')).toBe('data:')
  })

  it('reports an unparseable URL without echoing it', () => {
    expect(requestTarget('::hunter2::')).toBe('invalid-url')
  })
})
