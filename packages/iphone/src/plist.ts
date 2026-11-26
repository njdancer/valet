// Property lists, as the iPhone's services speak them: XML out, XML or binary in. Small and
// dependency-free on purpose. Values round-trip without change of type: a real number decoded from a
// plist stays a PlistReal, so the layout Valet writes back carries the phone's own types.

export class PlistReal {
  constructor(readonly value: number) {}
  toJSON(): number {
    return this.value
  }
}

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | PlistReal
  | Date
  | Uint8Array
  | readonly PlistValue[]
  | { readonly [key: string]: PlistValue }

export class PlistError extends Error {}

// ---------- XML out ----------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function xmlValue(value: PlistValue, out: string[]): void {
  if (typeof value === 'string') out.push(`<string>${escapeXml(value)}</string>`)
  else if (typeof value === 'boolean') out.push(value ? '<true/>' : '<false/>')
  else if (typeof value === 'bigint') out.push(`<integer>${value}</integer>`)
  else if (typeof value === 'number') {
    if (Number.isInteger(value)) out.push(`<integer>${value}</integer>`)
    else out.push(`<real>${value}</real>`)
  } else if (value instanceof PlistReal) out.push(`<real>${value.value}</real>`)
  else if (value instanceof Date) out.push(`<date>${value.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`)
  else if (value instanceof Uint8Array) out.push(`<data>${Buffer.from(value).toString('base64')}</data>`)
  else if (Array.isArray(value)) {
    out.push('<array>')
    for (const item of value) xmlValue(item, out)
    out.push('</array>')
  } else {
    out.push('<dict>')
    for (const [key, item] of Object.entries(value as Record<string, PlistValue>)) {
      if (item === undefined) continue
      out.push(`<key>${escapeXml(key)}</key>`)
      xmlValue(item, out)
    }
    out.push('</dict>')
  }
}

export function encodeXml(value: PlistValue): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n',
    '<plist version="1.0">',
  ]
  xmlValue(value, out)
  out.push('</plist>\n')
  return out.join('')
}

// ---------- XML in ----------

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === 'amp') return '&'
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'quot') return '"'
    if (entity === 'apos') return "'"
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return String.fromCodePoint(code)
  })
}

interface Token {
  readonly kind: 'open' | 'close' | 'empty' | 'text'
  readonly name: string
  readonly text: string
}

function* tokens(xml: string): Generator<Token> {
  const tag = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g
  let last = 0
  for (let m = tag.exec(xml); m !== null; m = tag.exec(xml)) {
    if (m.index > last) yield { kind: 'text', name: '', text: xml.slice(last, m.index) }
    last = tag.lastIndex
    const name = m[2]
    if (name === undefined) continue
    if (m[1] === '/') yield { kind: 'close', name, text: '' }
    else if (m[3] === '/') yield { kind: 'empty', name, text: '' }
    else yield { kind: 'open', name, text: '' }
  }
  if (last < xml.length) yield { kind: 'text', name: '', text: xml.slice(last) }
}

export function decodeXml(xml: string): PlistValue {
  // Text tokens stay in: a <string> may hold only spaces.
  const all = [...tokens(xml)]
  let i = 0
  const next = (): Token => {
    const token = all[i++]
    if (token === undefined) throw new PlistError('The plist ended early.')
    return token
  }
  const skipSpace = (): Token => {
    for (;;) {
      const token = next()
      if (token.kind !== 'text' || token.text.trim() !== '') return token
    }
  }
  const textUntil = (name: string): string => {
    let text = ''
    for (;;) {
      const token = next()
      if (token.kind === 'text') text += token.text
      else if (token.kind === 'close' && token.name === name) return unescapeXml(text)
      else throw new PlistError(`Unexpected <${token.name}> inside <${name}>.`)
    }
  }
  const value = (token: Token): PlistValue => {
    if (token.kind === 'empty') {
      switch (token.name) {
        case 'true':
          return true
        case 'false':
          return false
        case 'string':
          return ''
        case 'array':
          return []
        case 'dict':
          return {}
        case 'data':
          return new Uint8Array()
        default:
          throw new PlistError(`Unknown <${token.name}/>.`)
      }
    }
    if (token.kind !== 'open') throw new PlistError('Expected a value.')
    switch (token.name) {
      case 'string':
        return textUntil('string')
      case 'integer': {
        const text = textUntil('integer').trim()
        const n = Number(text)
        return Number.isSafeInteger(n) ? n : BigInt(text)
      }
      case 'real':
        return new PlistReal(Number(textUntil('real').trim()))
      case 'date':
        return new Date(textUntil('date').trim())
      case 'data':
        return new Uint8Array(Buffer.from(textUntil('data').replace(/\s+/g, ''), 'base64'))
      case 'array': {
        const items: PlistValue[] = []
        for (;;) {
          const t = skipSpace()
          if (t.kind === 'close' && t.name === 'array') return items
          items.push(value(t))
        }
      }
      case 'dict': {
        const dict: Record<string, PlistValue> = {}
        for (;;) {
          const t = skipSpace()
          if (t.kind === 'close' && t.name === 'dict') return dict
          if (t.kind === 'empty' && t.name === 'key') {
            dict[''] = value(skipSpace())
            continue
          }
          if (t.kind !== 'open' || t.name !== 'key') throw new PlistError('Expected a <key>.')
          const key = textUntil('key')
          dict[key] = value(skipSpace())
        }
      }
      default:
        throw new PlistError(`Unknown <${token.name}>.`)
    }
  }
  for (;;) {
    const token = skipSpace()
    if (token.kind === 'open' && token.name === 'plist') return value(skipSpace())
  }
}

// ---------- Binary in ----------

const EPOCH_2001 = 978_307_200_000

export function decodeBinary(bytes: Uint8Array): PlistValue {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 40 || buf.toString('latin1', 0, 6) !== 'bplist')
    throw new PlistError('Not a binary plist.')
  const trailer = buf.length - 32
  const offsetSize = buf[trailer + 6] as number
  const refSize = buf[trailer + 7] as number
  const count = Number(buf.readBigUInt64BE(trailer + 8))
  const top = Number(buf.readBigUInt64BE(trailer + 16))
  const tableAt = Number(buf.readBigUInt64BE(trailer + 24))
  const uint = (at: number, size: number): number => {
    let n = 0
    for (let k = 0; k < size; k++) n = n * 256 + (buf[at + k] as number)
    return n
  }
  const offset = (ref: number): number => {
    if (ref >= count) throw new PlistError('A reference is out of range.')
    return uint(tableAt + ref * offsetSize, offsetSize)
  }
  const depth = { n: 0 }
  const read = (ref: number): PlistValue => {
    if (++depth.n > 512) throw new PlistError('The plist nests too deeply.')
    try {
      return object(offset(ref))
    } finally {
      depth.n--
    }
  }
  const length = (at: number, low: number): [number, number] => {
    if (low !== 0x0f) return [low, at + 1]
    const marker = buf[at + 1] as number
    const size = 1 << (marker & 0x0f)
    return [uint(at + 2, size), at + 2 + size]
  }
  const object = (at: number): PlistValue => {
    const marker = buf[at] as number
    const high = marker >> 4
    const low = marker & 0x0f
    switch (high) {
      case 0x0:
        if (marker === 0x08) return false
        if (marker === 0x09) return true
        throw new PlistError('A null is not supported.')
      case 0x1: {
        const size = 1 << low
        if (size === 8) {
          const n = buf.readBigInt64BE(at + 1)
          return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n
        }
        if (size === 16) return buf.readBigInt64BE(at + 9)
        return uint(at + 1, size)
      }
      case 0x2:
        return new PlistReal(low === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1))
      case 0x3:
        return new Date(EPOCH_2001 + buf.readDoubleBE(at + 1) * 1000)
      case 0x4: {
        const [n, start] = length(at, low)
        return new Uint8Array(buf.subarray(start, start + n))
      }
      case 0x5: {
        const [n, start] = length(at, low)
        return buf.toString('latin1', start, start + n)
      }
      case 0x6: {
        const [n, start] = length(at, low)
        const chars = Buffer.from(buf.subarray(start, start + n * 2))
        chars.swap16()
        return chars.toString('utf16le')
      }
      case 0x8:
        return { CF$UID: uint(at + 1, low + 1) }
      case 0xa: {
        const [n, start] = length(at, low)
        const items: PlistValue[] = []
        for (let k = 0; k < n; k++) items.push(read(uint(start + k * refSize, refSize)))
        return items
      }
      case 0xd: {
        const [n, start] = length(at, low)
        const dict: Record<string, PlistValue> = {}
        for (let k = 0; k < n; k++) {
          const key = read(uint(start + k * refSize, refSize))
          if (typeof key !== 'string') throw new PlistError('A dictionary key is not a string.')
          dict[key] = read(uint(start + (n + k) * refSize, refSize))
        }
        return dict
      }
      default:
        throw new PlistError(`Unknown binary plist marker ${marker.toString(16)}.`)
    }
  }
  return read(top)
}

/** XML or binary, whichever the bytes are. */
export function decode(bytes: Uint8Array): PlistValue {
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1')
  if (head.startsWith('bplist')) return decodeBinary(bytes)
  return decodeXml(Buffer.from(bytes).toString('utf8'))
}

export function isDict(value: unknown): value is Record<string, PlistValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date) &&
    !(value instanceof PlistReal)
  )
}
