import { describe, expect, it } from 'vitest'
import { decodeWords, htmlToText, parseAddresses, parseMessage, parseParams } from '../src/mime'

describe('mime', () => {
  it('decodes encoded words, joining adjacent ones', () => {
    expect(decodeWords('=?utf-8?Q?caf=C3=A9?= =?utf-8?B?IGJhcg==?= baz')).toBe('café bar baz')
    expect(decodeWords('plain =?iso-8859-1?Q?=A3?=')).toBe('plain £')
    expect(decodeWords('=?bogus-charset?Q?x?=')).toBe('x')
  })

  it('reads parameters, quoted and RFC 2231', () => {
    const p = parseParams("attachment; filename*=utf-8''na%C3%AFve.txt; size=3")
    expect(p.value).toBe('attachment')
    expect(p.params.get('filename')).toBe('naïve.txt')
    expect(parseParams('text/plain; charset="utf-8"; name="a;b.txt"').params.get('name')).toBe('a;b.txt')
    expect(parseParams('x; name*0="long"; name*1="er.txt"').params.get('name')).toBe('longer.txt')
  })

  it('splits addresses, with commas inside quotes', () => {
    expect(parseAddresses('"Last, First" <a@b.c>, d@e.f, Name <g@h.i>')).toEqual([
      { name: 'Last, First', address: 'a@b.c' },
      { name: null, address: 'd@e.f' },
      { name: 'Name', address: 'g@h.i' },
    ])
    expect(parseAddresses('undisclosed-recipients:;')).toEqual([])
  })

  it('reads folded headers and LF-only messages', () => {
    const m = parseMessage(Buffer.from('Subject: one\n two\nMessage-ID: <x@y>\n\nbody\n'))
    expect(m.subject).toBe('one two')
    expect(m.messageId).toBe('x@y')
    expect(m.text).toBe('body')
  })

  it('reads the HTML part when the plain one is blank, as Mail saves a scripted draft', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary=zz',
      'X-Uniform-Type-Identifier: com.apple.mail-draft',
      '',
      '--zz',
      'Content-Type: text/plain; charset=us-ascii',
      '',
      '--zz',
      'Content-Type: text/html; charset=us-ascii',
      '',
      '<html><body><div class="Apple-Mail-URLShareWrapperClass"><blockquote type="cite">Hi Sam,<br><br>See you Friday.<br>Nick</blockquote></div></body></html>',
      '--zz--',
    ].join('\r\n')
    expect(parseMessage(Buffer.from(raw)).text).toContain('Hi Sam,\n\nSee you Friday.\nNick')
  })

  it('prefers the plain part of an alternative', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary=zz',
      '',
      '--zz',
      'Content-Type: text/html',
      '',
      '<p>html</p>',
      '--zz',
      'Content-Type: text/plain',
      '',
      'plain',
      '--zz--',
    ].join('\r\n')
    expect(parseMessage(Buffer.from(raw)).text).toBe('plain')
  })

  it('turns HTML into text in one pass, even when it is hostile', () => {
    expect(htmlToText('a<br>b<div>c</div>&amp;&#x41;&#66;&nbsp;<!-- hidden -->d')).toBe('a\nb\nc\n&AB d')
    expect(htmlToText('<style>x{}</style><SCRIPT>bad()</SCRIPT>ok')).toBe('ok')
    const hostile = '<'.repeat(200_000) + '<a'.repeat(100_000)
    const started = Date.now()
    htmlToText(hostile)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('stops at a sane depth and number of parts', () => {
    let raw = 'Content-Type: text/plain\r\n\r\ndeep'
    for (let i = 0; i < 50; i++)
      raw = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${raw}\r\n--b${i}--`
    expect(parseMessage(Buffer.from(raw)).text).toBe('')
  })
})
