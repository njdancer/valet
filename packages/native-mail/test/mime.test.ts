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

  it('reads the HTML part when the plain one leaves its values out, as a retailer invoice did', () => {
    const alt = (plain: string, html: string) =>
      [
        'Content-Type: multipart/alternative; boundary=zz',
        '',
        '--zz',
        'Content-Type: text/plain',
        '',
        plain,
        '--zz',
        'Content-Type: text/html',
        '',
        html,
        '--zz--',
      ].join('\r\n')
    const rows =
      '<table><tr><th>Item</th><th>Qty</th><th>Price</th></tr>' +
      '<tr><td><img src="x.jpg" alt="Anko Kids Wooden Train Set 40 Piece"></td><td>2</td><td>$5.00</td></tr>' +
      '<tr><td><img src="y.jpg" alt="Anko Glitter Slime Kit"></td><td>1</td><td>$12.00</td></tr></table>' +
      '<p>Subtotal $22.00</p>'
    const templated = alt(
      'Item Qty Price\n# $\nSubtotal $22.00 ( http://link.example/ls/click?upn=abcdefghijklmnopqrstuvwxyz0123456789 )',
      rows,
    )
    const text = parseMessage(Buffer.from(templated)).text
    expect(text).toContain('Anko Kids Wooden Train Set 40 Piece 2 $5.00')
    expect(text).toContain('Anko Glitter Slime Kit')
    // A plain part that says as much keeps winning, even with its links spelt out.
    const full = alt(
      'Anko Kids Wooden Train Set 40 Piece 2 $5.00 ( http://link.example/a )\nAnko Glitter Slime Kit 1 $12.00\nSubtotal $22.00',
      rows,
    )
    expect(parseMessage(Buffer.from(full)).text).toContain('( http://link.example/a )')
  })

  it('gives a picture’s alt text, and nothing for one without', () => {
    expect(htmlToText('<p>a<img src="t.gif" alt="">b<img alt=\'Logo\'>c</p>')).toBe('\nab Logo c\n')
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
