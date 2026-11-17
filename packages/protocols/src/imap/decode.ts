// Turning mail's encodings into text: transfer encodings (base64, quoted-printable), charsets, and
// RFC 2047 encoded words in headers. Every input is written by whoever sent the mail, so every
// function here is total: it returns its best reading, bounded in size, and never throws.

/** Decodes a part's body by its Content-Transfer-Encoding. Unknown encodings pass through. */
export function decodeTransfer(body: Buffer, encoding: string | null): Buffer {
  switch ((encoding ?? '').toLowerCase()) {
    case 'base64':
      return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/]/g, ''), 'base64')
    case 'quoted-printable':
      return decodeQuotedPrintable(body)
    default:
      return body
  }
}

export function decodeQuotedPrintable(body: Buffer): Buffer {
  const out = Buffer.alloc(body.length)
  let o = 0
  for (let i = 0; i < body.length; i++) {
    const b = body[i] as number
    if (b !== 0x3d /* = */) {
      out[o++] = b
      continue
    }
    const a = body[i + 1]
    const c = body[i + 2]
    // A soft line break: `=` at the end of a line, perhaps after trailing spaces were stripped.
    if (a === 0x0d && c === 0x0a) {
      i += 2
      continue
    }
    if (a === 0x0a) {
      i += 1
      continue
    }
    const hex = a !== undefined && c !== undefined ? String.fromCharCode(a, c) : ''
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[o++] = Number.parseInt(hex, 16)
      i += 2
    } else out[o++] = b
  }
  return out.subarray(0, o)
}

/** Charsets mail calls by names TextDecoder doesn't know. */
const ALIASES: Readonly<Record<string, string>> = {
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
  'x-unknown': 'utf-8',
  'unknown-8bit': 'windows-1252',
  latin1: 'windows-1252',
  'iso-8859-1': 'windows-1252',
  'ks_c_5601-1987': 'euc-kr',
  'x-mac-roman': 'macintosh',
  macroman: 'macintosh',
}

/** Bytes in a charset as text. An unknown charset reads as UTF-8 with replacement characters. */
export function decodeCharset(bytes: Buffer, charset: string | null): string {
  const name = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  const label = ALIASES[name] ?? name
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

const ENCODED_WORD = /=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]{0,1000})\?=/g

/**
 * A header's text with RFC 2047 encoded words decoded. Whitespace between two adjacent encoded
 * words is dropped, as the RFC says. Control characters are removed: a header is one line.
 */
export function decodeHeader(raw: string): string {
  const joined = raw.replace(/(\?=)\s+(=\?)/g, '$1$2')
  const decoded = joined.replace(ENCODED_WORD, (_whole, charset: string, kind: string, data: string) => {
    const bytes =
      kind.toLowerCase() === 'b'
        ? Buffer.from(data, 'base64')
        : decodeQuotedPrintable(Buffer.from(data.replace(/_/g, ' '), 'latin1'))
    // RFC 2231 adds a language after `*`: `utf-8*en`.
    return decodeCharset(bytes, charset.split('*')[0] ?? null)
  })
  return oneLine(decoded)
}

/** No control characters or line breaks; runs of whitespace become one space. */
export function oneLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Text for a model to read, with the control characters a terminal or renderer might act on
 * removed (bidi overrides and zero-width characters stay out of headers; bodies keep line breaks).
 */
export function cleanBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** Removes characters that can make a line display as something else: bidi controls and invisibles. */
export function visibleOnly(text: string): string {
  return text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
}

/** At most `max` UTF-16 units, cut at a code point boundary. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return { text: text.slice(0, end), truncated: true }
}
