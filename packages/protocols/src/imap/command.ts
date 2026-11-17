// Writing IMAP commands, and the check every command passes before it is written.
//
// Commands are built only from structured arguments: an atom is checked against a strict
// character set, a string is quoted or sent as a literal, never pasted in, so no argument can end
// a command early or start another one. Then checkCommand holds the whole command to the session's
// purpose (policy.ts). It runs on the wire, under every caller, so it holds whatever the layers
// above it do.

import {
  checkFetchItem,
  IMAP_PURPOSE_RANK as PURPOSE_RANK,
  type ImapPurpose as Purpose,
  VERB_PURPOSE,
} from '@valet/core/imap-policy'

export type Arg =
  | { readonly atom: string }
  | { readonly number: number }
  /** Sent quoted when it can be, as a literal otherwise. */
  | { readonly string: string | Buffer }
  /** A mailbox name, in modified UTF-7 (RFC 3501 5.1.3). */
  | { readonly mailbox: string }
  /** A UID set, written compactly as ranges. */
  | { readonly uids: readonly number[] }
  | { readonly list: readonly Arg[] }

export interface Command {
  /** The command word, or two for UID commands: `UID FETCH`. */
  readonly verb: string
  readonly args: readonly Arg[]
}

/** A piece of an encoded command: text to write, or a literal's bytes, sent after the server's `+`. */
export type Segment = { readonly text: Buffer } | { readonly literal: Buffer }

/** The command can't be written, or isn't allowed for this session's purpose. */
export class CommandRefused extends Error {
  constructor(readonly reason: 'invalid' | 'not-allowed' | 'needs-irreversible') {
    super(`imap command refused: ${reason}`)
  }
}

const ATOM = /^[A-Za-z0-9\\.$+_-]{1,64}$|^\*$/
/** A fetch item: `BODY.PEEK[1.2.MIME]<0.4096>` and the like. Checked again by checkFetchItem. */
const FETCH_ITEM = /^[A-Z0-9.]{1,20}(\[[A-Z0-9. ()-]{0,200}\](<\d{1,10}(\.\d{1,10})?>)?)?$/
const MAX_UIDS = 10_000
export const MAX_QUOTED = 1000

export interface SessionState {
  /** The purpose the session was started for: the tool's declared side effect. */
  readonly purpose: Purpose
  /** The folder open now, and whether it was opened read-only (EXAMINE). */
  readonly selected: { readonly folder: string; readonly readOnly: boolean } | null
}

/**
 * Throws CommandRefused unless the session's purpose allows `command`. A read session may only
 * look: EXAMINE, never SELECT, and fetches only with BODY.PEEK, so nothing it does marks mail as
 * read. Setting \Deleted is irreversible, like EXPUNGE, because any other client may expunge it.
 */
export function checkCommand(command: Command, state: SessionState): void {
  const needed = VERB_PURPOSE[command.verb]
  if (needed === undefined) throw new CommandRefused('not-allowed')
  if (PURPOSE_RANK[needed] > PURPOSE_RANK[state.purpose])
    throw new CommandRefused(needed === 'irreversible' ? 'needs-irreversible' : 'not-allowed')
  switch (command.verb) {
    case 'UID FETCH': {
      const items = command.args[1]
      if (items === undefined || !('list' in items)) throw new CommandRefused('invalid')
      for (const item of items.list) {
        if (!('atom' in item) || !checkFetchItem(item.atom)) throw new CommandRefused('not-allowed')
      }
      break
    }
    case 'UID STORE':
    case 'APPEND': {
      if (state.selected?.readOnly === true && command.verb === 'UID STORE')
        throw new CommandRefused('not-allowed')
      const flags = command.args.find((a) => 'list' in a)
      const named = flags !== undefined && 'list' in flags ? flags.list : []
      const deleted = named.some((f) => 'atom' in f && f.atom.toLowerCase() === '\\deleted')
      if (deleted && state.purpose !== 'irreversible') throw new CommandRefused('needs-irreversible')
      break
    }
    case 'UID COPY':
    case 'UID MOVE':
    case 'UID EXPUNGE':
      if (state.selected === null || state.selected.readOnly) throw new CommandRefused('not-allowed')
      break
    default:
      break
  }
}

/** Encodes `tag command` as segments to write in order. Throws CommandRefused('invalid'). */
export function encodeCommand(tag: string, command: Command, literalPlus: boolean): Segment[] {
  if (!/^[A-Z]{1,4}\d{1,8}$/.test(tag)) throw new CommandRefused('invalid')
  const out = new Writer(literalPlus)
  out.text(`${tag} ${command.verb}`)
  for (const arg of command.args) {
    out.text(' ')
    out.arg(arg, command.verb === 'UID FETCH')
  }
  out.text('\r\n')
  return out.done()
}

class Writer {
  private readonly segments: Segment[] = []
  private pending = ''

  constructor(private readonly literalPlus: boolean) {}

  text(value: string): void {
    this.pending += value
  }

  arg(arg: Arg, fetchItems: boolean): void {
    if ('atom' in arg) {
      if (!(fetchItems ? FETCH_ITEM.test(arg.atom) : ATOM.test(arg.atom))) throw new CommandRefused('invalid')
      this.text(arg.atom)
    } else if ('number' in arg) {
      if (!Number.isSafeInteger(arg.number) || arg.number < 0) throw new CommandRefused('invalid')
      this.text(String(arg.number))
    } else if ('uids' in arg) {
      this.text(uidSet(arg.uids))
    } else if ('list' in arg) {
      this.text('(')
      arg.list.forEach((item, i) => {
        if (i > 0) this.text(' ')
        this.arg(item, fetchItems)
      })
      this.text(')')
    } else if ('mailbox' in arg) {
      this.string(Buffer.from(encodeMailbox(arg.mailbox), 'latin1'))
    } else {
      this.string(typeof arg.string === 'string' ? Buffer.from(arg.string, 'utf8') : arg.string)
    }
  }

  private string(bytes: Buffer): void {
    if (bytes.length <= MAX_QUOTED && bytes.every((b) => b >= 0x20 && b < 0x7f)) {
      this.text(`"${bytes.toString('latin1').replace(/[\\"]/g, (c) => `\\${c}`)}"`)
      return
    }
    this.text(`{${bytes.length}${this.literalPlus ? '+' : ''}}\r\n`)
    if (this.literalPlus) {
      this.flush()
      this.segments.push({ text: Buffer.from(bytes) })
    } else {
      this.flush()
      this.segments.push({ literal: Buffer.from(bytes) })
    }
  }

  private flush(): void {
    if (this.pending !== '') this.segments.push({ text: Buffer.from(this.pending, 'latin1') })
    this.pending = ''
  }

  done(): Segment[] {
    this.flush()
    return this.segments
  }
}

/** A UID set: sorted, deduplicated, written as ranges (`1:3,7`). Throws on an empty or bad set. */
export function uidSet(uids: readonly number[]): string {
  if (uids.length === 0 || uids.length > MAX_UIDS) throw new CommandRefused('invalid')
  for (const uid of uids) {
    if (!Number.isSafeInteger(uid) || uid < 1 || uid > 0xffffffff) throw new CommandRefused('invalid')
  }
  const sorted = [...new Set(uids)].sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0] as number
  let prev = start
  for (const uid of [...sorted.slice(1), Number.NaN]) {
    if (uid === prev + 1) {
      prev = uid
      continue
    }
    parts.push(start === prev ? String(start) : `${start}:${prev}`)
    start = uid
    prev = uid
  }
  return parts.join(',')
}

/** RFC 3501's modified UTF-7 for mailbox names: `&` is `&-`, other non-ASCII is base64 of UTF-16. */
export function encodeMailbox(name: string): string {
  let out = ''
  let run = ''
  const flush = () => {
    if (run === '') return
    const utf16 = Buffer.alloc(run.length * 2)
    for (let i = 0; i < run.length; i++) utf16.writeUInt16BE(run.charCodeAt(i), i * 2)
    out += `&${utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`
    run = ''
  }
  for (const ch of name) {
    const code = ch.codePointAt(0) as number
    if (code >= 0x20 && code <= 0x7e) {
      flush()
      out += ch === '&' ? '&-' : ch
    } else run += ch
  }
  flush()
  return out
}

/** The reverse of encodeMailbox. A malformed name is returned as the server wrote it. */
export function decodeMailbox(name: string): string {
  return name.replace(/&([A-Za-z0-9+,]*)-/g, (whole, b64: string) => {
    if (b64 === '') return '&'
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64')
    if (bytes.length % 2 !== 0) return whole
    let out = ''
    for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i))
    // A shift may only hold what has no plain form: never ASCII (control characters included),
    // and never a broken surrogate pair. Anything else stays as the server wrote it.
    if (out.length === 0 || [...out].some((c) => c.charCodeAt(0) < 0x80) || !out.isWellFormed()) return whole
    return out
  })
}
