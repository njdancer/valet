// Red team (2026-11-17) against smtp-policy.ts: each attack here got past an earlier version of the
// checks, and is now refused.

import { describe, expect, it } from 'vitest'
import { buildMailMessage, checkMailMessage, isMessageId } from '../src/smtp-policy'

const base = { to: ['ann@example.com'], subject: 'Hello', text: 'Hi' }

describe('arrays are copied by index, then checked', () => {
  it('ignores a replaced Symbol.iterator on an address list', () => {
    const to = ['ann@example.com']
    Object.defineProperty(to, Symbol.iterator, {
      value: function* () {
        yield 'eve@evil.test>\r\nRCPT TO:<x@example.com'
      },
    })
    // The own property makes it no plain array: refused outright.
    expect(checkMailMessage({ ...base, to })).toBeNull()
  })

  it('ignores a replaced Symbol.iterator on references', () => {
    const references = ['<a@b.test>']
    Object.defineProperty(references, Symbol.iterator, {
      value: function* () {
        yield '<a@b.test>\r\nBcc: eve@evil.test'
      },
    })
    expect(checkMailMessage({ ...base, references })).toBeNull()
  })

  it('refuses arrays with holes, extra properties or another prototype', () => {
    const sparse = new Array(2) as string[]
    sparse[1] = 'ann@example.com'
    expect(checkMailMessage({ ...base, to: sparse })).toBeNull()
    const refs = new Array(2) as string[]
    refs[1] = '<a@b.test>'
    expect(checkMailMessage({ ...base, references: refs })).toBeNull()
    const extra = Object.assign(['ann@example.com'], { note: 'x' })
    expect(checkMailMessage({ ...base, to: extra })).toBeNull()
    class List extends Array<string> {}
    expect(checkMailMessage({ ...base, to: List.from(['ann@example.com']) })).toBeNull()
  })

  it('reads each entry once, so an array Proxy that changes its answers is held to the first', () => {
    let reads = 0
    const to = new Proxy(['ann@example.com'], {
      get: (t, k) => (k === '0' && reads++ > 0 ? 'eve@evil.test' : Reflect.get(t, k)),
    })
    expect(checkMailMessage({ ...base, to })?.to).toEqual(['ann@example.com'])
  })

  it('never lets a references entry write a header', () => {
    const message = checkMailMessage({ ...base, references: ['<a@b.test>'] })
    const built = buildMailMessage('me@icloud.test', message as never, { messageId: '<m@x.test>', date: 0 })
    expect(built).not.toContain('Bcc')
  })
})

describe('characters a person can’t see', () => {
  const hidden = {
    'tag characters': [...'BCC eve'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join(''),
    'zero width space': '​',
    'zero width joiner': '‍',
    'word joiner': '⁠',
    'soft hyphen': '­',
    'line separator': ' ',
    'paragraph separator': ' ',
    'arabic letter mark': '؜',
    'hangul filler': 'ㅤ',
    'combining grapheme joiner': '͏',
    'a text variation selector': '︁',
    'private use': '',
    'an unassigned code point': '\u{2fffe}',
  }
  for (const [name, ch] of Object.entries(hidden))
    it(`refuses ${name} in the subject and the text`, () => {
      expect(checkMailMessage({ ...base, subject: `Hi${ch}there` })).toBeNull()
      expect(checkMailMessage({ ...base, text: `Hi${ch}there` })).toBeNull()
    })

  it('refuses a lone carriage return, keeps line breaks, tabs and emoji', () => {
    expect(checkMailMessage({ ...base, text: 'Hi\rthere' })).toBeNull()
    expect(checkMailMessage({ ...base, text: 'Hi\r\nthere\n\tok ❤️ 👍🏽', subject: 'Café ❤️' })).not.toBeNull()
  })
})

describe('recipients', () => {
  it('refuses the old routing characters, % and !, in a local part', () => {
    expect(checkMailMessage({ ...base, to: ['eve%evil.test@example.com'] })).toBeNull()
    expect(checkMailMessage({ ...base, to: ['evil.test!eve@example.com'] })).toBeNull()
  })
})

describe('message ids', () => {
  it('are dot-atom on both sides', () => {
    for (const id of ['<a@b@c.test>', '<"x"(y)\\z@h>', '<a b@c.test>', '<a@[1.2.3.4]>', '<@c.test>'])
      expect(isMessageId(id), id).toBe(false)
    for (const id of ['<a.b+c@d.test>', '<0f3e-11@smtp.mail.me.com>']) expect(isMessageId(id), id).toBe(true)
  })
})
