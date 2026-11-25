// Just enough of RFC 5322 and MIME to read a message Mail saved: headers (folded, with RFC 2047
// encoded words), multipart bodies, base64 and quoted-printable, charsets, and HTML turned into
// plain text. Every loop is linear in its input and bounded in depth and parts, because the input
// is whatever a sender chose to write.

export interface Address {
  readonly name: string | null
  readonly address: string
}

export interface Attachment {
  readonly name: string
  readonly contentType: string
  /** Decoded size in bytes. */
  readonly size: number
}

/** An attachment as found in the file: its MIME section ("2", "1.3") and decoded bytes. */
export interface AttachmentPart extends Attachment {
  readonly section: string
  readonly charset: string | null
  /** Empty when Mail keeps the attachment in a file of its own (a partly downloaded message). */
  readonly data: Buffer
}

export interface Link {
  readonly text: string
  readonly url: string
}

export interface ParsedMessage {
  readonly headers: ReadonlyMap<string, readonly string[]>
  readonly subject: string | null
  readonly from: readonly Address[]
  readonly to: readonly Address[]
  readonly cc: readonly Address[]
  readonly replyTo: readonly Address[]
  readonly date: string | null
  /** Without the angle brackets. */
  readonly messageId: string | null
  readonly inReplyTo: string | null
  readonly references: readonly string[]
  /**
   * The plain-text body: the text/plain part, or the HTML part as text when there is none or it
   * says clearly more (pictures' alt text included). Empty when there is neither.
   */
  readonly text: string
  readonly attachments: readonly Attachment[]
  /** The same attachments in order, with their bytes; never handed to agents as such. */
  readonly attachmentParts: readonly AttachmentPart[]
  /** Web and mail links from the HTML part, whether or not there is a plain-text part. */
  readonly links: readonly Link[]
  /** The text/html part as it is, null when there is none. */
  readonly html: string | null
}

const MAX_DEPTH = 8
const MAX_PARTS = 200

/** Splits off the header block at the first blank line. */
export function splitMessage(raw: Buffer): { readonly head: Buffer; readonly body: Buffer } {
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] !== 0x0a) continue
    if (raw[i + 1] === 0x0a) return { head: raw.subarray(0, i), body: raw.subarray(i + 2) }
    if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a)
      return { head: raw.subarray(0, i), body: raw.subarray(i + 3) }
  }
  return { head: raw, body: Buffer.alloc(0) }
}

/** Header bytes as text: UTF-8 when valid (many senders write it raw), else Latin-1. */
function headerText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}

/** Lower-cased names to their unfolded, still-encoded values, in order. */
export function parseHeaders(head: Buffer): Map<string, string[]> {
  const headers = new Map<string, string[]>()
  let name: string | null = null
  let value = ''
  const flush = (): void => {
    if (name === null) return
    const list = headers.get(name) ?? []
    list.push(value.trim())
    headers.set(name, list)
  }
  for (const line of headerText(head).split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && name !== null) {
      value += ` ${line.trim()}`
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    flush()
    name = line.slice(0, colon).trim().toLowerCase()
    value = line.slice(colon + 1)
  }
  flush()
  return headers
}

export function decodeCharset(bytes: Buffer, charset: string | null): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase()
  try {
    return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function decodeQ(text: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '_') out.push(0x20)
    else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else out.push(text.charCodeAt(i) & 0xff)
  }
  return Buffer.from(out)
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g

/** RFC 2047: encoded words decoded, the whitespace between two of them dropped. */
export function decodeWords(value: string): string {
  let out = ''
  let last = 0
  let previousEnd = -1
  for (const match of value.matchAll(ENCODED_WORD)) {
    const start = match.index
    const between = value.slice(last, start)
    if (!(previousEnd === last && /^\s*$/.test(between))) out += between
    const charset = (match[1] ?? 'utf-8').split('*')[0] ?? 'utf-8'
    const data = match[3] ?? ''
    const bytes = match[2]?.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : decodeQ(data)
    out += decodeCharset(bytes, charset)
    last = start + match[0].length
    previousEnd = last
  }
  return out + value.slice(last)
}

export interface HeaderValue {
  readonly value: string
  readonly params: ReadonlyMap<string, string>
}

/** `type/subtype; a=b; c="d"` with RFC 2231 continuations and charsets (`name*0*=utf-8''…`). */
export function parseParams(header: string): HeaderValue {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < header.length; i++) {
    const c = header[i] ?? ''
    if (c === '"') quoted = !quoted
    if (c === '\\' && quoted) {
      current += header[i + 1] ?? ''
      i++
      continue
    }
    if (c === ';' && !quoted) {
      parts.push(current)
      current = ''
    } else current += c
  }
  parts.push(current)
  const value = (parts.shift() ?? '').trim().toLowerCase()
  const raw = new Map<string, string>()
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    let val = part.slice(eq + 1).trim()
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1)
    raw.set(key, val)
  }
  const params = new Map<string, string>()
  const continued = new Map<string, { parts: Map<number, string>; encoded: boolean }>()
  for (const [key, val] of raw) {
    const m = key.includes('*') ? /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key) : null
    if (m === null) {
      params.set(key, decodeWords(val))
      continue
    }
    const base = m[1] ?? key
    const entry = continued.get(base) ?? { parts: new Map(), encoded: false }
    entry.parts.set(Number(m[2] ?? 0), val)
    if (m[3] !== undefined && (m[2] === undefined || m[2] === '0')) entry.encoded = true
    continued.set(base, entry)
  }
  for (const [base, entry] of continued) {
    const joined = [...entry.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .join('')
    if (!entry.encoded) {
      params.set(base, joined)
      continue
    }
    const m = /^([^']*)'[^']*'(.*)$/.exec(joined)
    const charset = m?.[1] || 'utf-8'
    const text = m?.[2] ?? joined
    try {
      params.set(base, decodeCharset(Buffer.from(decodeURIComponentBytes(text)), charset))
    } catch {
      params.set(base, text)
    }
  }
  return { value, params }
}

function decodeURIComponentBytes(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else out.push(text.charCodeAt(i) & 0xff)
  }
  return out
}

/** A list of addresses: `Name <a@b>, "Last, First" <c@d>, e@f`. */
export function parseAddresses(value: string | undefined): Address[] {
  if (value === undefined) return []
  const out: Address[] = []
  let current = ''
  let quoted = false
  let angle = 0
  const push = (): void => {
    const item = current.trim()
    current = ''
    if (item.length === 0) return
    const lt = item.lastIndexOf('<')
    const gt = item.lastIndexOf('>')
    if (lt >= 0 && gt > lt) {
      const address = item.slice(lt + 1, gt).trim()
      let name = item.slice(0, lt).trim()
      if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1)
      name = decodeWords(name).trim()
      if (address.includes('@')) out.push({ name: name.length > 0 ? name : null, address })
      return
    }
    const bare = item.replace(/\(.*\)$/, '').trim()
    if (bare.includes('@')) out.push({ name: null, address: bare })
  }
  for (const c of value) {
    if (c === '"') quoted = !quoted
    else if (c === '<' && !quoted) angle++
    else if (c === '>' && !quoted && angle > 0) angle--
    if ((c === ',' || c === ';') && !quoted && angle === 0) push()
    else current += c
  }
  push()
  return out.slice(0, 200)
}

function messageIds(value: string | undefined): string[] {
  if (value === undefined) return []
  const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1] ?? '')
  if (ids.length > 0) return ids.filter((id) => id.length > 0).slice(0, 100)
  const bare = value.trim()
  return bare.length > 0 && !/\s/.test(bare) ? [bare] : []
}

function decodeTransfer(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
    case 'quoted-printable': {
      const text = body.toString('latin1')
      const out: number[] = []
      for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c !== '=') {
          out.push(text.charCodeAt(i) & 0xff)
          continue
        }
        const next = text.slice(i + 1, i + 3)
        if (/^[0-9A-Fa-f]{2}$/.test(next)) {
          out.push(Number.parseInt(next, 16))
          i += 2
        } else if (next.startsWith('\r\n')) i += 2
        else if (next.startsWith('\n')) i += 1
        else out.push(0x3d)
      }
      return Buffer.from(out)
    }
    default:
      return body
  }
}

/** The parts between `--boundary` lines, the preamble and epilogue left out. */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1')
  const marker = `--${boundary}`
  const parts: Buffer[] = []
  let at = text.indexOf(marker)
  while (at >= 0 && parts.length < MAX_PARTS) {
    let start = at + marker.length
    if (text.startsWith('--', start)) break
    const lineEnd = text.indexOf('\n', start)
    if (lineEnd < 0) break
    start = lineEnd + 1
    const next = text.indexOf(`\n${marker}`, start)
    const end = next < 0 ? text.length : next
    let partEnd = end
    if (partEnd > start && text[partEnd - 1] === '\r') partEnd--
    parts.push(body.subarray(start, partEnd))
    if (next < 0) break
    at = next + 1
  }
  return parts
}

interface Collected {
  plain: string | null
  html: string | null
  attachments: AttachmentPart[]
  parts: number
}

function walk(raw: Buffer, depth: number, found: Collected, section = '1'): void {
  if (depth > MAX_DEPTH || found.parts >= MAX_PARTS) return
  found.parts++
  const { head, body } = splitMessage(raw)
  const headers = parseHeaders(head)
  const contentType = parseParams(headers.get('content-type')?.[0] ?? 'text/plain')
  const disposition = parseParams(headers.get('content-disposition')?.[0] ?? '')
  const type = contentType.value.length > 0 ? contentType.value : 'text/plain'
  const name = disposition.params.get('filename') ?? contentType.params.get('name') ?? null
  if (type.startsWith('multipart/')) {
    const boundary = contentType.params.get('boundary')
    if (boundary === undefined || boundary.length === 0) return
    const parts = splitMultipart(body, boundary)
    // IMAP's section numbers: a top-level multipart's parts are 1, 2…; deeper ones 1.1, 1.2….
    parts.forEach((part, i) => {
      walk(part, depth + 1, found, depth === 0 ? `${i + 1}` : `${section}.${i + 1}`)
    })
    return
  }
  const decoded = decodeTransfer(body, headers.get('content-transfer-encoding')?.[0])
  const isAttachment = disposition.value === 'attachment' || (name !== null && !type.startsWith('text/'))
  if (!isAttachment && type === 'text/plain' && found.plain === null) {
    found.plain = decodeCharset(decoded, contentType.params.get('charset') ?? null)
    return
  }
  if (!isAttachment && type === 'text/html' && found.html === null) {
    found.html = decodeCharset(decoded, contentType.params.get('charset') ?? null)
    return
  }
  if (name !== null || isAttachment || type === 'message/rfc822') {
    const declared = Number(headers.get('x-apple-content-length')?.[0])
    found.attachments.push({
      name: decodeWords(name ?? (type === 'message/rfc822' ? 'forwarded message.eml' : 'attachment')),
      contentType: type,
      size: decoded.length === 0 && Number.isFinite(declared) && declared > 0 ? declared : decoded.length,
      section,
      charset: contentType.params.get('charset') ?? null,
      data: decoded,
    })
  }
}

/** Letters and digits, leaving out web addresses (a plain part spells its links out; HTML doesn't). */
function content(text: string): number {
  return text.replace(/\bhttps?:\/\/\S+/gi, '').replace(/[^\p{L}\p{N}]/gu, '').length
}

/**
 * The text/plain part, unless the HTML part says clearly more: some senders' plain part is a
 * template with the values left out (agent feedback #12, a retailer's invoice with empty item
 * rows), while the HTML has them.
 */
function bodyText(plain: string | null, html: string | null): string {
  if (html === null) return plain ?? ''
  const fromHtml = htmlToText(html)
  if (plain === null) return fromHtml
  return content(fromHtml) > content(plain) * 1.2 + 20 ? fromHtml : plain
}

export function parseMessage(raw: Buffer): ParsedMessage {
  const { head } = splitMessage(raw)
  const headers = parseHeaders(head)
  const first = (key: string): string | undefined => headers.get(key)?.[0]
  const found: Collected = { plain: null, html: null, attachments: [], parts: 0 }
  walk(raw, 0, found)
  const text = bodyText(found.plain, found.html)
  const subject = first('subject')
  return {
    headers,
    subject: subject === undefined ? null : decodeWords(subject),
    from: parseAddresses(first('from')),
    to: parseAddresses(headers.get('to')?.join(', ')),
    cc: parseAddresses(headers.get('cc')?.join(', ')),
    replyTo: parseAddresses(first('reply-to')),
    date: first('date') ?? null,
    messageId: messageIds(first('message-id'))[0] ?? null,
    inReplyTo: messageIds(first('in-reply-to'))[0] ?? null,
    references: messageIds(first('references')),
    text: normaliseText(text),
    attachments: found.attachments.map(({ name, contentType, size }) => ({ name, contentType, size })),
    attachmentParts: found.attachments,
    links: found.html === null ? [] : htmlLinks(found.html),
    html: found.html,
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

const BLOCK_TAGS = new Set([
  'br',
  'p',
  'div',
  'tr',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'blockquote',
  'hr',
  'ul',
  'ol',
])
const SKIPPED_TAGS = new Set(['script', 'style', 'head', 'title'])

/** HTML as plain text in one pass: tags out, block tags as line breaks, scripts and styles dropped. */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase()
  let out = ''
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    if (gt < 0) break
    const tag = /^<\/?\s*([a-z0-9]+)/.exec(lower.slice(lt, Math.min(gt + 1, lt + 40)))?.[1] ?? ''
    const closing = lower[lt + 1] === '/'
    i = gt + 1
    if (!closing && SKIPPED_TAGS.has(tag)) {
      const end = lower.indexOf(`</${tag}`, i)
      const endGt = end < 0 ? -1 : lower.indexOf('>', end)
      i = endGt < 0 ? html.length : endGt + 1
      continue
    }
    // A table row is a line of its own: a break before it, none after, so rows sit together.
    if (BLOCK_TAGS.has(tag) && !(tag === 'tr' && closing)) out += '\n'
    else if (tag === 'td' || tag === 'th') out += ' '
    else if (tag === 'img' && !closing) {
      // A picture's words: retailers often name the product only in its picture's alt (or title).
      const tagText = html.slice(lt, gt + 1)
      const attr = (name: string): string => {
        const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tagText)
        return (m?.[1] ?? m?.[2] ?? '').trim()
      }
      const words = attr('alt') || attr('title')
      if (words.length > 0 && words.length <= 300) out += ` ${words} `
    }
  }
  return decodeEntities(out)
}

const MAX_LINKS = 100

/** The http(s) and mailto links in some HTML with their text, each address once, at most 100. */
export function htmlLinks(html: string): Link[] {
  const out: Link[] = []
  const seen = new Set<string>()
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi
  for (const m of html.matchAll(re)) {
    const url = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim())
    if (!/^(https?:|mailto:)/i.test(url) || url.length > 2_000 || seen.has(url)) continue
    seen.add(url)
    const text = normaliseText(htmlToText(m[4] ?? ''))
      .replace(/\n/g, ' ')
      .slice(0, 200)
    out.push({ text, url })
    if (out.length >= MAX_LINKS) break
  }
  return out
}

/** Line endings as \n, runs of spaces as one, at most one blank line in a row. */
export function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
