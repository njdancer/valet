// A fake IMAP server on loopback, over TLS with a test certificate (see README.md). It keeps its
// mailboxes in memory, records every command it receives, and can be told to answer a command with
// anything at all, for the red team's hostile-server cases. Plain Node; no real mail is involved.

import { randomInt } from 'node:crypto'
import { type AddressInfo, createServer as createTcpServer, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer, type TLSSocket } from 'node:tls'
import { generateTestCertificate } from '@valet/fake-woolworths-site'
import { bodyStructure, envelope, header, type MimeNode, parseMime, sectionNode } from './mime'

export { parseMime } from './mime'

export interface FakeMessage {
  uid: number
  flags: Set<string>
  /** When it arrived. */
  internalDate: Date
  readonly raw: Buffer
  readonly mime: MimeNode
}

export interface FakeMailbox {
  readonly uidValidity: number
  uidNext: number
  messages: FakeMessage[]
  readonly specialUse: string | null
}

export interface SeenCommand {
  readonly tag: string
  /** Upper case: `UID FETCH`, `LOGIN`. */
  readonly verb: string
  /** The whole command, a literal's bytes shown as `{n}`. */
  readonly line: string
  /** The TLS session it came on, numbered from 1. */
  readonly connection: number
}

export interface FakeUser {
  readonly username: string
  readonly password: string
}

export interface MessageInput {
  readonly raw: string | Buffer
  readonly flags?: readonly string[]
  readonly internalDate?: Date
}

export interface HostileContext {
  readonly command: SeenCommand
  readonly authenticated: boolean
  readonly selected: string | null
}

export interface FakeImapOptions {
  /** Names the certificate covers. Default imap.mail.me.com and imap.example.test. */
  readonly hosts?: readonly string[]
  readonly users?: readonly FakeUser[]
  /** Mailboxes and their messages. INBOX always exists. */
  readonly mailboxes?: Readonly<Record<string, readonly MessageInput[]>>
  /** Special-use flags by mailbox (`Sent Messages`: `\Sent`). */
  readonly specialUse?: Readonly<Record<string, string>>
  /** Capabilities before and after login. Defaults look like iCloud's, with UIDPLUS and MOVE. */
  readonly capabilities?: { readonly before?: readonly string[]; readonly after?: readonly string[] }
  /** The greeting line, without CRLF. Default `* OK [CAPABILITY ...] Fake iCloud IMAP ready`. */
  readonly greeting?: string
  /**
   * Answers a command instead of the server, with raw bytes (CRLFs and tag included), or null to
   * let it answer. For hostile-server tests.
   */
  readonly hostile?: (context: HostileContext) => string | Buffer | null
  /** Serve plain TCP instead of TLS. */
  readonly plain?: boolean
}

export interface FakeImap {
  readonly port: number
  /** PEM of the certificate it serves, or null over plain TCP. */
  readonly cert: string | null
  readonly commands: SeenCommand[]
  /** The SNI each TLS connection asked for. */
  readonly servernames: (string | null)[]
  readonly logins: { readonly username: string; readonly ok: boolean }[]
  readonly mailboxes: Map<string, FakeMailbox>
  /** Delivers a message to a mailbox now, as the next UID. */
  deliver(mailbox: string, message: MessageInput): FakeMessage
  /** Connections open now. */
  readonly open: () => number
  close(): Promise<void>
}

export const DEFAULT_USER: FakeUser = { username: 'nick@icloud.test', password: 'abcd-efgh-ijkl-mnop' }

const BEFORE = [
  'IMAP4rev1',
  'SASL-IR',
  'AUTH=PLAIN',
  'AUTH=ATOKEN',
  'XAPPLEPUSHSERVICE',
  'ID',
  'UIDPLUS',
  'LITERAL+',
]
const AFTER = [
  'IMAP4rev1',
  'SASL-IR',
  'XAPPLEPUSHSERVICE',
  'ID',
  'UIDPLUS',
  'LITERAL+',
  'MOVE',
  'UNSELECT',
  'CHILDREN',
  'SPECIAL-USE',
  'QUOTA',
  'NAMESPACE',
  'ENABLE',
  'IDLE',
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function imapDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `"${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000"`
}

function parseDate(value: string): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value)
  if (m === null) return null
  const month = MONTHS.findIndex((x) => x.toLowerCase() === (m[2] as string).toLowerCase())
  return month === -1 ? null : new Date(Date.UTC(Number(m[3]), month, Number(m[1])))
}

function toMessage(uid: number, input: MessageInput): FakeMessage {
  const raw = Buffer.isBuffer(input.raw)
    ? input.raw
    : Buffer.from(input.raw.replace(/\r?\n/g, '\r\n'), 'utf8')
  return {
    uid,
    flags: new Set(input.flags ?? []),
    internalDate: input.internalDate ?? new Date(),
    raw,
    mime: parseMime(raw),
  }
}

// --- Command tokens ------------------------------------------------------------------------------

type Token = string | { readonly literal: Buffer } | Token[]

/** Parses a command's arguments: atoms, quoted strings, literals (already inlined) and lists. */
function tokenize(input: Buffer): Token[] {
  let i = 0
  const parseList = (close: number | null): Token[] => {
    const out: Token[] = []
    for (;;) {
      while (input[i] === 0x20) i++
      if (i >= input.length) return out
      const b = input[i] as number
      if (b === close) {
        i++
        return out
      }
      if (b === 0x28) {
        i++
        out.push(parseList(0x29))
      } else if (b === 0x22) {
        i++
        let s = ''
        while (i < input.length && input[i] !== 0x22) {
          if (input[i] === 0x5c) i++
          s += String.fromCharCode(input[i] as number)
          i++
        }
        i++
        out.push({ literal: Buffer.from(s, 'latin1') })
      } else if (b === 0x7b) {
        const end = input.indexOf(0x7d, i)
        const size = Number(input.toString('latin1', i + 1, end).replace('+', ''))
        i = end + 3
        out.push({ literal: Buffer.from(input.subarray(i, i + size)) })
        i += size
      } else {
        const start = i
        let depth = 0
        while (i < input.length) {
          const c = input[i] as number
          if (c === 0x5b) depth++
          if (c === 0x5d) depth--
          if (depth === 0 && (c === 0x20 || c === 0x28 || c === 0x29)) break
          i++
        }
        out.push(input.toString('latin1', start, i))
      }
    }
  }
  return parseList(null)
}

function str(token: Token | undefined): string {
  if (token === undefined) return ''
  if (typeof token === 'string') return token
  if (Array.isArray(token)) return ''
  return token.literal.toString('utf8')
}

function decodeMailbox(name: string): string {
  return name.replace(/&([A-Za-z0-9+,]*)-/g, (_w, b64: string) => {
    if (b64 === '') return '&'
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64')
    let out = ''
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i))
    return out
  })
}

function encodeMailbox(name: string): string {
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

function uidMatches(set: string, uid: number, max: number): boolean {
  return set.split(',').some((range) => {
    const [a = '', b] = range.split(':')
    const lo = a === '*' ? max : Number(a)
    const hi = b === undefined ? lo : b === '*' ? max : Number(b)
    return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi)
  })
}

// --- Search --------------------------------------------------------------------------------------

function textOf(m: FakeMessage, name: string): string {
  return (header(m.mime.headers, name) ?? '').toLowerCase()
}

function evaluate(tokens: Token[], m: FakeMessage, max: number): boolean {
  let i = 0
  const one = (): boolean => {
    const t = tokens[i++]
    if (Array.isArray(t)) return evaluate(t, m, max)
    const key = str(t).toUpperCase()
    const arg = () => str(tokens[i++]).toLowerCase()
    switch (key) {
      case 'ALL':
        return true
      case 'UID':
        return uidMatches(str(tokens[i++]), m.uid, max)
      case 'FROM':
      case 'TO':
      case 'CC':
      case 'SUBJECT':
        return textOf(m, key.toLowerCase()).includes(arg())
      case 'BODY':
        return m.mime.body.toString('utf8').toLowerCase().includes(arg())
      case 'TEXT':
        return m.raw.toString('utf8').toLowerCase().includes(arg())
      case 'HEADER': {
        const name = arg()
        const value = arg()
        return textOf(m, name).includes(value)
      }
      case 'SINCE':
      case 'SENTSINCE':
        return m.internalDate >= (parseDate(str(tokens[i++])) ?? new Date(0))
      case 'BEFORE':
      case 'SENTBEFORE':
        return m.internalDate < (parseDate(str(tokens[i++])) ?? new Date(0))
      case 'ON': {
        const d = parseDate(str(tokens[i++]))
        return d !== null && m.internalDate.toISOString().slice(0, 10) === d.toISOString().slice(0, 10)
      }
      case 'LARGER':
        return m.raw.length > Number(str(tokens[i++]))
      case 'SMALLER':
        return m.raw.length < Number(str(tokens[i++]))
      case 'NOT':
        return !one()
      case 'OR': {
        const a = one()
        const b = one()
        return a || b
      }
      default: {
        const flag = /^(UN)?(SEEN|FLAGGED|ANSWERED|DRAFT|DELETED)$/.exec(key)
        if (flag !== null) {
          const has = [...m.flags].some((f) => f.toUpperCase() === `\\${flag[2]}`)
          return flag[1] === undefined ? has : !has
        }
        throw new Error(`search key ${key}`)
      }
    }
  }
  let all = true
  while (i < tokens.length) all = one() && all
  return all
}

// --- The server ----------------------------------------------------------------------------------

export async function startFakeImap(options: FakeImapOptions = {}): Promise<FakeImap> {
  const users = options.users ?? [DEFAULT_USER]
  const before = options.capabilities?.before ?? BEFORE
  const after = options.capabilities?.after ?? AFTER
  const mailboxes = new Map<string, FakeMailbox>()
  const commands: SeenCommand[] = []
  const servernames: (string | null)[] = []
  const logins: { username: string; ok: boolean }[] = []
  const sockets = new Set<Socket>()
  let connections = 0

  const mailbox = (name: string, specialUse: string | null = null): FakeMailbox => {
    const existing = mailboxes.get(name)
    if (existing !== undefined) return existing
    const created: FakeMailbox = { uidValidity: randomInt(1, 2 ** 31), uidNext: 1, messages: [], specialUse }
    mailboxes.set(name, created)
    return created
  }
  mailbox('INBOX')
  for (const [name, messages] of Object.entries(options.mailboxes ?? {})) {
    const box = mailbox(name, options.specialUse?.[name] ?? null)
    for (const input of messages) box.messages.push(toMessage(box.uidNext++, input))
  }
  for (const [name, use] of Object.entries(options.specialUse ?? {})) mailbox(name, use)

  const deliver = (name: string, input: MessageInput): FakeMessage => {
    const box = mailbox(name)
    const message = toMessage(box.uidNext++, input)
    box.messages.push(message)
    return message
  }

  const serve = (socket: Socket, connection: number) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let authenticated = false
    let selected: { name: string; readOnly: boolean } | null = null
    /** The line end a `+` was sent for, so a sync literal is answered once. */
    let plusSentFor = -1
    const write = (text: string | Buffer) => {
      if (!socket.destroyed) socket.write(text)
    }
    write(`${options.greeting ?? `* OK [CAPABILITY ${before.join(' ')}] Fake iCloud IMAP ready`}\r\n`)

    /** Pulls one whole command (literals inlined) off the buffer, sending `+` for sync literals. */
    const nextCommand = (): Buffer | null => {
      let scan = 0
      for (;;) {
        const lf = buffer.indexOf(0x0a, scan)
        if (lf === -1) return null
        const line = buffer.toString('latin1', scan, lf - 1)
        const literal = /\{(\d+)(\+?)\}$/.exec(line)
        if (literal === null) {
          const command = buffer.subarray(0, lf - 1)
          buffer = buffer.subarray(lf + 1)
          return command
        }
        const size = Number(literal[1])
        if (buffer.length < lf + 1 + size) {
          if (literal[2] === '' && plusSentFor !== lf) {
            plusSentFor = lf
            write('+ go ahead\r\n')
          }
          return null
        }
        plusSentFor = -1
        scan = lf + 1 + size
      }
    }

    const handle = (bytes: Buffer) => {
      const space = bytes.indexOf(0x20)
      const tag = bytes.toString('latin1', 0, space === -1 ? bytes.length : space)
      const tokens = tokenize(bytes.subarray(space + 1))
      let verb = str(tokens.shift()).toUpperCase()
      if (verb === 'UID') verb = `UID ${str(tokens.shift()).toUpperCase()}`
      const line = bytes
        .toString('latin1')
        .replace(/\{(\d+)\+?\}\r\n[\s\S]*$/, (m) => m.slice(0, m.indexOf('}') + 1))
      const seen: SeenCommand = { tag, verb, line, connection }
      commands.push(seen)
      const hostile = options.hostile?.({ command: seen, authenticated, selected: selected?.name ?? null })
      if (hostile !== null && hostile !== undefined) return write(hostile)
      const ok = (text = `${verb} completed`) => write(`${tag} OK ${text}\r\n`)
      const no = (text: string) => write(`${tag} NO ${text}\r\n`)
      const bad = (text: string) => write(`${tag} BAD ${text}\r\n`)
      const box = () => (selected === null ? null : (mailboxes.get(selected.name) ?? null))

      if (verb === 'CAPABILITY') {
        write(`* CAPABILITY ${(authenticated ? after : before).join(' ')}\r\n`)
        return ok()
      }
      if (verb === 'NOOP') return ok()
      if (verb === 'LOGOUT') {
        write('* BYE Fake iCloud IMAP closing\r\n')
        ok()
        socket.end()
        return
      }
      if (verb === 'LOGIN') {
        const username = str(tokens[0])
        const password = str(tokens[1])
        const match = users.some((u) => u.username === username && u.password === password)
        logins.push({ username, ok: match })
        if (!match) return no('[AUTHENTICATIONFAILED] Authentication failed')
        authenticated = true
        return ok(`[CAPABILITY ${after.join(' ')}] LOGIN completed`)
      }
      if (!authenticated) return bad('Not authenticated')
      switch (verb) {
        case 'LIST': {
          for (const [name, b] of mailboxes) {
            const flags = ['\\HasNoChildren', ...(b.specialUse === null ? [] : [b.specialUse])]
            write(`* LIST (${flags.join(' ')}) "/" "${encodeMailbox(name)}"\r\n`)
          }
          return ok()
        }
        case 'STATUS': {
          const name = decodeMailbox(str(tokens[0]))
          const b = mailboxes.get(name)
          if (b === undefined) return no('[NONEXISTENT] No such mailbox')
          const unseen = b.messages.filter((m) => !m.flags.has('\\Seen')).length
          write(
            `* STATUS "${encodeMailbox(name)}" (MESSAGES ${b.messages.length} UNSEEN ${unseen} UIDNEXT ${b.uidNext} UIDVALIDITY ${b.uidValidity})\r\n`,
          )
          return ok()
        }
        case 'SELECT':
        case 'EXAMINE': {
          const name = decodeMailbox(str(tokens[0]))
          const b = mailboxes.get(name === 'inbox' ? 'INBOX' : name)
          selected = null
          if (b === undefined) return no('[NONEXISTENT] No such mailbox')
          selected = { name: name.toUpperCase() === 'INBOX' ? 'INBOX' : name, readOnly: verb === 'EXAMINE' }
          write(`* ${b.messages.length} EXISTS\r\n* 0 RECENT\r\n`)
          write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n')
          write(
            `* OK [UIDVALIDITY ${b.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${b.uidNext}] Predicted next UID\r\n`,
          )
          return ok(`[${verb === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${verb} completed`)
        }
        case 'UNSELECT':
          selected = null
          return ok()
        case 'CLOSE': {
          const b = box()
          if (b !== null && selected?.readOnly === false)
            b.messages = b.messages.filter((m) => !m.flags.has('\\Deleted'))
          selected = null
          return ok()
        }
        case 'CREATE': {
          const name = decodeMailbox(str(tokens[0]))
          if (mailboxes.has(name)) return no('[ALREADYEXISTS] Mailbox exists')
          mailbox(name)
          return ok()
        }
        case 'DELETE': {
          const name = decodeMailbox(str(tokens[0]))
          if (!mailboxes.delete(name)) return no('[NONEXISTENT] No such mailbox')
          return ok()
        }
        case 'APPEND': {
          const name = decodeMailbox(str(tokens[0]))
          const b = mailboxes.get(name)
          if (b === undefined) return no('[TRYCREATE] No such mailbox')
          const flags = Array.isArray(tokens[1]) ? tokens[1].map(str) : []
          const last = tokens[tokens.length - 1]
          const raw =
            last !== undefined && typeof last === 'object' && !Array.isArray(last)
              ? last.literal
              : Buffer.alloc(0)
          const message = toMessage(b.uidNext++, { raw, flags })
          b.messages.push(message)
          return ok(`[APPENDUID ${b.uidValidity} ${message.uid}] APPEND completed`)
        }
      }
      const b = box()
      if (b === null || selected === null) return bad('No mailbox selected')
      const max = b.uidNext - 1
      switch (verb) {
        case 'UID SEARCH': {
          let rest = tokens
          if (str(rest[0]).toUpperCase() === 'CHARSET') rest = rest.slice(2)
          try {
            const uids = b.messages.filter((m) => evaluate(rest, m, max)).map((m) => m.uid)
            write(`* SEARCH${uids.map((u) => ` ${u}`).join('')}\r\n`)
          } catch (error) {
            return bad(String(error))
          }
          return ok()
        }
        case 'UID FETCH': {
          const set = str(tokens[0])
          const items = Array.isArray(tokens[1]) ? tokens[1].map(str) : [str(tokens[1])]
          for (const [index, m] of b.messages.entries()) {
            if (!uidMatches(set, m.uid, max)) continue
            const parts: string[] = [`UID ${m.uid}`]
            for (const item of items) {
              const upper = item.toUpperCase()
              if (upper === 'UID') continue
              if (upper === 'FLAGS') parts.push(`FLAGS (${[...m.flags].join(' ')})`)
              else if (upper === 'INTERNALDATE') parts.push(`INTERNALDATE ${imapDateTime(m.internalDate)}`)
              else if (upper === 'RFC822.SIZE') parts.push(`RFC822.SIZE ${m.raw.length}`)
              else if (upper === 'ENVELOPE') parts.push(`ENVELOPE ${envelope(m.mime)}`)
              else if (upper === 'BODYSTRUCTURE') parts.push(`BODYSTRUCTURE ${bodyStructure(m.mime)}`)
              else {
                const section = /^(BODY(?:\.PEEK)?|RFC822)(?:\[([^\]]*)\])?(?:<(\d+)\.(\d+)>)?$/.exec(upper)
                if (section === null) return bad(`Unknown fetch item ${item}`)
                const [, kind, spec = '', origin, length] = section
                let data: Buffer
                if (spec === '') data = m.raw
                else if (spec === 'HEADER') data = m.mime.headerBytes
                else if (spec === 'TEXT') data = m.mime.body
                else {
                  const [path, sub] = spec.split(/\.(?=MIME|HEADER|TEXT)/)
                  const node = sectionNode(m.mime, path as string)
                  data = node === null ? Buffer.alloc(0) : sub === 'MIME' ? node.headerBytes : node.body
                }
                if (origin !== undefined)
                  data = data.subarray(Number(origin), Number(origin) + Number(length))
                if (kind !== 'BODY.PEEK' && !selected.readOnly) m.flags.add('\\Seen')
                const name =
                  kind === 'RFC822' ? 'RFC822' : `BODY[${spec}]${origin === undefined ? '' : `<${origin}>`}`
                parts.push(`${name} {${data.length}}\r\n${data.toString('latin1')}`)
              }
            }
            write(Buffer.from(`* ${index + 1} FETCH (${parts.join(' ')})\r\n`, 'latin1'))
          }
          return ok()
        }
        case 'UID STORE': {
          if (selected.readOnly) return no('Mailbox is read-only')
          const set = str(tokens[0])
          const mode = str(tokens[1]).toUpperCase()
          const flags = Array.isArray(tokens[2]) ? tokens[2].map(str) : [str(tokens[2])]
          for (const m of b.messages) {
            if (!uidMatches(set, m.uid, max)) continue
            if (mode.startsWith('+')) for (const f of flags) m.flags.add(f)
            else if (mode.startsWith('-')) for (const f of flags) m.flags.delete(f)
            else m.flags = new Set(flags)
          }
          return ok()
        }
        case 'UID COPY':
        case 'UID MOVE': {
          const set = str(tokens[0])
          const target = mailboxes.get(decodeMailbox(str(tokens[1])))
          if (target === undefined) return no('[TRYCREATE] No such mailbox')
          if (verb === 'UID MOVE' && selected.readOnly) return no('Mailbox is read-only')
          const moving = b.messages.filter((m) => uidMatches(set, m.uid, max))
          for (const m of moving)
            target.messages.push({ ...m, uid: target.uidNext++, flags: new Set(m.flags) })
          if (verb === 'UID MOVE') {
            for (const m of moving) write(`* ${b.messages.indexOf(m) + 1} EXPUNGE\r\n`)
            b.messages = b.messages.filter((m) => !moving.includes(m))
          }
          return ok()
        }
        case 'UID EXPUNGE':
        case 'EXPUNGE': {
          if (selected.readOnly) return no('Mailbox is read-only')
          const set = verb === 'UID EXPUNGE' ? str(tokens[0]) : null
          const gone = b.messages.filter(
            (m) => m.flags.has('\\Deleted') && (set === null || uidMatches(set, m.uid, max)),
          )
          for (const m of gone) write(`* ${b.messages.indexOf(m) + 1} EXPUNGE\r\n`)
          b.messages = b.messages.filter((m) => !gone.includes(m))
          return ok()
        }
      }
      return bad(`Unknown command ${verb}`)
    }

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const command = nextCommand()
        if (command === null) return
        handle(command)
      }
    })
  }

  let cert: string | null = null
  let server: Server
  if (options.plain === true) {
    server = createTcpServer((socket) => serve(socket, ++connections))
  } else {
    const generated = await generateTestCertificate(
      options.hosts ?? ['imap.mail.me.com', 'imap.example.test'],
    )
    cert = generated.cert
    server = createTlsServer({ key: generated.key, cert: generated.cert }, (socket: TLSSocket) => {
      servernames.push((socket as TLSSocket & { servername?: string | false }).servername || null)
      serve(socket, ++connections)
    })
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    cert,
    commands,
    servernames,
    logins,
    mailboxes,
    deliver,
    open: () => sockets.size,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
