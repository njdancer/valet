// Reading what an IMAP server sends: framing across chunks and literals, parsing every response
// shape Valet uses, and refusing anything malformed or past its limits.

import { describe, expect, it } from 'vitest'
import {
  Atom,
  DEFAULT_WIRE_LIMITS,
  Framer,
  list,
  number,
  parseResponse,
  text,
  toNumber,
  type Value,
  WireError,
} from '../src/imap/wire'

const b = (s: string) => Buffer.from(s, 'latin1')
const parse = (s: string) => parseResponse(b(s))

describe('Framer', () => {
  it('returns whole lines, however the bytes arrive', () => {
    const f = new Framer()
    f.push(b('* OK hel'))
    expect(f.take()).toBeNull()
    f.push(b('lo\r\nV1 OK done\r\n* 3 EXI'))
    expect(f.take()?.toString()).toBe('* OK hello')
    expect(f.take()?.toString()).toBe('V1 OK done')
    expect(f.take()).toBeNull()
    expect(f.pending).toBe(7)
    f.push(b('STS\r\n'))
    expect(f.take()?.toString()).toBe('* 3 EXISTS')
  })

  it('keeps a literal and the line after it in one response', () => {
    const f = new Framer()
    f.push(b('* 1 FETCH (BODY[] {5}\r\nab'))
    expect(f.take()).toBeNull()
    f.push(b('c\r\n) UID 4)\r\n'))
    expect(f.take()?.toString()).toBe('* 1 FETCH (BODY[] {5}\r\nabc\r\n) UID 4)')
  })

  it('takes a literal that itself ends like a literal marker', () => {
    const f = new Framer()
    f.push(b('* 1 FETCH (BODY[] {5}\r\n{9}\r\n UID 1)\r\n'))
    expect(f.take()?.toString()).toBe('* 1 FETCH (BODY[] {5}\r\n{9}\r\n UID 1)')
  })

  it('accepts a bare LF', () => {
    const f = new Framer()
    f.push(b('* OK x\n'))
    expect(f.take()?.toString()).toBe('* OK x')
  })

  it('refuses a line past its limit, even before it ends', () => {
    const f = new Framer({ ...DEFAULT_WIRE_LIMITS, maxLineBytes: 10 })
    f.push(b('* OK this is too long'))
    expect(() => f.take()).toThrow(WireError)
    const g = new Framer({ ...DEFAULT_WIRE_LIMITS, maxLineBytes: 10 })
    g.push(b('* OK this is too long\r\n'))
    expect(() => g.take()).toThrow(WireError)
  })

  it('refuses a literal past its limit before reading it', () => {
    const f = new Framer({ ...DEFAULT_WIRE_LIMITS, maxLiteralBytes: 100 })
    f.push(b('* 1 FETCH (BODY[] {101}\r\n'))
    expect(() => f.take()).toThrow(/too-large/)
  })

  it('refuses a response whose literals add up past the limit', () => {
    const f = new Framer({ ...DEFAULT_WIRE_LIMITS, maxResponseBytes: 50 })
    f.push(b(`* 1 FETCH (A {20}\r\n${'x'.repeat(20)} B {20}\r\n${'y'.repeat(20)} C {20}\r\n`))
    expect(() => f.take()).toThrow(/too-large/)
  })

  it('reads {n+} and ~{n} literals', () => {
    const f = new Framer()
    f.push(b('* 1 FETCH (BINARY[1] ~{3}\r\nabc)\r\n* 2 FETCH (X {2+}\r\nde)\r\n'))
    expect(f.take()?.toString()).toBe('* 1 FETCH (BINARY[1] ~{3}\r\nabc)')
    expect(f.take()?.toString()).toBe('* 2 FETCH (X {2+}\r\nde)')
  })

  it('does not take a { without digits as a literal', () => {
    const f = new Framer()
    f.push(b('* OK {x}\r\n* OK {}\r\n'))
    expect(f.take()?.toString()).toBe('* OK {x}')
    expect(f.take()?.toString()).toBe('* OK {}')
  })
})

describe('parseResponse', () => {
  it('reads a tagged status with a code', () => {
    expect(parse('V7 NO [AUTHENTICATIONFAILED] Authentication failed')).toEqual({
      kind: 'tagged',
      tag: 'V7',
      status: 'NO',
      code: [new Atom('AUTHENTICATIONFAILED')],
      text: 'Authentication failed',
    })
    expect(parse('V1 OK')).toEqual({ kind: 'tagged', tag: 'V1', status: 'OK', code: null, text: '' })
  })

  it('reads an untagged status, a continuation and data', () => {
    expect(parse('* OK [UIDVALIDITY 42] valid')).toEqual({
      kind: 'status',
      status: 'OK',
      code: [new Atom('UIDVALIDITY'), new Atom('42')],
      text: 'valid',
    })
    expect(parse('+ go ahead')).toEqual({ kind: 'continue', text: 'go ahead' })
    expect(parse('+')).toEqual({ kind: 'continue', text: '' })
    expect(parse('* SEARCH 1 2 3')).toEqual({
      kind: 'data',
      name: 'SEARCH',
      number: null,
      values: [new Atom('1'), new Atom('2'), new Atom('3')],
    })
    expect(parse('* SEARCH')).toEqual({ kind: 'data', name: 'SEARCH', number: null, values: [] })
    expect(parse('* 12 EXISTS')).toEqual({ kind: 'data', name: 'EXISTS', number: 12, values: [] })
  })

  it('reads a PERMANENTFLAGS code with a list and a \\* flag', () => {
    const r = parse('* OK [PERMANENTFLAGS (\\Seen \\*)] Limited')
    expect(r).toMatchObject({ kind: 'status', code: [new Atom('PERMANENTFLAGS'), [new Atom('\\Seen'), new Atom('\\*')]] })
  })

  it('reads FETCH data: strings, literals, NIL, nested lists and section items', () => {
    const r = parse(
      '* 1 FETCH (UID 9 FLAGS (\\Seen) ENVELOPE (NIL "Hi \\"there\\"" NIL) BODY[HEADER.FIELDS (FROM TO)]<0> {3}\r\nabc BODY[1.2] "x")',
    )
    if (r.kind !== 'data') throw new Error('not data')
    expect(r.name).toBe('FETCH')
    expect(r.number).toBe(1)
    const items = list(r.values[0])
    expect(items[0]).toEqual(new Atom('UID'))
    expect(number(items[1])).toBe(9)
    expect(list(items[3])).toEqual([new Atom('\\Seen')])
    expect(list(items[5])).toEqual([null, Buffer.from('Hi "there"'), null])
    expect(items[6]).toEqual(new Atom('BODY[HEADER.FIELDS (FROM TO)]<0>'))
    expect(text(items[7])).toBe('abc')
    expect(items[8]).toEqual(new Atom('BODY[1.2]'))
  })

  it('keeps a literal’s bytes exactly, CRLFs and all', () => {
    const r = parse('* 1 FETCH (BODY[] {6}\r\na\r\nb\r\n)')
    if (r.kind !== 'data') throw new Error('not data')
    expect(list(r.values[0])[1]).toEqual(Buffer.from('a\r\nb\r\n'))
  })

  it('reads the server’s text as printable ASCII only, bounded', () => {
    const r = parse(`V1 OK ${'é'.repeat(10)}${'x'.repeat(400)}`)
    if (r.kind !== 'tagged') throw new Error('not tagged')
    expect(r.text.length).toBe(300)
    expect(r.text).toMatch(/^[\x20-\x7e]+$/)
  })

  it.each([
    ['an empty line', ''],
    ['a bad tag', 'V-1 OK x'],
    ['a tag with no status', 'V1'],
    ['an unknown status', 'V1 MAYBE x'],
    ['a bad data name', '* se@rch 1'],
    ['an unterminated list', '* LIST (\\Noselect "/" x'],
    ['an unterminated quote', '* LIST () "/'],
    ['a bad escape', '* LIST () "\\x" a'],
    ['a stray close', '* SEARCH 1 )'],
    ['a literal shorter than it says', '* 1 FETCH (X {10}\r\nabc)'],
    ['a literal with no CRLF', '* 1 FETCH (X {3}abc)'],
    ['an unterminated section', '* 1 FETCH (BODY[1 x)'],
    ['a bad number', '* 1x EXISTS'],
    ['a quote with a line break', '* 1 FETCH (X "a\r\nb")'],
  ])('refuses %s', (_name, line) => {
    expect(() => parse(line)).toThrow(WireError)
  })

  it('refuses nesting past its limit', () => {
    const deep = `* 1 FETCH ${'('.repeat(50)}${')'.repeat(50)}`
    expect(() => parse(deep)).toThrow(/too-large/)
  })

  it('refuses more values than its limit', () => {
    expect(() =>
      parseResponse(b(`* SEARCH ${Array.from({ length: 20 }, (_, i) => i + 1).join(' ')}`), {
        ...DEFAULT_WIRE_LIMITS,
        maxValues: 10,
      }),
    ).toThrow(/too-large/)
  })
})

describe('helpers', () => {
  it('reads numbers only within 2^53', () => {
    expect(toNumber('0')).toBe(0)
    expect(toNumber('4294967295')).toBe(4294967295)
    expect(() => toNumber('99999999999999999')).toThrow(WireError)
    expect(() => toNumber('-1')).toThrow(WireError)
    expect(() => number(Buffer.from('1'))).toThrow(WireError)
  })

  it('reads text from atoms and strings only', () => {
    expect(text(new Atom('a'))).toBe('a')
    expect(text(Buffer.from('b'))).toBe('b')
    expect(text(null)).toBeNull()
    expect(text([] as Value[])).toBeNull()
    expect(() => list(null)).toThrow(WireError)
  })
})
