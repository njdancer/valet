// What ctx.imap does, as IMAP: each operation checks its arguments, keeps to the folders the
// manifest allows, and returns plain, bounded data, never the server's raw text. The protocol host
// runs these against the real server; the commands they send pass checkCommand on the way out.
//
// Arguments arrive from tool code (through the main process, which checked them once already), so
// every one is checked again here as if it were hostile.

import { decodeCharset, decodeTransfer, truncate, visibleOnly, cleanBody } from './decode'
import { decodeMailbox } from './command'
import { ImapClient, ImapError } from './client'
import { type FolderRule, folderAllowed, type Operation, type ImapPurpose as Purpose } from '@valet/core/imap-policy'

export type { FolderRule }
import { bodyParts, type Envelope, type Part, parseEnvelope, parseStructure } from './structure'
import { Atom, list, number, text, type Value } from './wire'
import type { Arg } from './command'


export interface OperationOptions {
  readonly folders: FolderRule
  readonly purpose: Purpose
}

export interface FolderInfo {
  readonly path: string
  readonly delimiter: string | null
  readonly flags: readonly string[]
  /** `\Sent`, `\Trash`, `\Archive`... (RFC 6154), when the server marks one. */
  readonly specialUse: string | null
}

export interface MessageSummary {
  readonly uid: number
  readonly flags: readonly string[]
  readonly internalDate: string | null
  readonly size: number
  readonly envelope: Envelope | null
}

export interface MessageBody extends MessageSummary {
  readonly text: string | null
  readonly html: string | null
  readonly attachments: readonly {
    readonly part: string
    readonly type: string
    readonly filename: string | null
    readonly size: number
  }[]
  readonly truncated: boolean
}

export const LIMITS = {
  folders: 500,
  searchDefault: 50,
  searchMax: 500,
  fetchMax: 100,
  storeMax: 1000,
  textCharsDefault: 100_000,
  textCharsMax: 1_000_000,
  attachmentBytesDefault: 1024 * 1024,
  attachmentBytesMax: 1536 * 1024,
  appendBytesMax: 1024 * 1024,
  criteriaDepth: 3,
  criteriaTerms: 20,
  folderChars: 200,
  searchTextChars: 200,
} as const

const SYSTEM_FLAGS = ['\\seen', '\\flagged', '\\answered', '\\draft', '\\deleted']
const KEYWORD = /^[A-Za-z0-9$_.-]{1,40}$/
const SPECIAL_USE = ['\\all', '\\archive', '\\drafts', '\\flagged', '\\junk', '\\sent', '\\trash']

export function invalid(): ImapError {
  return new ImapError('invalid')
}

function folderName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.folderChars) throw invalid()
  if (/[\u0000-\u001f\u007f*%]/.test(value)) throw invalid()
  return value
}

const allowed = folderAllowed

/** The folder, if the manifest allows it. Refused as `not-allowed` otherwise, before anything is sent. */
export function checkFolder(value: unknown, rule: FolderRule): string {
  const folder = folderName(value)
  if (!allowed(folder, rule)) throw new ImapError('not-allowed')
  return folder.toUpperCase() === 'INBOX' ? 'INBOX' : folder
}

function uidList(value: unknown, max: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw invalid()
  for (const uid of value) {
    if (!Number.isSafeInteger(uid) || (uid as number) < 1 || (uid as number) > 0xffffffff) throw invalid()
  }
  return [...new Set(value as number[])]
}

function flagList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw invalid()
  return value.map((flag) => {
    if (typeof flag !== 'string') throw invalid()
    const lower = flag.toLowerCase()
    if (flag.startsWith('\\')) {
      if (!SYSTEM_FLAGS.includes(lower)) throw invalid()
      return `\\${lower.charAt(1).toUpperCase()}${lower.slice(2)}`
    }
    if (!KEYWORD.test(flag)) throw invalid()
    return flag
  })
}

function options(value: unknown): Record<string, unknown> {
  // JSON turns a left-out argument in the middle of a list into null.
  if (value === undefined || value === null) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

function bounded(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw invalid()
  return value as number
}

function strings(values: readonly Value[]): string[] {
  return values.filter((v): v is Atom => v instanceof Atom).map((v) => v.value)
}

/** The value of a response code like `[UIDVALIDITY 3857529045]`, from a list of untagged responses. */
function codeNumber(responses: readonly { kind: string; code?: Value[] | null }[], name: string): number | null {
  for (const r of responses) {
    const code = r.kind === 'status' ? r.code : null
    if (code && code[0] instanceof Atom && code[0].value.toUpperCase() === name) {
      try {
        return number(code[1])
      } catch {
        return null
      }
    }
  }
  return null
}

function fetchItems(values: readonly Value[]): Map<string, Value> {
  const out = new Map<string, Value>()
  const items = list(values[0])
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = items[i]
    if (key instanceof Atom) out.set(key.value.toUpperCase(), items[i + 1] ?? null)
  }
  return out
}

function summaryOf(items: Map<string, Value>): MessageSummary | null {
  let uid: number
  try {
    uid = number(items.get('UID'))
  } catch {
    return null
  }
  const flagsValue = items.get('FLAGS')
  const size = items.get('RFC822.SIZE')
  return {
    uid,
    flags: Array.isArray(flagsValue) ? strings(flagsValue).slice(0, 50) : [],
    internalDate: text(items.get('INTERNALDATE'))?.slice(0, 40) ?? null,
    size: size instanceof Atom && /^\d{1,12}$/.test(size.value) ? Number(size.value) : 0,
    envelope: parseEnvelope(items.get('ENVELOPE')),
  }
}

/** UID FETCH, returning each message's items by UID. Messages the server didn't return are left out. */
async function fetchByUid(client: ImapClient, uids: readonly number[], items: readonly string[]) {
  const result = await client.run({
    verb: 'UID FETCH',
    args: [{ uids }, { list: items.map((atom): Arg => ({ atom })) }],
  })
  const out = new Map<number, Map<string, Value>>()
  for (const r of result.untagged) {
    if (r.kind !== 'data' || r.name !== 'FETCH') continue
    let map: Map<string, Value>
    try {
      map = fetchItems(r.values)
    } catch {
      continue
    }
    const uid = map.get('UID')
    if (!(uid instanceof Atom)) continue
    try {
      const n = number(uid)
      // Only what was asked for: a server may send FETCH data for other messages.
      if (uids.includes(n)) {
        const existing = out.get(n)
        if (existing === undefined) out.set(n, map)
        else for (const [k, v] of map) existing.set(k, v)
      }
    } catch {}
  }
  return out
}

/** The bytes of BODY[part] from a FETCH, by its item name, whatever partial origin the server echoes. */
function sectionBytes(items: Map<string, Value>, part: string): Buffer | null {
  for (const [key, value] of items) {
    if (key.startsWith(`BODY[${part}]`) && Buffer.isBuffer(value)) return value
  }
  return null
}

/** One IMAP session's operations. */
export class Operations {
  constructor(
    private readonly client: ImapClient,
    private readonly rule: OperationOptions,
  ) {}

  async run(operation: Operation, args: readonly unknown[]): Promise<unknown> {
    switch (operation) {
      case 'listFolders':
        return this.listFolders()
      case 'status':
        return this.status(args[0])
      case 'search':
        return this.search(args[0], args[1], args[2])
      case 'fetch':
        return this.fetch(args[0], args[1])
      case 'message':
        return this.message(args[0], args[1], args[2])
      case 'attachment':
        return this.attachment(args[0], args[1], args[2], args[3])
      case 'setFlags':
        return this.setFlags(args[0], args[1], args[2])
      case 'copy':
        return this.transfer('UID COPY', args[0], args[1], args[2])
      case 'move':
        return this.transfer('UID MOVE', args[0], args[1], args[2])
      case 'append':
        return this.append(args[0], args[1], args[2])
      case 'createFolder':
        return this.createFolder(args[0])
      case 'expunge':
        return this.expunge(args[0], args[1])
      case 'deleteFolder':
        return this.deleteFolder(args[0])
    }
  }

  private folder(value: unknown): string {
    return checkFolder(value, this.rule.folders)
  }

  async listFolders(): Promise<FolderInfo[]> {
    const result = await this.client.run({ verb: 'LIST', args: [{ string: '' }, { atom: '*' }] })
    const out: FolderInfo[] = []
    for (const r of result.untagged) {
      if (r.kind !== 'data' || r.name !== 'LIST' || out.length >= LIMITS.folders) continue
      const [flags, delimiter, name] = r.values
      const raw = text(name)
      if (raw === null || !Array.isArray(flags)) continue
      const path = visibleOnly(decodeMailbox(raw)).slice(0, LIMITS.folderChars)
      if (!allowed(path, this.rule.folders)) continue
      const flagNames = strings(flags).slice(0, 20)
      const specialUse = flagNames.find((f) => SPECIAL_USE.includes(f.toLowerCase())) ?? null
      const delim = text(delimiter ?? undefined)
      out.push({ path, delimiter: delim === null ? null : delim.slice(0, 1), flags: flagNames, specialUse })
    }
    return out
  }

  async status(folderArg: unknown) {
    const folder = this.folder(folderArg)
    const result = await this.client.run({
      verb: 'STATUS',
      args: [{ mailbox: folder }, { list: ['MESSAGES', 'UNSEEN', 'UIDNEXT', 'UIDVALIDITY'].map((atom) => ({ atom })) }],
    })
    const values: Record<string, number | null> = { MESSAGES: null, UNSEEN: null, UIDNEXT: null, UIDVALIDITY: null }
    for (const r of result.untagged) {
      if (r.kind !== 'data' || r.name !== 'STATUS') continue
      const items = r.values[1]
      if (!Array.isArray(items)) continue
      for (let i = 0; i + 1 < items.length; i += 2) {
        const key = items[i]
        if (key instanceof Atom && key.value.toUpperCase() in values) {
          try {
            values[key.value.toUpperCase()] = number(items[i + 1])
          } catch {}
        }
      }
    }
    return {
      folder,
      messages: values['MESSAGES'] ?? null,
      unseen: values['UNSEEN'] ?? null,
      uidNext: values['UIDNEXT'] ?? null,
      uidValidity: values['UIDVALIDITY'] ?? null,
    }
  }

  /** Opens a folder to look at: read-only unless this session already holds it open to write. */
  private async look(folder: string): Promise<number | null> {
    const opened = await this.client.open(folder, true)
    return codeNumber(opened.untagged, 'UIDVALIDITY') ?? this.uidValidity.get(folder) ?? null
  }

  private readonly uidValidity = new Map<string, number | null>()

  private async change(folder: string): Promise<void> {
    if (this.rule.purpose === 'read') throw new ImapError('not-allowed')
    const opened = await this.client.open(folder, false)
    const validity = codeNumber(opened.untagged, 'UIDVALIDITY')
    if (validity !== null) this.uidValidity.set(folder, validity)
  }

  async search(folderArg: unknown, criteriaArg: unknown, optionsArg: unknown) {
    const folder = this.folder(folderArg)
    const opts = options(optionsArg)
    const limit = bounded(opts['limit'], LIMITS.searchDefault, LIMITS.searchMax)
    const terms = searchTerms(criteriaArg)
    const utf8 = terms.some(needsUtf8)
    const uidValidity = await this.look(folder)
    const result = await this.client.run({
      verb: 'UID SEARCH',
      args: [...(utf8 ? [{ atom: 'CHARSET' }, { atom: 'UTF-8' }] : []), ...(terms.length === 0 ? [{ atom: 'ALL' }] : terms)],
    })
    const uids: number[] = []
    for (const r of result.untagged) {
      if (r.kind !== 'data' || r.name !== 'SEARCH') continue
      for (const v of r.values) {
        try {
          uids.push(number(v))
        } catch {}
        if (uids.length > 1_000_000) break
      }
    }
    const sorted = [...new Set(uids)].sort((a, b) => b - a)
    return { folder, uidValidity, total: sorted.length, uids: sorted.slice(0, limit) }
  }

  async fetch(folderArg: unknown, uidsArg: unknown): Promise<{ folder: string; messages: MessageSummary[] }> {
    const folder = this.folder(folderArg)
    const uids = uidList(uidsArg, LIMITS.fetchMax)
    await this.look(folder)
    const items = await fetchByUid(this.client, uids, ['UID', 'FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'])
    const messages: MessageSummary[] = []
    for (const uid of [...uids].sort((a, b) => b - a)) {
      const map = items.get(uid)
      const summary = map === undefined ? null : summaryOf(map)
      if (summary !== null) messages.push(summary)
    }
    return { folder, messages }
  }

  private async structure(uid: number): Promise<{ summary: MessageSummary; parts: Part[] } | null> {
    const items = await fetchByUid(this.client, [uid], [
      'UID',
      'FLAGS',
      'INTERNALDATE',
      'RFC822.SIZE',
      'ENVELOPE',
      'BODYSTRUCTURE',
    ])
    const map = items.get(uid)
    const summary = map === undefined ? null : summaryOf(map)
    if (map === undefined || summary === null) return null
    return { summary, parts: parseStructure(map.get('BODYSTRUCTURE')) }
  }

  /** A text part, decoded, at most `maxChars` characters, fetched with a byte cap to match. */
  private async partText(uid: number, part: Part, maxChars: number): Promise<{ text: string; truncated: boolean }> {
    // Encoded bytes needed for maxChars characters of UTF-8 in base64, with room for line breaks.
    const cap = Math.min(maxChars * 6 + 1024, 8 * 1024 * 1024)
    const items = await fetchByUid(this.client, [uid], ['UID', `BODY.PEEK[${part.part}]<0.${cap}>`])
    const map = items.get(uid)
    const bytes = map === undefined ? null : sectionBytes(map, part.part)
    if (bytes === null) return { text: '', truncated: false }
    const decoded = cleanBody(decodeCharset(decodeTransfer(bytes, part.encoding), part.charset))
    const cut = truncate(decoded, maxChars)
    return { text: cut.text, truncated: cut.truncated || bytes.length >= cap }
  }

  async message(folderArg: unknown, uidArg: unknown, optionsArg: unknown): Promise<MessageBody> {
    const folder = this.folder(folderArg)
    const [uid] = uidList([uidArg], 1) as [number]
    const opts = options(optionsArg)
    const maxChars = bounded(opts['maxTextChars'], LIMITS.textCharsDefault, LIMITS.textCharsMax)
    await this.look(folder)
    const found = await this.structure(uid)
    if (found === null) throw new ImapError('no', 'NONEXISTENT')
    const { plain, html } = bodyParts(found.parts)
    const plainText = plain === null ? null : await this.partText(uid, plain, maxChars)
    const htmlText = html === null ? null : await this.partText(uid, html, maxChars)
    const bodies = new Set([plain?.part, html?.part])
    return {
      ...found.summary,
      text: plainText?.text ?? null,
      html: htmlText?.text ?? null,
      attachments: found.parts
        .filter((p) => !bodies.has(p.part))
        .map((p) => ({ part: p.part, type: p.type, filename: p.filename, size: p.size })),
      truncated: (plainText?.truncated ?? false) || (htmlText?.truncated ?? false),
    }
  }

  async attachment(folderArg: unknown, uidArg: unknown, partArg: unknown, optionsArg: unknown) {
    const folder = this.folder(folderArg)
    const [uid] = uidList([uidArg], 1) as [number]
    if (typeof partArg !== 'string' || !/^[1-9]\d{0,3}(\.[1-9]\d{0,3}){0,9}$/.test(partArg)) throw invalid()
    const opts = options(optionsArg)
    const maxBytes = bounded(opts['maxBytes'], LIMITS.attachmentBytesDefault, LIMITS.attachmentBytesMax)
    await this.look(folder)
    const found = await this.structure(uid)
    const part = found?.parts.find((p) => p.part === partArg)
    if (found === null || part === undefined) throw new ImapError('no', 'NONEXISTENT')
    const cap = Math.ceil((maxBytes * 4) / 3) + Math.ceil(maxBytes / 38) + 1024
    const items = await fetchByUid(this.client, [uid], ['UID', `BODY.PEEK[${part.part}]<0.${cap}>`])
    const bytes = sectionBytes(items.get(uid) ?? new Map(), part.part) ?? Buffer.alloc(0)
    const decoded = decodeTransfer(bytes, part.encoding)
    const kept = decoded.subarray(0, maxBytes)
    return {
      part: part.part,
      type: part.type,
      filename: part.filename,
      size: part.size,
      base64: kept.toString('base64'),
      truncated: decoded.length > maxBytes || bytes.length >= cap,
    }
  }

  async setFlags(folderArg: unknown, uidsArg: unknown, changeArg: unknown) {
    const folder = this.folder(folderArg)
    const uids = uidList(uidsArg, LIMITS.storeMax)
    const change = options(changeArg)
    const add = flagList(change['add'])
    const remove = flagList(change['remove'])
    if (add.length === 0 && remove.length === 0) throw invalid()
    await this.change(folder)
    for (const [sign, flags] of [
      ['+', add],
      ['-', remove],
    ] as const) {
      if (flags.length === 0) continue
      await this.client.run({
        verb: 'UID STORE',
        args: [{ uids }, { atom: `${sign}FLAGS.SILENT` }, { list: flags.map((atom) => ({ atom })) }],
      })
    }
    return { folder, uids: uids.length }
  }

  private async transfer(verb: 'UID COPY' | 'UID MOVE', folderArg: unknown, uidsArg: unknown, toArg: unknown) {
    const folder = this.folder(folderArg)
    const uids = uidList(uidsArg, LIMITS.storeMax)
    const to = this.folder(toArg)
    if (verb === 'UID MOVE' && !this.client.has('MOVE')) throw new ImapError('unsupported')
    await this.change(folder)
    await this.client.run({ verb, args: [{ uids }, { mailbox: to }] })
    return { folder, to, uids: uids.length }
  }

  async append(folderArg: unknown, messageArg: unknown, optionsArg: unknown) {
    const folder = this.folder(folderArg)
    if (this.rule.purpose === 'read') throw new ImapError('not-allowed')
    if (typeof messageArg !== 'string' || messageArg.length === 0) throw invalid()
    const bytes = Buffer.from(messageArg.replace(/\r?\n/g, '\r\n'), 'utf8')
    if (bytes.length > LIMITS.appendBytesMax || bytes.includes(0)) throw invalid()
    // A message starts with its headers: `Name: value`.
    if (!/^[!-9;-~]{1,76}:/.test(messageArg)) throw invalid()
    const opts = options(optionsArg)
    const flags = flagList(opts['flags'])
    await this.client.run({
      verb: 'APPEND',
      args: [{ mailbox: folder }, { list: flags.map((atom) => ({ atom })) }, { string: bytes }],
    })
    return { folder, bytes: bytes.length }
  }

  async createFolder(folderArg: unknown) {
    const folder = this.folder(folderArg)
    if (folder === 'INBOX') throw invalid()
    await this.client.run({ verb: 'CREATE', args: [{ mailbox: folder }] })
    return { folder }
  }

  async expunge(folderArg: unknown, uidsArg: unknown) {
    const folder = this.folder(folderArg)
    const uids = uidList(uidsArg, LIMITS.storeMax)
    // Only UID EXPUNGE, which removes just these messages; plain EXPUNGE would remove whatever any
    // client marked \Deleted.
    if (!this.client.has('UIDPLUS')) throw new ImapError('unsupported')
    await this.change(folder)
    const result = await this.client.run({ verb: 'UID EXPUNGE', args: [{ uids }] })
    const removed = result.untagged.filter((r) => r.kind === 'data' && (r.name === 'EXPUNGE' || r.name === 'VANISHED')).length
    return { folder, removed }
  }

  async deleteFolder(folderArg: unknown) {
    const folder = this.folder(folderArg)
    if (folder === 'INBOX') throw invalid()
    if (this.client.selected?.folder === folder) await this.client.run({ verb: 'UNSELECT', args: [] }).catch(() => undefined)
    await this.client.run({ verb: 'DELETE', args: [{ mailbox: folder }] })
    return { folder }
  }
}

// --- Search criteria ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-11-17` as IMAP's `17-Nov-2026`. */
export function imapDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid()
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw invalid()
  return `${d}-${MONTHS[m - 1]}-${y}`
}

const TEXT_KEYS = { from: 'FROM', to: 'TO', cc: 'CC', subject: 'SUBJECT', body: 'BODY', text: 'TEXT' } as const
const DATE_KEYS = { since: 'SINCE', before: 'BEFORE', on: 'ON', sentSince: 'SENTSINCE', sentBefore: 'SENTBEFORE' } as const
const FLAG_KEYS = {
  seen: ['SEEN', 'UNSEEN'],
  flagged: ['FLAGGED', 'UNFLAGGED'],
  answered: ['ANSWERED', 'UNANSWERED'],
  draft: ['DRAFT', 'UNDRAFT'],
  deleted: ['DELETED', 'UNDELETED'],
} as const
const SIZE_KEYS = { larger: 'LARGER', smaller: 'SMALLER' } as const

function needsUtf8(arg: Arg): boolean {
  if ('string' in arg) return typeof arg.string === 'string' && /[^\x20-\x7e]/.test(arg.string)
  if ('list' in arg) return arg.list.some(needsUtf8)
  return false
}

/**
 * Structured search criteria as IMAP search keys. Only the keys listed here, each with a checked
 * value; `or` takes two criteria and `not` one, nested at most three deep.
 */
export function searchTerms(value: unknown, depth = 0, count = { n: 0 }): Arg[] {
  if ((value === undefined || value === null) && depth === 0) return []
  if (depth > LIMITS.criteriaDepth) throw invalid()
  const criteria = options(value)
  const out: Arg[] = []
  const term = (...args: Arg[]) => {
    if (++count.n > LIMITS.criteriaTerms) throw invalid()
    out.push(...args)
  }
  for (const [key, v] of Object.entries(criteria)) {
    if (v === undefined) continue
    if (Object.hasOwn(TEXT_KEYS, key)) {
      if (typeof v !== 'string' || v.length === 0 || v.length > LIMITS.searchTextChars || /[\r\n\0]/.test(v)) throw invalid()
      term({ atom: TEXT_KEYS[key as keyof typeof TEXT_KEYS] }, { string: v })
    } else if (Object.hasOwn(DATE_KEYS, key)) {
      term({ atom: DATE_KEYS[key as keyof typeof DATE_KEYS] }, { atom: imapDate(v) })
    } else if (Object.hasOwn(FLAG_KEYS, key)) {
      if (typeof v !== 'boolean') throw invalid()
      const [yes, no] = FLAG_KEYS[key as keyof typeof FLAG_KEYS]
      term({ atom: v ? yes : no })
    } else if (Object.hasOwn(SIZE_KEYS, key)) {
      if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 2 ** 31) throw invalid()
      term({ atom: SIZE_KEYS[key as keyof typeof SIZE_KEYS] }, { number: v as number })
    } else if (key === 'uids') {
      term({ atom: 'UID' }, { uids: uidList(v, 10_000) })
    } else if (key === 'header') {
      const h = options(v)
      const name = h['name']
      const hv = h['value']
      if (typeof name !== 'string' || !/^[A-Za-z0-9-]{1,60}$/.test(name)) throw invalid()
      if (typeof hv !== 'string' || hv.length > LIMITS.searchTextChars || /[\r\n\0]/.test(hv)) throw invalid()
      term({ atom: 'HEADER' }, { string: name }, { string: hv })
    } else if (key === 'not') {
      const inner = searchTerms(v, depth + 1, count)
      if (inner.length === 0) throw invalid()
      term({ atom: 'NOT' }, { list: inner })
    } else if (key === 'or') {
      if (!Array.isArray(v) || v.length !== 2) throw invalid()
      const a = searchTerms(v[0], depth + 1, count)
      const b = searchTerms(v[1], depth + 1, count)
      if (a.length === 0 || b.length === 0) throw invalid()
      term({ atom: 'OR' }, { list: a }, { list: b })
    } else throw invalid()
  }
  return out
}
