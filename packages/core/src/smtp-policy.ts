// What an SMTP send may be (docs/adapter-kinds.md#protocol, workstream G), and the message Valet
// builds from it. No imports: the protocol host bundles this file too, so the runtime (which asks
// the person) and the host (which sends) check the same rules and build the same bytes.
//
// The rules close the usual ways tool code could make a send do more than it shows:
// - addresses are plain `local@domain`: no display names, comments, quotes, commas, angle brackets
//   or line breaks, so one address can't smuggle in another recipient or an SMTP command;
// - the subject has no control or bidirectional-override characters, and is encoded by Valet;
// - there are no other headers at all: From is the signed-in account, set by the host, and the
//   body goes as base64, so no text tool code writes can start a header or end the DATA;
// - every recipient, Bcc included, is shown to the person and checked against the manifest's list.

export interface MailMessage {
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  /** Plain text. Line breaks are `\n` or `\r\n`; Valet sends CRLF. */
  readonly text: string
  /** A reply's parent, `<id@host>`, or null. */
  readonly inReplyTo: string | null
  readonly references: readonly string[]
}

export const MAIL_LIMITS = {
  /** To, Cc and Bcc together. */
  recipients: 50,
  /** 190, so "Bcc: " and an address fit one 200-character line of a signed preview (red team I). */
  address: 190,
  subject: 300,
  /** Characters of body text. */
  text: 100_000,
  references: 20,
  messageId: 200,
} as const

// atext without `%` and `!`, the old routing characters: `eve%evil.test@example.com` must never pass
// an `@example.com` rule on the chance that example.com's server still relays it.
const ATEXT = "A-Za-z0-9#$&'*+/=?^_`{|}~-"
const LOCAL = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*$`)
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
const TLD = /^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$/

/** A plain `local@domain` address: dot-atom local part, a host name with a top-level domain. */
export function isMailAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > MAIL_LIMITS.address) return false
  const at = value.lastIndexOf('@')
  if (at < 1 || at !== value.indexOf('@')) return false
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  if (local.length > 64 || !LOCAL.test(local)) return false
  const labels = domain.split('.')
  if (labels.length < 2 || domain.length > 190) return false
  if (!labels.every((l) => LABEL.test(l))) return false
  return TLD.test(labels[labels.length - 1] as string)
}

/** `<left@right>`, each side dot-atom: nothing that could end a header or hide another. */
export function isMessageId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAIL_LIMITS.messageId) return false
  const m = /^<([^<>@]+)@([^<>@]+)>$/.exec(value)
  return m !== null && LOCAL.test(m[1] as string) && LOCAL.test(m[2] as string)
}

/**
 * Characters a person can't see or that change how text around them reads: controls, format
 * characters (zero-width spaces and joiners, direction marks, tags), line and paragraph
 * separators, private-use and unassigned code points, fillers that render blank, and variation
 * selectors other than the emoji ones. Text keeps `\n`, `\r\n` and `\t`; a lone `\r` is refused.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u

/** Blank fillers, the grapheme joiner, and variation selectors other than the emoji ones. */
function isBlankMark(c: number): boolean {
  return (
    c === 0x034f ||
    c === 0x115f ||
    c === 0x1160 ||
    c === 0x3164 ||
    c === 0xffa0 ||
    (c >= 0xfe00 && c <= 0xfe0d) ||
    (c >= 0xe0100 && c <= 0xe01ef)
  )
}

const hidden = (value: string): boolean => {
  if (HIDDEN.test(value)) return true
  for (const ch of value) if (isBlankMark(ch.codePointAt(0) as number)) return true
  return false
}

function hasHiddenCharacters(value: string, allowLineBreaks: boolean): boolean {
  if (!allowLineBreaks) return hidden(value)
  if (/\r(?!\n)/.test(value)) return true
  return hidden(value.replace(/[\r\n\t]/g, ''))
}

/**
 * A copy of `value` if it is a plain array of at most `max` entries, read by index: never through
 * its iterator, which tool code may have replaced, and with no holes or extra properties.
 */
function plainArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const length = value.length
  if (length > max) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1) return null
  const copy: unknown[] = []
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(value, i)) return null
    copy.push(value[i])
  }
  return copy
}

function addressList(value: unknown): string[] | null {
  if (value === undefined) return []
  const copy = plainArray(value, MAIL_LIMITS.recipients)
  return copy?.every(isMailAddress) ? (copy as string[]) : null
}

const KEYS = new Set(['to', 'cc', 'bcc', 'subject', 'text', 'inReplyTo', 'references'])

/**
 * The message tool code passed to ctx.smtp.send, checked and with its optional fields filled in,
 * or null if it breaks any rule. Unknown keys are refused, not ignored.
 */
export function checkMailMessage(value: unknown): MailMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) if (!KEYS.has(key)) return null
  const to = addressList(v['to'])
  const cc = addressList(v['cc'])
  const bcc = addressList(v['bcc'])
  if (to === null || cc === null || bcc === null || to.length === 0) return null
  const all = [...to, ...cc, ...bcc]
  if (all.length > MAIL_LIMITS.recipients) return null
  if (new Set(all.map((a) => a.toLowerCase())).size !== all.length) return null
  const subject = v['subject']
  if (typeof subject !== 'string' || subject.length > MAIL_LIMITS.subject) return null
  if (hasHiddenCharacters(subject, false)) return null
  const text = v['text']
  if (typeof text !== 'string' || text.length > MAIL_LIMITS.text) return null
  if (hasHiddenCharacters(text, true)) return null
  const inReplyTo = v['inReplyTo'] ?? null
  if (inReplyTo !== null && !isMessageId(inReplyTo)) return null
  const references = plainArray(v['references'] ?? [], MAIL_LIMITS.references)
  if (references === null || !references.every(isMessageId)) return null
  return {
    to,
    cc,
    bcc,
    subject,
    text,
    inReplyTo: inReplyTo as string | null,
    references: references as string[],
  }
}

/**
 * Whether `address` may be sent to under a manifest's `recipients` list: each entry is an exact
 * address or `@domain` for every address at exactly that domain (no subdomains). Null: anyone.
 * Compared without case.
 */
export function recipientAllowed(address: string, rules: readonly string[] | null): boolean {
  if (rules === null) return true
  const lower = address.toLowerCase()
  const domain = lower.slice(lower.lastIndexOf('@'))
  return rules.some((rule) => {
    const r = rule.toLowerCase()
    return r.startsWith('@') ? r === domain : r === lower
  })
}

/** Every recipient of `message`, To then Cc then Bcc: the SMTP envelope. */
export function envelopeRecipients(message: MailMessage): string[] {
  return [...message.to, ...message.cc, ...message.bcc]
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')

/** An RFC 5322 date, in UTC. */
export function mailDate(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(
    d.getUTCHours(),
  )}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

/** UTF-8 bytes, without TextEncoder: tool code's isolated context has only the language's own globals. */
function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const point = ch.codePointAt(0) as number
    // A lone surrogate becomes U+FFFD, as TextEncoder writes it.
    const c = point >= 0xd800 && point <= 0xdfff ? 0xfffd : point
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

/** The subject as a header value: plain if it is short printable ASCII, else RFC 2047 words. */
function subjectHeader(subject: string): string {
  if (/^[\x20-\x7e]{0,70}$/.test(subject) && !subject.includes('=?')) return subject
  // Whole characters per word, at most 45 bytes each, so no word splits a UTF-8 sequence.
  const words: string[] = []
  let chunk = ''
  for (const ch of subject) {
    if (utf8(chunk + ch).length > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk !== '' || words.length === 0) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${base64(utf8(w))}?=`).join('\r\n ')
}

/** An address header, one address per line after the first. */
function addressHeader(name: string, addresses: readonly string[]): string {
  return `${name}: ${addresses.join(',\r\n ')}`
}

/**
 * The message as sent: CRLF lines, 7-bit, every line under 1000 characters. Bcc is in the
 * envelope only. `messageId` is the caller's random `<id@domain>`.
 */
export function buildMailMessage(
  from: string,
  message: MailMessage,
  options: { readonly messageId: string; readonly date: number },
): string {
  if (!isMailAddress(from) || !isMessageId(options.messageId)) throw new Error('invalid')
  const headers = [
    `From: ${from}`,
    addressHeader('To', message.to),
    ...(message.cc.length > 0 ? [addressHeader('Cc', message.cc)] : []),
    `Subject: ${subjectHeader(message.subject)}`,
    `Date: ${mailDate(options.date)}`,
    `Message-ID: ${options.messageId}`,
    ...(message.inReplyTo === null ? [] : [`In-Reply-To: ${message.inReplyTo}`]),
    ...(message.references.length > 0 ? [`References: ${message.references.join('\r\n ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ]
  const body = base64(utf8(message.text.replace(/\r?\n/g, '\r\n')))
  const lines: string[] = []
  for (let i = 0; i < body.length; i += 76) lines.push(body.slice(i, i + 76))
  return `${headers.join('\r\n')}\r\n\r\n${lines.join('\r\n')}\r\n`
}
