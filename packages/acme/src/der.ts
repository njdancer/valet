// Just enough DER (X.690) to write a certificate signing request and a self-signed certificate.
// Writing only: anything this package reads (a certificate Let's Encrypt issued) goes through
// Node's own X509Certificate.

export type Der = Buffer

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export function tlv(tag: number, content: Buffer): Der {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content])
}

export const sequence = (...items: Der[]): Der => tlv(0x30, Buffer.concat(items))
export const set = (...items: Der[]): Der => tlv(0x31, Buffer.concat(items))
export const octetString = (content: Buffer): Der => tlv(0x04, content)
export const utf8String = (text: string): Der => tlv(0x0c, Buffer.from(text, 'utf8'))
export const boolean = (value: boolean): Der => tlv(0x01, Buffer.from([value ? 0xff : 0]))
export const nullValue = (): Der => Buffer.from([0x05, 0x00])
/** [n] EXPLICIT, constructed. */
export const explicit = (n: number, content: Der): Der => tlv(0xa0 | n, content)
/** [n] IMPLICIT, primitive (a GeneralName's dNSName is [2]). */
export const implicitPrimitive = (n: number, content: Buffer): Der => tlv(0x80 | n, content)

/** A BIT STRING with no unused bits. */
export const bitString = (content: Buffer): Der => tlv(0x03, Buffer.concat([Buffer.from([0]), content]))

/** A non-negative INTEGER from big-endian bytes. */
export function integer(bytes: Buffer): Der {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  let body = bytes.subarray(start)
  if (body.length === 0) body = Buffer.from([0])
  if ((body[0] as number) & 0x80) body = Buffer.concat([Buffer.from([0]), body])
  return tlv(0x02, body)
}

export function oid(dotted: string): Der {
  const parts = dotted.split('.').map((p) => Number(p))
  const [a, b, ...rest] = parts
  if (a === undefined || b === undefined) throw new Error('bad oid')
  const out: number[] = [a * 40 + b]
  for (const part of rest) {
    const bytes: number[] = [part & 0x7f]
    for (let n = Math.floor(part / 128); n > 0; n = Math.floor(n / 128)) bytes.unshift((n & 0x7f) | 0x80)
    out.push(...bytes)
  }
  return tlv(0x06, Buffer.from(out))
}

/** UTCTime through 2049, GeneralizedTime after (RFC 5280 section 4.1.2.5). */
export function time(date: Date): Der {
  const iso = date.toISOString()
  const compact = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  if (date.getUTCFullYear() < 2050) return tlv(0x17, Buffer.from(compact.slice(2), 'latin1'))
  return tlv(0x18, Buffer.from(compact, 'latin1'))
}
