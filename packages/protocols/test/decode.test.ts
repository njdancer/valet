// Mail's encodings, read from what the sender wrote: every function is total and bounded.

import { describe, expect, it } from 'vitest'
import {
  cleanBody,
  decodeCharset,
  decodeHeader,
  decodeQuotedPrintable,
  decodeTransfer,
  hasControl,
  oneLine,
  truncate,
  visibleOnly,
} from '../src/imap/decode'
import { bodyParts, headerText, parseEnvelope, parseStructure } from '../src/imap/structure'
import { Atom, type Value } from '../src/imap/wire'

const a = (s: string) => new Atom(s)
const s = (v: string) => Buffer.from(v, 'utf8')

describe('decode', () => {
  it('reads base64 and quoted-printable, and passes anything else through', () => {
    expect(decodeTransfer(Buffer.from('aGVs\r\nbG8=\r\n'), 'BASE64').toString()).toBe('hello')
    expect(decodeTransfer(Buffer.from('a=3Db=\r\nc'), 'quoted-printable').toString()).toBe('a=bc')
    expect(decodeTransfer(Buffer.from('raw'), '8bit').toString()).toBe('raw')
    expect(decodeTransfer(Buffer.from('raw'), null).toString()).toBe('raw')
  })

  it('leaves a broken quoted-printable escape as written', () => {
    expect(decodeQuotedPrintable(Buffer.from('a=ZZb=\nc=')).toString()).toBe('a=ZZbc=')
  })

  it('reads charsets by their mail names, and an unknown one as UTF-8', () => {
    expect(decodeCharset(Buffer.from([0xe9]), 'iso-8859-1')).toBe('é')
    expect(decodeCharset(Buffer.from([0xe9]), '"Latin1"')).toBe('é')
    expect(decodeCharset(Buffer.from('ok'), 'x-no-such-charset')).toBe('ok')
    expect(decodeCharset(Buffer.from('ok'), null)).toBe('ok')
  })

  it('decodes encoded words and keeps a header to one line', () => {
    expect(decodeHeader('=?utf-8?q?Caf=C3=A9?= =?utf-8?b?IG1lbnU=?=')).toBe('Café menu')
    expect(decodeHeader('=?utf-8*en?q?hi_there?=')).toBe('hi there')
    expect(decodeHeader('a\r\nBcc: x@y\u0000z')).toBe('a Bcc: x@y z')
    expect(decodeHeader('=?utf-8?b?YQ0KQmNjOiB4?=')).toBe('a Bcc: x')
    expect(oneLine('a b\u0085c')).toBe('a b c')
  })

  it('keeps line breaks and tabs in a body, and nothing else that controls a terminal', () => {
    expect(cleanBody('a\r\nb\rc\td\u001b[31me\u0007')).toBe('a\nb\nc\td[31me')
    expect(hasControl('ok')).toBe(false)
    expect(hasControl('o\u007fk')).toBe(true)
  })

  it('removes bidi overrides and invisible characters', () => {
    expect(visibleOnly('pay‮gnp.exe​﻿')).toBe('paygnp.exe')
  })

  it('cuts at a code point, never inside a pair', () => {
    expect(truncate('ab', 5)).toEqual({ text: 'ab', truncated: false })
    expect(truncate('a📬b', 2)).toEqual({ text: 'a', truncated: true })
    expect(truncate('abc', 2)).toEqual({ text: 'ab', truncated: true })
  })
})

describe('structure', () => {
  const address = (name: string | null, mailbox: string, host: string): Value[] => [
    name === null ? null : s(name),
    null,
    s(mailbox),
    s(host),
  ]

  it('reads an envelope, dropping group markers and bounding every header', () => {
    const envelope = parseEnvelope([
      s('Mon, 16 Nov 2026 09:00:00 +0000'),
      s(`=?utf-8?q?Hi?= ${'x'.repeat(1000)}`),
      [address('Shop', 'Orders', 'Shop.Test'), [null, null, s('group'), null], [null, null, null, null]],
      null,
      null,
      [address(null, 'nick', 'icloud.test')],
      null,
      null,
      null,
      s('<1@shop.test>'),
    ])
    expect(envelope?.from).toEqual([{ name: 'Shop', address: 'orders@shop.test' }])
    expect(envelope?.to).toEqual([{ name: null, address: 'nick@icloud.test' }])
    expect(envelope?.subject?.length).toBe(500)
    expect(envelope?.subject?.startsWith('Hi x')).toBe(true)
    expect(envelope?.messageId).toBe('<1@shop.test>')
    expect(parseEnvelope(null)).toBeNull()
    expect(parseEnvelope([s('short')])).toBeNull()
    expect(headerText(undefined)).toBeNull()
  })

  it('numbers the leaves of a multipart, and reads RFC 2231 and encoded filenames', () => {
    const textPart = (subtype: string, extra: Value[] = []): Value[] => [
      s('TEXT'),
      s(subtype),
      [s('CHARSET'), s('utf-8')],
      null,
      null,
      s('7BIT'),
      a('10'),
      a('1'),
      null,
      ...extra,
    ]
    const pdf: Value[] = [
      s('APPLICATION'),
      s('PDF'),
      [s('NAME'), s('=?utf-8?q?men=C3=BC.pdf?=')],
      null,
      null,
      s('BASE64'),
      a('2048'),
      null,
      [s('ATTACHMENT'), [s('FILENAME*'), s("utf-8''%E2%82%AC/..%2Fevil.pdf")]],
    ]
    const forwarded: Value[] = [
      s('MESSAGE'),
      s('RFC822'),
      null,
      null,
      null,
      s('7BIT'),
      a('99'),
      null,
      null,
      a('3'),
    ]
    const parts = parseStructure([
      [textPart('PLAIN'), textPart('HTML'), s('ALTERNATIVE')],
      pdf,
      forwarded,
      s('MIXED'),
    ])
    expect(parts.map((p) => [p.part, p.type])).toEqual([
      ['1.1', 'text/plain'],
      ['1.2', 'text/html'],
      ['2', 'application/pdf'],
      ['3', 'message/rfc822'],
    ])
    expect(parts[2]).toMatchObject({
      filename: '€_.._evil.pdf',
      disposition: 'attachment',
      size: 2048,
      encoding: 'base64',
    })
    expect(bodyParts(parts)).toMatchObject({ plain: { part: '1.1' }, html: { part: '1.2' } })
    expect(parseStructure(textPart('PLAIN'))[0]?.part).toBe('1')
  })

  it('treats a named text part as an attachment, not the body', () => {
    const named: Value[] = [
      s('TEXT'),
      s('PLAIN'),
      [s('NAME'), s('notes.txt')],
      null,
      null,
      null,
      a('1'),
      a('1'),
    ]
    expect(bodyParts(parseStructure(named))).toEqual({ plain: null, html: null })
  })

  it('stops at its limits on a hostile structure', () => {
    let deep: Value = [s('TEXT'), s('PLAIN'), null, null, null, null, a('1'), a('1')]
    for (let i = 0; i < 50; i++) deep = [deep, s('MIXED')]
    expect(parseStructure(deep)).toEqual([])
    const wide: Value[] = Array.from({ length: 500 }, () => [
      s('TEXT'),
      s('PLAIN'),
      null,
      null,
      null,
      null,
      a('1'),
    ])
    expect(parseStructure([...wide, s('MIXED')])).toHaveLength(200)
    expect(parseStructure(a('x'))).toEqual([])
  })
})
