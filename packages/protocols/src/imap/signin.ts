// The one built-in mail lookup: a site's sign-in link or code (docs/adapter-kinds.md#email-sign-in-links-and-codes,
// docs/imap.md#email-sign-in). Valet runs it, never adapter code, because a sign-in link is a
// login secret: tool code that found it could read it or swap in another. It only ever looks:
// EXAMINE, BODY.PEEK, a read session.
//
// A message counts only if all of these hold:
// - it is in INBOX, and arrived (INTERNALDATE, the server's clock) after the login asked for it,
//   less a little for clock skew, and inside maxAgeSeconds;
// - its From is exactly one address, the approved sender;
// - its subject contains subjectContains, when given;
// - the receiving server's own Authentication-Results, when it adds one, says the sender's domain
//   passed DMARC or a DKIM signature aligned with it. (A forged From is otherwise easy, and a forged
//   link to the site's own origin could sign Valet in to someone else's account.)
// The newest message that counts is read; a link must be https on exactly linkOrigin, and a code
// must look like one.

import type { ImapClient } from './client'
import { ImapError } from './client'
import { cleanBody, decodeCharset, decodeTransfer } from './decode'
import { bodyParts, parseEnvelope, parseStructure } from './structure'
import { Atom, list, number, text, type Value } from './wire'

export interface SignInQuery {
  /** The approved sender's address, lower case. */
  readonly from: string
  readonly subjectContains?: string
  /** When the login asked for the mail, epoch ms (main's clock). */
  readonly after: number
  /** Main's clock now, epoch ms. */
  readonly now: number
  readonly maxAgeSeconds: number
  readonly extract: { readonly pattern: string } | { readonly linkOrigin: string }
}

export type SignInResult = { readonly found: true; readonly value: string } | { readonly found: false }

/** How far the mail server's clock may be ahead of Valet's. */
export const CLOCK_SKEW_MS = 120_000
/**
 * How far it may be behind: mail that seems to have arrived up to this long before the login asked
 * still counts. Kept short, since anyone can ask a site to mail a sign-in link to an address.
 */
export const ARRIVAL_SKEW_MS = 30_000
/** Messages looked at per lookup, newest first. */
const CANDIDATES = 10
const MAX_TEXT_BYTES = 256 * 1024
const MAX_HEADER_BYTES = 64 * 1024
const MAX_SCANNED_CHARS = 20_000
const MAX_LINK = 2048
export const CODE_SHAPE = /^[A-Za-z0-9]{4,10}$/

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** INTERNALDATE (`17-Nov-2026 15:53:51 +0000`) as epoch ms, or null. */
export function internalDateMs(value: string | null): number | null {
  const m =
    value === null
      ? null
      : /^\s?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value)
  if (m === null || m === undefined) return null
  const month = MONTHS.indexOf((m[2] as string).toLowerCase())
  if (month === -1) return null
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === '-' ? -1 : 1)
  return utc - offset
}

/** The header block's fields, unfolded, in order, names lower case. */
export function headerFields(block: string): [string, string][] {
  const out: [string, string][] = []
  for (const line of block.split(/\r?\n/)) {
    if (line === '') break
    if (/^[ \t]/.test(line) && out.length > 0) {
      const last = out[out.length - 1] as [string, string]
      last[1] = `${last[1]} ${line.trim()}`
    } else {
      const colon = line.indexOf(':')
      if (colon > 0) out.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()])
    }
  }
  return out
}

function aligned(domain: string, fromDomain: string): boolean {
  return fromDomain === domain || fromDomain.endsWith(`.${domain}`)
}

/**
 * An Authentication-Results value with its comments removed and every quoted string emptied
 * (RFC 8601 syntax). Receiving servers copy text the sender chose, such as the SMTP MAIL FROM and
 * HELO name, into quoted strings and comments, so neither may start or change a result.
 */
export function withoutCommentsOrQuotes(value: string): string {
  let out = ''
  let depth = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string
    if (c === '\\' && depth > 0) {
      i++
      continue
    }
    if (depth > 0) {
      if (c === '(') depth++
      else if (c === ')') depth--
      continue
    }
    if (c === '(') {
      depth = 1
      out += ' '
      continue
    }
    if (c === '"') {
      // Skip to the closing quote, honouring backslash escapes.
      for (i++; i < value.length && value[i] !== '"'; i++) if (value[i] === '\\') i++
      out += '""'
      continue
    }
    out += c
  }
  return out
}

/**
 * Whether the topmost Authentication-Results (the one the receiving server added last) vouches for
 * `fromDomain`: DMARC passed for it, or a DKIM signature whose signing domain (header.d) is aligned
 * with it. A DMARC result other than pass for the domain refuses it outright. True when there is no
 * header to read: not every server adds one.
 */
export function authenticated(fields: readonly [string, string][], fromDomain: string): boolean {
  const top = fields.find(([name]) => name === 'authentication-results')
  if (top === undefined) return true
  // The first element is the authserv-id; each one after it is `method=result property=value ...`.
  const results = withoutCommentsOrQuotes(top[1].toLowerCase())
    .split(';')
    .slice(1)
    .map((clause) => {
      const tokens = clause.trim().split(/\s+/)
      const head = /^([a-z0-9-]+)=([a-z]+)$/.exec(tokens[0] ?? '')
      const props = new Map<string, string>()
      for (const token of tokens.slice(1)) {
        const eq = token.indexOf('=')
        if (eq > 0 && !props.has(token.slice(0, eq))) props.set(token.slice(0, eq), token.slice(eq + 1))
      }
      return head === null ? null : { method: head[1] as string, result: head[2] as string, props }
    })
  let vouched = false
  for (const r of results) {
    if (r === null) continue
    if (r.method === 'dmarc') {
      const domain = r.props.get('header.from')
      if (domain === undefined || domain !== fromDomain) continue
      if (r.result !== 'pass') return false
      vouched = true
    } else if (r.method === 'dkim' && r.result === 'pass') {
      // Only the signing domain counts. header.i may carry a local part the signer chose.
      const domain = r.props.get('header.d')
      if (domain !== undefined && /^[a-z0-9.-]+$/.test(domain) && aligned(domain, fromDomain)) vouched = true
    }
  }
  return vouched
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Candidate links, in the order they appear: hrefs in the HTML, then bare URLs in the text. */
export function linksIn(html: string | null, plain: string | null): string[] {
  const out: string[] = []
  if (html !== null) {
    for (const m of html
      .slice(0, MAX_SCANNED_CHARS * 5)
      .matchAll(/href\s*=\s*(?:"([^"]{1,4096})"|'([^']{1,4096})')/gi)) {
      out.push(decodeEntities((m[1] ?? m[2] ?? '').trim()))
    }
  }
  for (const body of [plain, html]) {
    if (body === null) continue
    for (const m of body.slice(0, MAX_SCANNED_CHARS * 5).matchAll(/https:\/\/[^\s<>"'`]{1,4096}/g)) {
      out.push(decodeEntities(m[0]).replace(/[.,;:!?)\]}]+$/, ''))
    }
  }
  return out
}

/** The first link that is https on exactly `origin`, with no user info, or null. */
export function firstLink(candidates: readonly string[], origin: string): string | null {
  for (const candidate of candidates) {
    if (candidate.length > MAX_LINK) continue
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || url.origin !== origin || url.username !== '' || url.password !== '')
      continue
    return url.href
  }
  return null
}

/** The first code-shaped capture of `pattern` in the texts, or null. */
export function firstCode(pattern: string, texts: readonly string[]): string | null {
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch {
    throw new ImapError('invalid')
  }
  for (const t of texts) {
    const m = regex.exec(t.slice(0, MAX_SCANNED_CHARS))
    const capture = m === null ? null : (m[1] ?? m[0])
    if (capture !== null && capture !== undefined && CODE_SHAPE.test(capture)) return capture
  }
  return null
}

/** HTML as text, in one pass: tags become spaces, and script and style bodies are left out. */
export function stripTags(html: string): string {
  let out = ''
  let i = 0
  const lower = html.toLowerCase()
  while (i < html.length) {
    const open = html.indexOf('<', i)
    if (open === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, open)
    const close = html.indexOf('>', open)
    if (close === -1) break
    const name = /^<\s*(script|style)\b/.exec(lower.slice(open, Math.min(close + 1, open + 20)))
    if (name !== null) {
      const end = lower.indexOf(`</${name[1]}`, close)
      if (end === -1) break
      const after = html.indexOf('>', end)
      if (after === -1) break
      i = after + 1
    } else i = close + 1
    out += ' '
  }
  return decodeEntities(out).replace(/\s+/g, ' ')
}

function checkQuery(query: SignInQuery): void {
  const ok =
    query !== null &&
    typeof query === 'object' &&
    typeof query.from === 'string' &&
    /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}$/.test(query.from) &&
    (query.subjectContains === undefined ||
      (typeof query.subjectContains === 'string' && query.subjectContains.length <= 200)) &&
    Number.isSafeInteger(query.after) &&
    Number.isSafeInteger(query.now) &&
    Number.isInteger(query.maxAgeSeconds) &&
    query.maxAgeSeconds >= 10 &&
    query.maxAgeSeconds <= 1800 &&
    query.extract !== null &&
    typeof query.extract === 'object' &&
    (('pattern' in query.extract &&
      typeof query.extract.pattern === 'string' &&
      query.extract.pattern.length <= 200) ||
      ('linkOrigin' in query.extract &&
        // A link is taken only from mail whose subject says what it is (see the manifest).
        typeof query.subjectContains === 'string' &&
        query.subjectContains.length > 0 &&
        typeof query.extract.linkOrigin === 'string' &&
        /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(query.extract.linkOrigin)))
  if (!ok) throw new ImapError('invalid')
}

function items(values: readonly Value[]): Map<string, Value> {
  const out = new Map<string, Value>()
  const l = list(values[0])
  for (let i = 0; i + 1 < l.length; i += 2) {
    const key = l[i]
    if (key instanceof Atom) out.set(key.value.toUpperCase(), l[i + 1] ?? null)
  }
  return out
}

function section(map: Map<string, Value>, prefix: string): Buffer | null {
  for (const [key, value] of map) if (key.startsWith(prefix) && Buffer.isBuffer(value)) return value
  return null
}

/** Finds the sign-in link or code. Never changes the mailbox. */
export async function findSignInMail(client: ImapClient, query: SignInQuery): Promise<SignInResult> {
  checkQuery(query)
  const since = Math.max(query.after - ARRIVAL_SKEW_MS, query.now - query.maxAgeSeconds * 1000)
  await client.open('INBOX', true)
  const day = new Date(since - 86_400_000)
  const sinceDate = `${day.getUTCDate()}-${MONTHS[day.getUTCMonth()]?.replace(/^./, (c) => c.toUpperCase())}-${day.getUTCFullYear()}`
  const searched = await client.run({
    verb: 'UID SEARCH',
    args: [{ atom: 'SINCE' }, { atom: sinceDate }, { atom: 'FROM' }, { string: query.from }],
  })
  const uids: number[] = []
  for (const r of searched.untagged) {
    if (r.kind !== 'data' || r.name !== 'SEARCH') continue
    for (const v of r.values) {
      try {
        uids.push(number(v))
      } catch {}
    }
  }
  const newest = [...new Set(uids)].sort((a, b) => b - a).slice(0, CANDIDATES)
  if (newest.length === 0) return { found: false }
  const fetched = await client.run({
    verb: 'UID FETCH',
    args: [
      { uids: newest },
      {
        list: [
          'UID',
          'INTERNALDATE',
          'ENVELOPE',
          'BODYSTRUCTURE',
          `BODY.PEEK[HEADER]<0.${MAX_HEADER_BYTES}>`,
        ].map((atom) => ({ atom })),
      },
    ],
  })
  const fromDomain = query.from.slice(query.from.indexOf('@') + 1)
  const candidates: { uid: number; at: number; map: Map<string, Value> }[] = []
  for (const r of fetched.untagged) {
    if (r.kind !== 'data' || r.name !== 'FETCH') continue
    let map: Map<string, Value>
    let uid: number
    try {
      map = items(r.values)
      uid = number(map.get('UID'))
    } catch {
      continue
    }
    if (!newest.includes(uid)) continue
    const at = internalDateMs(text(map.get('INTERNALDATE')))
    if (at === null || at < since || at > query.now + CLOCK_SKEW_MS) continue
    const envelope = parseEnvelope(map.get('ENVELOPE'))
    if (envelope === null || envelope.from.length !== 1 || envelope.from[0]?.address !== query.from) continue
    if (query.subjectContains !== undefined) {
      const subject = envelope.subject?.toLowerCase() ?? ''
      if (!subject.includes(query.subjectContains.toLowerCase())) continue
    }
    const header = section(map, 'BODY[HEADER]')
    if (header === null || !authenticated(headerFields(header.toString('latin1')), fromDomain)) continue
    candidates.push({ uid, at, map })
  }
  candidates.sort((a, b) => b.at - a.at || b.uid - a.uid)
  for (const candidate of candidates) {
    const { plain, html } = bodyParts(parseStructure(candidate.map.get('BODYSTRUCTURE')))
    const read = async (part: typeof plain): Promise<string | null> => {
      if (part === null) return null
      const got = await client.run({
        verb: 'UID FETCH',
        args: [
          { uids: [candidate.uid] },
          { list: [{ atom: 'UID' }, { atom: `BODY.PEEK[${part.part}]<0.${MAX_TEXT_BYTES}>` }] },
        ],
      })
      for (const r of got.untagged) {
        if (r.kind !== 'data' || r.name !== 'FETCH') continue
        try {
          const map = items(r.values)
          if (number(map.get('UID')) !== candidate.uid) continue
          const bytes = section(map, `BODY[${part.part}]`)
          if (bytes !== null)
            return cleanBody(decodeCharset(decodeTransfer(bytes, part.encoding), part.charset))
        } catch {}
      }
      return null
    }
    const plainText = await read(plain)
    const htmlText = await read(html)
    if ('linkOrigin' in query.extract) {
      const link = firstLink(linksIn(htmlText, plainText), query.extract.linkOrigin)
      if (link !== null) return { found: true, value: link }
    } else {
      const subject = parseEnvelope(candidate.map.get('ENVELOPE'))?.subject ?? ''
      const texts = [subject, plainText ?? (htmlText === null ? '' : stripTags(htmlText))]
      const code = firstCode(query.extract.pattern, texts)
      if (code !== null) return { found: true, value: code }
    }
  }
  return { found: false }
}
