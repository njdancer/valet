import { describe, expect, it } from 'vitest'
import { accessDeniedHtml, newSensorValue, sensorScript } from '../src/akamai'

describe('accessDeniedHtml', () => {
  it('reproduces the shape of the page captured live', () => {
    const html = accessDeniedHtml(
      'www.woolworths.com.au',
      '/api/ui/v2/bootstrap',
      '18.a66e3817.1793975714.7f2278b8',
    )
    // The first 300 characters of the live 403 body, exactly as the probe recorded them.
    const captured =
      '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \n' +
      'You don\'t have permission to access "http&#58;&#47;&#47;www&#46;woolworths&#46;com&#46;au&#47;api&#47;ui' +
      '&#47;v2&#47;bootstrap" on this server.<P>\nReference&#32;&#35;18&#46;a66e3817&#46;1793975714&#46;7f2278b8' +
      '\n<P>https&#'
    expect(html.startsWith(captured)).toBe(true)
    expect(html.slice(captured.length)).toBe(
      '58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;a66e3817&#46;1793975714&#46;7f2278b8</P>\n</BODY>\n</HTML>\n',
    )
  })

  it('escapes markup in the requested URL rather than reflecting it', () => {
    const html = accessDeniedHtml('www.woolworths.test', '/x?q=<script>alert(1)</script>', 'ref')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&#60;script&#62;')
  })
})

describe('sensorScript', () => {
  it('sets a script-readable _abck only when the browser has none', () => {
    const script = sensorScript('ABC~0~-1~-1')
    expect(script).toContain("document.cookie = '_abck=ABC~0~-1~-1; path=/;")
    expect(script).toContain('if (/(?:^|;\\s*)_abck=/.test(document.cookie)) return')
    expect(script).not.toMatch(/httponly/i)
  })

  it('marks the cookie Secure on https pages', () => {
    expect(sensorScript('v')).toContain("location.protocol === 'https:' ? '; Secure' : ''")
  })
})

describe('newSensorValue', () => {
  it('is unique and cookie-safe', () => {
    const values = new Set(Array.from({ length: 50 }, () => newSensorValue()))
    expect(values.size).toBe(50)
    for (const value of values) expect(value).toMatch(/^[0-9A-F]{48}~0~-1~-1$/)
  })
})
