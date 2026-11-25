// Reads and searches the mail the Mac's Mail app already keeps (docs/mail.md), through MailFiles.
// Mail's Envelope Index is undocumented and gains columns between macOS releases, so the store
// reads only the columns it needs, checks they are there before the first question, and stops
// with `unsupported` rather than guess when they aren't. The message itself always comes from its
// .emlx file, never from the index.
//
// Only accounts the person allowed are ever read: every query names their mailboxes.

import { attachmentFolder, messageFolder, parseEmlx } from './emlx'
import { type MailFiles, MailFilesError, type MailRow, type MailValue } from './files'
import {
  type Address,
  type AttachmentPart,
  decodeCharset,
  htmlToText,
  type Link,
  normaliseText,
  parseMessage,
} from './mime'

export type MailStoreFailure =
  /** The helper isn't installed or running, or has no Full Disk Access, or Mail has no library. */
  | 'unavailable'
  /** Mail's index isn't laid out the way this version of Valet reads it. */
  | 'unsupported'
  /** No such message in an account the person allowed. */
  | 'not-found'

interface AccountName {
  readonly name: string | null
  readonly address: string | null
}

export class MailStoreError extends Error {
  constructor(readonly code: MailStoreFailure) {
    super(`mail: ${code}`)
    this.name = 'MailStoreError'
  }
}

export interface Mailbox {
  readonly id: number
  readonly name: string
  /** The folder path as Mail shows it, e.g. "INBOX" or "Archive/2025". */
  readonly path: string
  readonly unread: number | null
  readonly total: number | null
}

export interface MailAccount {
  /** Mail's id for the account (its folder name in the library), or "local" for On My Mac. */
  readonly id: string
  readonly name: string
  readonly address: string | null
  readonly mailboxes: readonly Mailbox[]
}

export interface MessageSummary {
  readonly id: number
  readonly accountId: string
  readonly mailbox: string
  readonly from: Address | null
  readonly subject: string
  /** ISO time Mail received it. */
  readonly date: string | null
  readonly unread: boolean
  readonly flagged: boolean
  /** Mail's own short preview, when it keeps one. */
  readonly preview: string | null
}

export interface MessageDetail extends MessageSummary {
  readonly to: readonly Address[]
  readonly cc: readonly Address[]
  readonly replyTo: readonly Address[]
  readonly messageId: string | null
  readonly inReplyTo: string | null
  readonly references: readonly string[]
  readonly body: string
  /** 'html' when `body` is the HTML part's markup (mail_read as: html); plain text otherwise. */
  readonly bodyFormat?: 'html'
  readonly bodyTruncated: boolean
  /** Where `body` starts in the whole text, and where the next chunk starts; null at the end. */
  readonly bodyOffset: number
  readonly nextOffset: number | null
  /** Web and mail links from the HTML part. */
  readonly links: readonly Link[]
  /** False when Mail hasn't downloaded the whole message, so parts of the body may be missing. */
  readonly downloaded: boolean
  readonly attachments: readonly {
    readonly name: string
    readonly contentType: string
    readonly size: number
  }[]
}

/** One attachment as text, a chunk at a time. */
export interface AttachmentText {
  /** 1-based, in the order mail_read lists the attachments. */
  readonly index: number
  readonly name: string
  readonly contentType: string
  readonly size: number
  /** Null when it can't be read as text; `reason` says why. */
  readonly text: string | null
  readonly offset: number
  readonly nextOffset: number | null
  readonly reason?: 'binary' | 'not-downloaded' | 'too-large' | 'unreadable'
}

/** One attachment's bytes, as attachmentData finds them. */
export interface AttachmentData {
  readonly index: number
  readonly name: string
  readonly contentType: string
  readonly size: number
  readonly charset: string | null
  readonly data: Buffer | null
  readonly reason?: 'not-downloaded' | 'too-large'
}

export interface SearchQuery {
  /** Words anywhere: subject, sender, Mail's preview, and the body as Spotlight finds it. */
  readonly text?: string
  readonly from?: string
  readonly to?: string
  readonly subject?: string
  readonly accountId?: string
  /** A mailbox id from accounts(). */
  readonly mailboxId?: number
  readonly since?: string
  readonly until?: string
  readonly unread?: boolean
  readonly flagged?: boolean
  readonly hasAttachment?: boolean
  readonly limit?: number
  readonly offset?: number
}

export interface SearchResult {
  readonly messages: readonly MessageSummary[]
  /** Pass as `offset` for the next page; null when there are no more. */
  readonly nextOffset: number | null
}

export const MAX_SEARCH_LIMIT = 50
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_BODY_CHARS = 100_000
export const DEFAULT_BODY_CHARS = 20_000
export const THREAD_BODY_CHARS = 4_000
export const MAX_THREAD_MESSAGES = 30

interface Schema {
  readonly messages: ReadonlySet<string>
  readonly addresses: ReadonlySet<string>
  readonly mailboxes: ReadonlySet<string>
  readonly recipients: ReadonlySet<string> | null
  readonly summaries: ReadonlySet<string> | null
  readonly attachments: ReadonlySet<string> | null
  /** Mail's dates count seconds from 1970 or, in some versions, from 2001. */
  readonly appleEpoch: boolean
}

interface MailboxRow {
  readonly id: number
  readonly url: string
  readonly accountId: string
  /** The mailbox's folder inside the library. */
  readonly folder: string
  readonly path: string
  readonly unread: number | null
  readonly total: number | null
}

const APPLE_EPOCH_SECONDS = 978_307_200

/** How much of a message's body stands in for Mail's own summary. */
export const PREVIEW_CHARS = 200
/** At most this much of Mail's files is read for previews in one search. */
const PREVIEW_BYTE_BUDGET = 8 * 1024 * 1024

/** The start of a body as one line, cut at a word near PREVIEW_CHARS; null when there's no text. */
export function previewOf(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  if (flat.length <= PREVIEW_CHARS) return flat
  const cut = flat.slice(0, PREVIEW_CHARS)
  const space = cut.lastIndexOf(' ')
  return `${(space > PREVIEW_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** `imap://ACCOUNT/INBOX/Sub` → account ACCOUNT, path INBOX/Sub, folder ACCOUNT/INBOX.mbox/Sub.mbox. */
export function parseMailboxUrl(
  url: string,
): { readonly accountId: string; readonly path: string; readonly folder: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)\/(.*)$/i.exec(url)
  if (m === null) return null
  const scheme = (m[1] ?? '').toLowerCase()
  const host = m[2] ?? ''
  const segments = (m[3] ?? '').split('/').filter((s) => s.length > 0)
  const decoded: string[] = []
  for (const segment of segments) {
    let part: string
    try {
      part = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (part === '.' || part === '..' || part.includes('/') || part.includes('\0')) return null
    decoded.push(part)
  }
  if (decoded.length === 0) return null
  const local = scheme === 'local' || host.length === 0
  if (!local && !/^[A-Za-z0-9-]{1,64}$/.test(host)) return null
  const accountId = local ? 'local' : host
  const base = local ? 'Mailboxes' : host
  return {
    accountId,
    path: decoded.join('/'),
    folder: [base, ...decoded.map((d) => `${d}.mbox`)].join('/'),
  }
}

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

function num(value: MailValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: MailValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

export interface MailStoreOptions {
  /** Mail's account ids (accounts()'s `id`) the person allowed agents to read. */
  readonly allowedAccounts: () => ReadonlySet<string>
  /**
   * A message's whole source through Mail, for an attachment Mail hasn't downloaded: Mail fetches
   * it from the server. Without it such attachments are 'not-downloaded'.
   */
  readonly fetchSource?: (message: {
    readonly messageId: string | null
    readonly accountId: string
    readonly mailbox: string
    readonly rowId: number
    readonly subject: string
    readonly sender: string | null
    readonly date: string | null
  }) => Promise<Buffer | null>
  /** A PDF's text (macOS's PDFKit in the app); without it PDFs are 'unreadable'. */
  readonly pdfText?: (bytes: Buffer) => Promise<string | null>
}

/** Types read as text as they are. */
const TEXT_TYPES =
  /^(text\/(?!html)|application\/(json|xml|ics|csv|x-csv|x-sh|javascript|x-yaml|yaml|ld\+json)$)/
const TEXT_NAMES = /\.(txt|csv|tsv|ics|vcs|vcf|json|xml|md|log|yaml|yml|ini|conf)$/i
const HTML_NAMES = /\.html?$/i
/** At most this much of an attachment is turned into text. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export class MailStore {
  #schema: Schema | null = null

  constructor(
    private readonly files: MailFiles,
    private readonly options: MailStoreOptions,
  ) {}

  /** Wraps the files' failures in the store's own. */
  async #guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof MailStoreError) throw error
      if (error instanceof MailFilesError) {
        if (error.code === 'invalid') throw new MailStoreError('unsupported')
        throw new MailStoreError('unavailable')
      }
      throw error
    }
  }

  async #columns(table: string): Promise<ReadonlySet<string> | null> {
    const rows = await this.files.query('envelope', `PRAGMA table_info(${table})`, [])
    if (rows.length === 0) return null
    return new Set(rows.map((r) => str(r['name']) ?? '').filter((n) => n.length > 0))
  }

  /** Checks the index has what the store reads. */
  async schema(): Promise<Schema> {
    if (this.#schema !== null) return this.#schema
    return this.#guard(async () => {
      const messages = await this.#columns('messages')
      const subjects = await this.#columns('subjects')
      const addresses = await this.#columns('addresses')
      const mailboxes = await this.#columns('mailboxes')
      const has = (set: ReadonlySet<string> | null, names: readonly string[]): boolean =>
        set !== null && names.every((n) => set.has(n))
      if (
        !has(messages, ['subject', 'sender', 'mailbox', 'date_received']) ||
        !has(subjects, ['subject']) ||
        !has(addresses, ['address']) ||
        !has(mailboxes, ['url'])
      ) {
        throw new MailStoreError('unsupported')
      }
      const recipients = await this.#columns('recipients')
      const summaries = await this.#columns('summaries')
      const attachments = await this.#columns('attachments')
      const latest = await this.files.query('envelope', 'SELECT max(date_received) AS d FROM messages', [])
      const d = num(latest[0]?.['d'])
      const schema: Schema = {
        messages: messages ?? new Set(),
        addresses: addresses ?? new Set(),
        mailboxes: mailboxes ?? new Set(),
        recipients: has(recipients, ['message', 'address']) ? recipients : null,
        summaries: has(summaries, ['summary']) ? summaries : null,
        attachments: has(attachments, ['message', 'name']) ? attachments : null,
        // Seconds since 1970 are past 1e9 for anything after 2001; since 2001, not until 2032.
        appleEpoch: d !== null && d > 0 && d < 1_000_000_000,
      }
      this.#schema = schema
      return schema
    })
  }

  #toIso(seconds: number | null, schema: Schema): string | null {
    if (seconds === null || seconds <= 0) return null
    const unix = schema.appleEpoch ? seconds + APPLE_EPOCH_SECONDS : seconds
    const date = new Date(unix * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  #fromIso(iso: string, schema: Schema): number | null {
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) return null
    const unix = Math.floor(ms / 1000)
    return schema.appleEpoch ? unix - APPLE_EPOCH_SECONDS : unix
  }

  async #mailboxes(schema: Schema): Promise<readonly MailboxRow[]> {
    const counts =
      schema.mailboxes.has('unread_count') && schema.mailboxes.has('total_count')
        ? ', unread_count, total_count'
        : ''
    const rows = await this.files.query('envelope', `SELECT ROWID AS id, url${counts} FROM mailboxes`, [])
    const allowed = this.options.allowedAccounts()
    const out: MailboxRow[] = []
    for (const row of rows) {
      const id = num(row['id'])
      const url = str(row['url'])
      if (id === null || url === null) continue
      const parsed = parseMailboxUrl(url)
      if (parsed === null || !allowed.has(parsed.accountId)) continue
      out.push({ id, url, ...parsed, unread: num(row['unread_count']), total: num(row['total_count']) })
    }
    return out
  }

  /**
   * Every account Mail has, allowed or not, for the person choosing in the app. "On My Mac" (local
   * mailboxes) only when it holds mail: Mail always keeps an empty Outbox there.
   */
  async allAccounts(): Promise<
    readonly { readonly id: string; readonly name: string; readonly address: string | null }[]
  > {
    return this.#guard(async () => {
      const schema = await this.schema()
      const counts = schema.mailboxes.has('total_count') ? ', total_count' : ''
      const rows = await this.files.query('envelope', `SELECT ROWID AS id, url${counts} FROM mailboxes`, [])
      const ids = new Set<string>()
      let localMail = 0
      const localBoxes: number[] = []
      for (const row of rows) {
        const parsed = parseMailboxUrl(str(row['url']) ?? '')
        if (parsed === null) continue
        ids.add(parsed.accountId)
        if (parsed.accountId === 'local') {
          localMail += num(row['total_count']) ?? 0
          const id = num(row['id'])
          if (id !== null) localBoxes.push(id)
        }
      }
      if (ids.has('local') && counts === '' && localBoxes.length > 0)
        localMail = await this.#countIn(localBoxes)
      if (localMail === 0) ids.delete('local')
      const names = await this.#accountNames([...ids])
      return [...ids].sort().map((id) => this.#describe(id, names))
    })
  }

  async #countIn(mailboxes: readonly number[]): Promise<number> {
    const rows = await this.files.query(
      'envelope',
      `SELECT COUNT(*) AS n FROM messages WHERE mailbox IN (${mailboxes.map(() => '?').join(', ')})`,
      mailboxes,
    )
    return num(rows[0]?.['n']) ?? 0
  }

  #describe(
    id: string,
    names: ReadonlyMap<string, AccountName>,
  ): { id: string; name: string; address: string | null } {
    if (id === 'local') return { id, name: 'On My Mac', address: null }
    const named = names.get(id)
    return { id, name: named?.name ?? named?.address ?? 'Mail account', address: named?.address ?? null }
  }

  /**
   * Names and addresses for Mail's account ids. Internet Accounts (Accounts4.sqlite) names most
   * accounts on their own row; an iCloud account's mail row has neither name nor address and takes
   * its name from its parent row, as Mail does. An address the row doesn't give comes from what the
   * account has sent: the most common sender in its Sent mailbox.
   */
  async #accountNames(ids: readonly string[]): Promise<Map<string, AccountName>> {
    const names = new Map<string, AccountName>()
    const email = (value: string | null): string | null =>
      value !== null && value.includes('@') ? value : null
    let rows: readonly MailRow[] = []
    try {
      rows = await this.files.query(
        'accounts',
        'SELECT a.ZIDENTIFIER AS id, a.ZACCOUNTDESCRIPTION AS description, a.ZUSERNAME AS username, ' +
          'p.ZACCOUNTDESCRIPTION AS parent_description, p.ZUSERNAME AS parent_username ' +
          'FROM ZACCOUNT a LEFT JOIN ZACCOUNT p ON p.Z_PK = a.ZPARENTACCOUNT',
        [],
      )
    } catch {
      try {
        rows = await this.files.query(
          'accounts',
          'SELECT ZIDENTIFIER AS id, ZACCOUNTDESCRIPTION AS description, ZUSERNAME AS username FROM ZACCOUNT',
          [],
        )
      } catch {
        rows = []
      }
    }
    for (const row of rows) {
      const id = str(row['id'])
      if (id === null) continue
      const username = str(row['username'])
      names.set(id, {
        name: str(row['description']) ?? str(row['parent_description']) ?? email(username),
        address: email(username),
      })
    }
    for (const id of ids) {
      if (id === 'local' || names.get(id)?.address != null) continue
      const sent = await this.#sentAddress(id).catch(() => null)
      if (sent === null) continue
      const named = names.get(id)
      names.set(id, { name: named?.name ?? null, address: sent })
    }
    return names
  }

  async #sentAddress(accountId: string): Promise<string | null> {
    const prefix = `imap://${accountId.replace(/[\\%_]/g, (c) => `\\${c}`)}/Sent%`
    const rows = await this.files.query(
      'envelope',
      'SELECT a.address AS address, COUNT(*) AS n FROM messages m ' +
        'JOIN addresses a ON a.ROWID = m.sender JOIN mailboxes b ON b.ROWID = m.mailbox ' +
        "WHERE b.url LIKE ? ESCAPE '\\' GROUP BY a.address ORDER BY n DESC LIMIT 1",
      [prefix],
    )
    const address = str(rows[0]?.['address'])
    return address !== null && address.includes('@') ? address : null
  }

  /** The accounts the person allowed, with their mailboxes. */
  async accounts(): Promise<readonly MailAccount[]> {
    return this.#guard(async () => {
      const schema = await this.schema()
      const boxes = await this.#mailboxes(schema)
      const byAccount = new Map<string, Mailbox[]>()
      for (const box of boxes) {
        const list = byAccount.get(box.accountId) ?? []
        list.push({
          id: box.id,
          name: box.path.split('/').at(-1) ?? box.path,
          path: box.path,
          unread: box.unread,
          total: box.total,
        })
        byAccount.set(box.accountId, list)
      }
      const names = await this.#accountNames([...byAccount.keys()])
      return [...byAccount.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([id, mailboxes]) => ({
          ...this.#describe(id, names),
          mailboxes: mailboxes.sort((a, b) => (a.path < b.path ? -1 : 1)),
        }))
    })
  }

  #summarySelect(schema: Schema): { readonly columns: string; readonly joins: string } {
    const m = schema.messages
    const cols = [
      'm.ROWID AS id',
      'm.mailbox AS mailbox',
      'm.date_received AS date_received',
      's.subject AS subject',
      'a.address AS address',
      schema.addresses.has('comment') ? 'a.comment AS comment' : 'NULL AS comment',
      m.has('subject_prefix') ? 'm.subject_prefix AS subject_prefix' : 'NULL AS subject_prefix',
      m.has('read') ? 'm.read AS read' : '1 AS read',
      m.has('flagged') ? 'm.flagged AS flagged' : '0 AS flagged',
      m.has('conversation_id') ? 'm.conversation_id AS conversation_id' : 'NULL AS conversation_id',
      schema.summaries !== null && m.has('summary') ? 'su.summary AS summary' : 'NULL AS summary',
    ]
    let joins =
      ' FROM messages m LEFT JOIN subjects s ON s.ROWID = m.subject LEFT JOIN addresses a ON a.ROWID = m.sender'
    if (schema.summaries !== null && m.has('summary'))
      joins += ' LEFT JOIN summaries su ON su.ROWID = m.summary'
    return { columns: cols.join(', '), joins }
  }

  #summary(row: MailRow, boxes: ReadonlyMap<number, MailboxRow>, schema: Schema): MessageSummary | null {
    const id = num(row['id'])
    const box = boxes.get(num(row['mailbox']) ?? -1)
    if (id === null || box === undefined) return null
    const address = str(row['address'])
    const comment = str(row['comment'])
    const subject = `${str(row['subject_prefix']) ?? ''}${str(row['subject']) ?? ''}`
    return {
      id,
      accountId: box.accountId,
      mailbox: box.path,
      from:
        address === null ? null : { name: comment !== null && comment.length > 0 ? comment : null, address },
      subject,
      date: this.#toIso(num(row['date_received']), schema),
      unread: num(row['read']) === 0,
      flagged: (num(row['flagged']) ?? 0) !== 0,
      preview: previewOf(str(row['summary']) ?? ''),
    }
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    return this.#guard(async () => {
      const schema = await this.schema()
      const boxes = await this.#mailboxes(schema)
      let ids = boxes
      if (query.accountId !== undefined) ids = ids.filter((b) => b.accountId === query.accountId)
      if (query.mailboxId !== undefined) ids = ids.filter((b) => b.id === query.mailboxId)
      if (ids.length === 0) return { messages: [], nextOffset: null }
      const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_SEARCH_LIMIT)), MAX_SEARCH_LIMIT)
      const offset = Math.max(0, Math.floor(query.offset ?? 0))
      const { columns, joins } = this.#summarySelect(schema)
      const where: string[] = [`m.mailbox IN (${ids.map(() => '?').join(', ')})`]
      const params: MailValue[] = ids.map((b) => b.id)
      if (schema.messages.has('deleted')) where.push('m.deleted = 0')
      const comment = schema.addresses.has('comment')
      const person = (alias: string): string =>
        comment
          ? `(${alias}.address LIKE ? ESCAPE '\\' OR ${alias}.comment LIKE ? ESCAPE '\\')`
          : `${alias}.address LIKE ? ESCAPE '\\'`
      const personParams = (value: string): MailValue[] =>
        comment ? [escapeLike(value), escapeLike(value)] : [escapeLike(value)]
      if (query.from !== undefined) {
        where.push(person('a'))
        params.push(...personParams(query.from))
      }
      if (query.to !== undefined) {
        if (schema.recipients === null) throw new MailStoreError('unsupported')
        where.push(
          `EXISTS (SELECT 1 FROM recipients r JOIN addresses ra ON ra.ROWID = r.address WHERE r.message = m.ROWID AND ${person('ra')})`,
        )
        params.push(...personParams(query.to))
      }
      if (query.subject !== undefined) {
        where.push("s.subject LIKE ? ESCAPE '\\'")
        params.push(escapeLike(query.subject))
      }
      if (query.text !== undefined) {
        const any = ["s.subject LIKE ? ESCAPE '\\'", person('a')]
        const anyParams: MailValue[] = [escapeLike(query.text), ...personParams(query.text)]
        if (columns.includes('su.summary')) {
          any.push("su.summary LIKE ? ESCAPE '\\'")
          anyParams.push(escapeLike(query.text))
        }
        const found = await this.#spotlightIds(query.text)
        if (found.length > 0) {
          any.push(`m.ROWID IN (${found.map(() => '?').join(', ')})`)
          anyParams.push(...found)
        }
        where.push(`(${any.join(' OR ')})`)
        params.push(...anyParams)
      }
      if (query.since !== undefined) {
        const since = this.#fromIso(query.since, schema)
        if (since !== null) {
          where.push('m.date_received >= ?')
          params.push(since)
        }
      }
      if (query.until !== undefined) {
        const until = this.#fromIso(query.until, schema)
        if (until !== null) {
          where.push('m.date_received < ?')
          params.push(until)
        }
      }
      if (query.unread !== undefined && schema.messages.has('read'))
        where.push(query.unread ? 'm.read = 0' : 'm.read != 0')
      if (query.flagged !== undefined && schema.messages.has('flagged'))
        where.push(query.flagged ? 'm.flagged != 0' : 'm.flagged = 0')
      if (query.hasAttachment !== undefined) {
        if (schema.attachments === null) throw new MailStoreError('unsupported')
        where.push(
          `${query.hasAttachment ? '' : 'NOT '}EXISTS (SELECT 1 FROM attachments t WHERE t.message = m.ROWID)`,
        )
      }
      const sql = `SELECT ${columns}${joins} WHERE ${where.join(' AND ')} ORDER BY m.date_received DESC LIMIT ? OFFSET ?`
      params.push(limit + 1, offset)
      const rows = await this.files.query('envelope', sql, params)
      const byId = new Map(boxes.map((b) => [b.id, b]))
      const found: { message: MessageSummary; box: MailboxRow }[] = []
      for (const r of rows.slice(0, limit)) {
        const message = this.#summary(r, byId, schema)
        const box = byId.get(num(r['mailbox']) ?? -1)
        if (message !== null && box !== undefined) found.push({ message, box })
      }
      const messages = await this.#withPreviews(found)
      return { messages, nextOffset: rows.length > limit ? offset + limit : null }
    })
  }

  /**
   * Mail often keeps no summary of its own (on recent macOS, hardly ever), so a message without one
   * gets the start of its body instead. Reading stops once PREVIEW_BYTE_BUDGET of files have been
   * read for one search; the rest keep a null preview. A file that can't be read or parsed is skipped.
   */
  async #withPreviews(
    found: readonly { readonly message: MessageSummary; readonly box: MailboxRow }[],
  ): Promise<MessageSummary[]> {
    let budget = PREVIEW_BYTE_BUDGET
    const out: MessageSummary[] = []
    for (const { message, box } of found) {
      if (message.preview !== null || budget <= 0) {
        out.push(message)
        continue
      }
      let preview: string | null = null
      try {
        const file = await this.#findFile(message.id, box)
        if (file !== null) {
          budget -= file.bytes.length
          const parsed = parseMessage(parseEmlx(file.bytes, file.partial).message)
          preview = previewOf(parsed.text)
        }
      } catch (error) {
        if (error instanceof MailStoreError) throw error
        if (error instanceof MailFilesError && error.code === 'unavailable') throw error
      }
      out.push(preview === null ? message : { ...message, preview })
    }
    return out
  }

  /** Message row ids whose file Spotlight matches, from the file names. */
  async #spotlightIds(term: string): Promise<number[]> {
    const clean = term.replace(/["\\*']/g, '').trim()
    if (clean.length < 2 || clean.length > 100) return []
    let paths: readonly string[]
    try {
      paths = await this.files.spotlight(clean)
    } catch {
      return []
    }
    const ids = new Set<number>()
    for (const path of paths) {
      const m = /(?:^|\/)(\d{1,12})(?:\.partial)?\.emlx$/.exec(path)
      if (m !== null) ids.add(Number(m[1]))
      if (ids.size >= 500) break
    }
    return [...ids]
  }

  async #row(id: number, schema: Schema, boxes: readonly MailboxRow[]): Promise<MailRow | null> {
    if (boxes.length === 0) return null
    const { columns, joins } = this.#summarySelect(schema)
    const rows = await this.files.query(
      'envelope',
      `SELECT ${columns}${joins} WHERE m.ROWID = ? AND m.mailbox IN (${boxes.map(() => '?').join(', ')})`,
      [id, ...boxes.map((b) => b.id)],
    )
    return rows[0] ?? null
  }

  /** The .emlx for a message: where Mail normally keeps it, else found by walking its mailbox. */
  async #findFile(id: number, box: MailboxRow): Promise<{ bytes: Buffer; partial: boolean } | null> {
    let children: readonly { name: string; dir: boolean }[]
    try {
      children = await this.files.list(box.folder)
    } catch (error) {
      if (error instanceof MailFilesError && error.code === 'not-found') return null
      throw error
    }
    const own = children
      .filter((c) => c.dir && !c.name.endsWith('.mbox'))
      .map((c) => `${box.folder}/${c.name}`)
    const folder = messageFolder(id)
    const tryRead = async (
      path: string,
      partial: boolean,
    ): Promise<{ bytes: Buffer; partial: boolean } | null> => {
      try {
        return { bytes: await this.files.file(path), partial }
      } catch (error) {
        if (error instanceof MailFilesError && (error.code === 'not-found' || error.code === 'invalid'))
          return null
        throw error
      }
    }
    for (const base of [...own.map((dir) => `${dir}/${folder}`), `${box.folder}/Messages`]) {
      const found =
        (await tryRead(`${base}/${id}.emlx`, false)) ?? (await tryRead(`${base}/${id}.partial.emlx`, true))
      if (found !== null) return found
    }
    // Not where it should be: look through the mailbox's own folders (not its sub-mailboxes).
    const queue = [...own]
    let visited = 0
    while (queue.length > 0 && visited < 2_000) {
      const dir = queue.shift() as string
      visited++
      let entries: readonly { name: string; dir: boolean }[]
      try {
        entries = await this.files.list(dir)
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.dir && (e.name === `${id}.emlx` || e.name === `${id}.partial.emlx`)) {
          const found = await tryRead(`${dir}/${e.name}`, e.name.endsWith('.partial.emlx'))
          if (found !== null) return found
        }
        if (e.dir && !e.name.endsWith('.mbox')) queue.push(`${dir}/${e.name}`)
      }
    }
    return null
  }

  /** `html`: the body is the HTML part's markup (scripts and styles out), where there is one. */
  async read(
    id: number,
    maxChars: number = DEFAULT_BODY_CHARS,
    offset = 0,
    html = false,
  ): Promise<MessageDetail> {
    return this.#guard(async () => {
      const schema = await this.schema()
      const boxes = await this.#mailboxes(schema)
      return this.#detail(id, schema, boxes, maxChars, offset, html)
    })
  }

  /**
   * One attachment's text, from `offset`: text and calendar files as they are, HTML as text, a
   * forwarded message as its headers and text, a PDF through `pdfText`. Others come back with no
   * text and reason 'binary'. `index` is 1-based, as mail_read lists them.
   */
  async readAttachment(
    id: number,
    index: number,
    maxChars: number = DEFAULT_BODY_CHARS,
    offset = 0,
  ): Promise<AttachmentText> {
    return this.attachmentTextOf(await this.attachmentData(id, index), maxChars, offset)
  }

  /** The text of an attachment attachmentData found, from `offset`, as readAttachment gives it. */
  async attachmentTextOf(
    found: AttachmentData,
    maxChars: number = DEFAULT_BODY_CHARS,
    offset = 0,
  ): Promise<AttachmentText> {
    const { data } = found
    const base = { index: found.index, name: found.name, contentType: found.contentType, size: found.size }
    const empty = (reason: NonNullable<AttachmentText['reason']>): AttachmentText => ({
      ...base,
      text: null,
      offset: 0,
      nextOffset: null,
      reason,
    })
    if (data === null) return empty(found.reason ?? 'not-downloaded')
    const text = await this.#attachmentText(found, data)
    if (text === 'binary' || text === 'unreadable') return empty(text)
    const limit = Math.min(Math.max(100, Math.floor(maxChars)), MAX_BODY_CHARS)
    const from = Math.min(Math.max(0, Math.floor(offset)), text.length)
    const end = Math.min(text.length, from + limit)
    return {
      ...base,
      text: text.slice(from, end),
      offset: from,
      nextOffset: end < text.length ? end : null,
    }
  }

  /**
   * One attachment's bytes, from the message, Mail's own file of it, or Mail itself. Null data
   * when it can't be had; `reason` says why.
   */
  async attachmentData(id: number, index: number): Promise<AttachmentData> {
    return this.#guard(async () => {
      const schema = await this.schema()
      const boxes = await this.#mailboxes(schema)
      const row = await this.#row(id, schema, boxes)
      const box = boxes.find((b) => b.id === (num(row?.['mailbox']) ?? -1))
      if (row === null || box === undefined) throw new MailStoreError('not-found')
      const found = await this.#findFile(id, box)
      if (found === null) throw new MailStoreError('not-found')
      const parsed = parseMessage(parseEmlx(found.bytes, found.partial).message)
      const part = parsed.attachmentParts[index - 1]
      if (part === undefined) throw new MailStoreError('not-found')
      const base = {
        index,
        name: part.name,
        contentType: part.contentType,
        size: part.size,
        charset: part.charset,
      }
      if (part.data.length > 0) return { ...base, data: part.data }
      const own = await this.#attachmentFile(id, box, part)
      if (own === 'too-large') return { ...base, data: null, reason: 'too-large' }
      const fetched = own === null ? await this.#fromMail(id, row, box, parsed, part, schema) : own
      return fetched === null ? { ...base, data: null, reason: 'not-downloaded' } : { ...base, data: fetched }
    })
  }

  /** The attachment from the whole message as Mail gives it (downloading it if it must). */
  async #fromMail(
    id: number,
    row: MailRow,
    box: MailboxRow,
    parsed: ReturnType<typeof parseMessage>,
    part: AttachmentPart,
    schema: Schema,
  ): Promise<Buffer | null> {
    if (this.options.fetchSource === undefined) return null
    const summary = this.#summary(row, new Map([[box.id, box]]), schema)
    if (summary === null) return null
    let source: Buffer | null
    try {
      source = await this.options.fetchSource({
        messageId: parsed.messageId,
        accountId: box.accountId,
        mailbox: box.path,
        rowId: id,
        subject: parsed.subject ?? summary.subject,
        sender: parsed.from[0]?.address ?? summary.from?.address ?? null,
        date: summary.date,
      })
    } catch {
      return null
    }
    if (source === null) return null
    const whole = parseMessage(source).attachmentParts
    const same =
      whole.find((p) => p.section === part.section && p.name === part.name) ??
      whole.find((p) => p.name === part.name && p.contentType === part.contentType)
    return same === undefined || same.data.length === 0 ? null : same.data
  }

  async #attachmentText(
    part: Pick<AttachmentPart, 'name' | 'contentType' | 'charset'>,
    data: Buffer,
  ): Promise<string | 'binary' | 'unreadable'> {
    const type = part.contentType.toLowerCase()
    if (type === 'text/html' || (type === 'application/octet-stream' && HTML_NAMES.test(part.name)))
      return normaliseText(htmlToText(decodeCharset(data, part.charset)))
    if (TEXT_TYPES.test(type) || TEXT_NAMES.test(part.name))
      return normaliseText(decodeCharset(data, part.charset))
    if (type === 'message/rfc822' || /\.eml$/i.test(part.name)) {
      const inner = parseMessage(data)
      const who = (list: readonly Address[]): string =>
        list.map((a) => (a.name === null ? a.address : `${a.name} <${a.address}>`)).join(', ')
      const lines = [
        `From: ${who(inner.from)}`,
        `To: ${who(inner.to)}`,
        ...(inner.cc.length > 0 ? [`Cc: ${who(inner.cc)}`] : []),
        `Subject: ${inner.subject ?? ''}`,
        ...(inner.date === null ? [] : [`Date: ${inner.date}`]),
        ...(inner.attachments.length > 0
          ? [`Attachments: ${inner.attachments.map((a) => a.name).join(', ')}`]
          : []),
        '',
        inner.text,
      ]
      return lines.join('\n')
    }
    if (type === 'application/pdf' || /\.pdf$/i.test(part.name)) {
      if (this.options.pdfText === undefined) return 'unreadable'
      try {
        const text = await this.options.pdfText(data)
        return text === null ? 'unreadable' : normaliseText(text)
      } catch {
        return 'unreadable'
      }
    }
    return 'binary'
  }

  /**
   * An attachment Mail keeps in a file of its own: beside the message's Messages folder, in
   * <mailbox>/<folder>/Data/…/Attachments/<id>/<section>/<name>.
   * Null when it isn't there (Mail hasn't downloaded it).
   */
  async #attachmentFile(
    id: number,
    box: MailboxRow,
    part: AttachmentPart,
  ): Promise<Buffer | null | 'too-large'> {
    let children: readonly { name: string; dir: boolean }[]
    try {
      children = await this.files.list(box.folder)
    } catch {
      return null
    }
    const roots = children
      .filter((c) => c.dir && !c.name.endsWith('.mbox'))
      .map((c) => `${box.folder}/${c.name}`)
    const places = roots.flatMap((root) => [
      `${root}/${attachmentFolder(id)}/${id}`,
      `${root}/Attachments/${id}`,
    ])
    for (const dir of places) {
      let sections: readonly { name: string; dir: boolean }[]
      try {
        sections = await this.files.list(dir)
      } catch {
        continue
      }
      const ordered = [
        ...sections.filter((s) => s.dir && s.name === part.section),
        ...sections.filter((s) => s.dir && s.name !== part.section),
      ]
      for (const section of ordered) {
        let names: readonly { name: string; dir: boolean }[]
        try {
          names = await this.files.list(`${dir}/${section.name}`)
        } catch {
          continue
        }
        const files = names.filter((n) => !n.dir)
        const pick =
          files.find((f) => f.name === part.name) ??
          (section.name === part.section && files.length === 1 ? files[0] : undefined)
        if (pick === undefined) continue
        try {
          return await this.files.file(`${dir}/${section.name}/${pick.name}`)
        } catch (error) {
          if (error instanceof MailFilesError && error.code === 'too-large') return 'too-large'
          if (error instanceof MailFilesError && error.code === 'unavailable') throw error
          return null
        }
      }
    }
    return null
  }

  async #detail(
    id: number,
    schema: Schema,
    boxes: readonly MailboxRow[],
    maxChars: number,
    offset = 0,
    html = false,
  ): Promise<MessageDetail> {
    const row = await this.#row(id, schema, boxes)
    const byId = new Map(boxes.map((b) => [b.id, b]))
    const summary = row === null ? null : this.#summary(row, byId, schema)
    const box = byId.get(num(row?.['mailbox']) ?? -1)
    if (summary === null || box === undefined) throw new MailStoreError('not-found')
    const found = await this.#findFile(id, box)
    const limit = Math.min(Math.max(100, Math.floor(maxChars)), MAX_BODY_CHARS)
    let attachmentNames: { name: string; contentType: string; size: number }[] = []
    if (schema.attachments !== null) {
      const rows = await this.files.query(
        'envelope',
        'SELECT name FROM attachments WHERE message = ? LIMIT 100',
        [id],
      )
      attachmentNames = rows
        .map((r) => str(r['name']))
        .filter((n): n is string => n !== null)
        .map((name) => ({ name, contentType: 'application/octet-stream', size: 0 }))
    }
    if (found === null) {
      return {
        ...summary,
        to: [],
        cc: [],
        replyTo: [],
        messageId: null,
        inReplyTo: null,
        references: [],
        body: '',
        bodyTruncated: false,
        bodyOffset: 0,
        nextOffset: null,
        links: [],
        downloaded: false,
        attachments: attachmentNames,
      }
    }
    const emlx = parseEmlx(found.bytes, found.partial)
    const parsed = parseMessage(emlx.message)
    const markup = html && parsed.html !== null ? cleanHtml(parsed.html) : null
    const whole = markup ?? parsed.text
    const from = Math.min(Math.max(0, Math.floor(offset)), whole.length)
    const end = Math.min(whole.length, from + limit)
    const body = whole.slice(from, end)
    return {
      ...summary,
      preview: summary.preview ?? previewOf(parsed.text),
      subject: parsed.subject ?? summary.subject,
      from: parsed.from[0] ?? summary.from,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      body,
      ...(markup === null ? {} : { bodyFormat: 'html' as const }),
      bodyTruncated: end < whole.length,
      bodyOffset: from,
      nextOffset: end < whole.length ? end : null,
      links: parsed.links,
      downloaded: emlx.complete,
      attachments: parsed.attachments.length > 0 ? parsed.attachments : attachmentNames,
    }
  }

  /** The conversation a message is in, oldest first, each body cut to THREAD_BODY_CHARS. */
  async thread(id: number): Promise<readonly MessageDetail[]> {
    return this.#guard(async () => {
      const schema = await this.schema()
      const boxes = await this.#mailboxes(schema)
      const row = await this.#row(id, schema, boxes)
      if (row === null) throw new MailStoreError('not-found')
      const conversation = num(row['conversation_id'])
      const marks = boxes.map(() => '?').join(', ')
      let rows: readonly MailRow[]
      if (conversation !== null && conversation !== 0) {
        rows = await this.files.query(
          'envelope',
          `SELECT ROWID AS id FROM messages WHERE conversation_id = ? AND mailbox IN (${marks})${schema.messages.has('deleted') ? ' AND deleted = 0' : ''} ORDER BY date_received ASC LIMIT ?`,
          [conversation, ...boxes.map((b) => b.id), MAX_THREAD_MESSAGES],
        )
      } else {
        rows = await this.files.query(
          'envelope',
          `SELECT ROWID AS id FROM messages WHERE subject = (SELECT subject FROM messages WHERE ROWID = ?) AND mailbox IN (${marks})${schema.messages.has('deleted') ? ' AND deleted = 0' : ''} ORDER BY date_received ASC LIMIT ?`,
          [id, ...boxes.map((b) => b.id), MAX_THREAD_MESSAGES],
        )
      }
      const out: MessageDetail[] = []
      for (const r of rows) {
        const messageId = num(r['id'])
        if (messageId === null) continue
        try {
          out.push(await this.#detail(messageId, schema, boxes, THREAD_BODY_CHARS))
        } catch (error) {
          if (!(error instanceof MailStoreError && error.code === 'not-found')) throw error
        }
      }
      return out
    })
  }

  /** Where a message is, for replying to it in Mail. */
  async locate(
    id: number,
  ): Promise<{ readonly accountId: string; readonly mailbox: string; readonly messageId: string | null }> {
    const detail = await this.read(id, 100)
    return { accountId: detail.accountId, mailbox: detail.mailbox, messageId: detail.messageId }
  }
}

/**
 * An HTML part to hand an agent as markup: scripts, styles, comments and event handlers out, every
 * other tag and attribute (alt and title included) as it was. Nothing is fetched from it.
 */
export function cleanHtml(html: string): string {
  // One pass with indexOf, as htmlToText: hostile markup can't make it slow.
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
    const tag = /^<([a-z]+)/.exec(lower.slice(lt, lt + 10))?.[1]
    if (tag === 'script' || tag === 'style') {
      const end = lower.indexOf(`</${tag}`, lt)
      const endGt = end < 0 ? -1 : lower.indexOf('>', end)
      i = endGt < 0 ? html.length : endGt + 1
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    const end = gt < 0 ? html.length : gt + 1
    out += html.slice(lt, end).replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    i = end
  }
  return out
}
