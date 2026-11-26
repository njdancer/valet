// Reads the Mac's Messages history (docs/messages.md), through MessagesFiles. chat.db is
// undocumented and gains columns between macOS releases, so the store reads only the columns it
// needs, checks they are there before the first question, and stops with `unsupported` rather than
// guess when they aren't. Columns only newer releases have (edits, unsends, replies, emoji
// reactions) are read when present.
//
// A conversation is every chat with the same chat_identifier: the person's SMS and iMessage chats
// with one number are one conversation, as in the Messages app. Its id is that identifier (a phone
// number, an email address, or "chat…" for a group).
//
// Two rules hold on every question: a conversation the person hid doesn't exist (its messages and
// attachments read as not found), and, while the person keeps codes hidden, an incoming message
// that looks like a one-time code comes back with its text hidden and is never a search match.
//
// `recentFrom` is the one question that ignores the code rule: it is for Valet's own one-time-code
// lookups (packages/credentials), never an agent's tool.

import { HIDDEN_CODE_TEXT, looksLikeCode } from './codes'
import { type MessagesFiles, MessagesFilesError, type MessagesRow, type MessagesValue } from './files'

export type MessagesStoreFailure =
  /** The helper isn't installed or running, has no Full Disk Access, or Messages has no database. */
  | 'unavailable'
  /** chat.db isn't laid out the way this version of Valet reads it. */
  | 'unsupported'
  /** No such conversation, message or attachment the person lets agents see. */
  | 'not-found'

export class MessagesStoreError extends Error {
  constructor(readonly code: MessagesStoreFailure) {
    super(`messages: ${code}`)
    this.name = 'MessagesStoreError'
  }
}

export interface Person {
  /** The phone number or email address Messages knows them by. */
  readonly handle: string
  /** Their name in Contacts, when they are in it. */
  readonly name: string | null
}

export interface LastMessage {
  readonly date: string | null
  readonly fromMe: boolean
  readonly from: Person | null
  readonly text: string | null
}

export interface ChatSummary {
  /** The conversation's id: a phone number, an email address, or "chat…" for a group. */
  readonly id: string
  /** The group's name, or the people in it by name (or number). */
  readonly name: string
  readonly group: boolean
  /** iMessage, SMS, RCS: every service the conversation has used. */
  readonly services: readonly string[]
  readonly participants: readonly Person[]
  readonly lastMessage: LastMessage | null
  /** Incoming messages not read yet. */
  readonly unread: number
}

export interface AttachmentInfo {
  /** From 1, in the order the message has them. */
  readonly index: number
  readonly name: string
  readonly type: string
  readonly size: number | null
}

export type ReactionKind =
  | 'love'
  | 'like'
  | 'dislike'
  | 'laugh'
  | 'emphasize'
  | 'question'
  | 'emoji'
  | 'sticker'

export interface Reaction {
  readonly fromMe: boolean
  readonly from: Person | null
  readonly kind: ReactionKind
  /** The emoji, for an emoji reaction. */
  readonly emoji: string | null
}

export interface MessageItem {
  readonly id: number
  readonly chatId: string
  readonly date: string | null
  readonly fromMe: boolean
  /** Who sent it; null when the person did. */
  readonly from: Person | null
  /** Null when it has no text (only attachments), or when Valet hides it. */
  readonly text: string | null
  readonly textTruncated: boolean
  /** Why the text isn't shown: `code`, it looks like a one-time code. */
  readonly hidden: 'code' | null
  readonly service: string | null
  readonly unread: boolean
  readonly edited: boolean
  /** The sender took it back. */
  readonly unsent: boolean
  /** The message this one replies to, in a reply thread. */
  readonly replyTo: number | null
  readonly attachments: readonly AttachmentInfo[]
  readonly reactions: readonly Reaction[]
}

export interface SearchHit extends MessageItem {
  readonly chatName: string
}

export interface ChatsQuery {
  /** Words in the conversation's name, a participant's name, number or address. */
  readonly text?: string
  readonly limit?: number
  readonly offset?: number
}

export interface SearchQuery {
  /** Words in the message's text. */
  readonly text?: string
  readonly chatId?: string
  /** Part of the sender's name, number or address. */
  readonly from?: string
  /** True: only the person's own messages; false: only other people's. */
  readonly fromMe?: boolean
  readonly since?: string
  readonly until?: string
  readonly hasAttachment?: boolean
  readonly limit?: number
  readonly offset?: number
}

export interface ConversationQuery {
  /** Messages before this message id (older); without before or after, the newest. */
  readonly before?: number
  /** Messages after this message id (newer). */
  readonly after?: number
  readonly limit?: number
  readonly maxChars?: number
}

export interface Conversation {
  readonly chat: ChatSummary
  /** Oldest first. */
  readonly messages: readonly MessageItem[]
  /** Pass as before for the page before this one; null when there is none. */
  readonly earlier: number | null
  /** Pass as after for the page after this one; null when this page reaches the newest. */
  readonly later: number | null
}

export interface AttachmentData {
  readonly info: AttachmentInfo
  /** Null when the file can't be given; `reason` says why. */
  readonly data: Buffer | null
  readonly reason?: 'not-downloaded' | 'too-large'
}

export interface MessagesStoreOptions {
  /** The conversations the person hides from agents, read on every question. */
  readonly hidden: () => ReadonlySet<string>
  /** Whether incoming code-shaped messages are hidden, read on every question. */
  readonly hideCodes: () => boolean
  readonly now?: () => number
}

export const DEFAULT_CHATS_LIMIT = 20
export const MAX_CHATS_LIMIT = 100
export const DEFAULT_SEARCH_LIMIT = 30
export const MAX_SEARCH_LIMIT = 100
export const DEFAULT_PAGE = 50
export const MAX_PAGE = 200
export const DEFAULT_MESSAGE_CHARS = 4_000
export const MAX_MESSAGE_CHARS = 20_000
/** Search results show this much of each message. */
const SEARCH_CHARS = 1_000
/** The most hidden conversations a question names. */
export const MAX_HIDDEN = 500
/** Conversations the store looks at when listing them. */
const MAX_CHATS = 4_000
const CONTACTS_TTL_MS = 5 * 60_000
const PAGE_ROWS = 4_000

/** Messages counts time from 2001-01-01 UTC; older databases in seconds, newer in nanoseconds. */
const APPLE_EPOCH_MS = 978_307_200_000
const NANOSECOND_THRESHOLD = 100_000_000_000

/**
 * A Unix time in ms as milliseconds since 2001, the unit questions pass: Messages' nanoseconds are
 * past what a JSON number holds exactly, so SQL multiplies (`m.date >= ? * 1000000`) and answers in
 * milliseconds (msOf).
 */
export function appleDate(ms: number): number {
  return Math.floor(ms) - APPLE_EPOCH_MS
}

/** SQL for a date column in milliseconds since 2001, whether it holds nanoseconds or seconds. */
function msOf(column: string): string {
  return `(CASE WHEN ${column} >= ${NANOSECOND_THRESHOLD} THEN ${column} / 1000000 ELSE ${column} * 1000 END)`
}

/** Milliseconds since 2001, as msOf answers, as an ISO time. */
function iso(date: MessagesValue): string | null {
  if (typeof date !== 'number' || date === 0) return null
  const d = new Date(date + APPLE_EPOCH_MS)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const REACTION_KINDS: Readonly<Record<number, ReactionKind>> = {
  0: 'love',
  1: 'like',
  2: 'dislike',
  3: 'laugh',
  4: 'emphasize',
  5: 'question',
  6: 'emoji',
  7: 'sticker',
}

/** The columns the store needs, table by table; it reads nothing else. */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  message: [
    'ROWID',
    'guid',
    'text',
    'attributedBody',
    'handle_id',
    'service',
    'date',
    'is_from_me',
    'is_read',
    'cache_has_attachments',
    'associated_message_guid',
    'associated_message_type',
    'item_type',
  ],
  chat: ['ROWID', 'guid', 'style', 'chat_identifier', 'service_name', 'display_name'],
  handle: ['ROWID', 'id', 'service'],
  chat_message_join: ['chat_id', 'message_id', 'message_date'],
  chat_handle_join: ['chat_id', 'handle_id'],
  attachment: ['ROWID', 'filename', 'mime_type', 'transfer_name', 'total_bytes'],
  message_attachment_join: ['message_id', 'attachment_id'],
}
/** Read when there: newer releases' edits, unsends, replies and emoji reactions. */
const OPTIONAL = {
  message: ['date_edited', 'date_retracted', 'thread_originator_guid', 'associated_message_emoji'],
  attachment: ['hide_attachment', 'uti'],
} as const

interface Layout {
  readonly message: ReadonlySet<string>
  readonly attachment: ReadonlySet<string>
}

interface Contacts {
  readonly at: number
  readonly byKey: ReadonlyMap<string, string>
}

interface Group {
  readonly id: string
  readonly group: boolean
  readonly display: string | null
  readonly services: readonly string[]
  readonly last: number
  readonly handles: readonly string[]
}

export class MessagesStore {
  #layout: Layout | null = null
  #contacts: Contacts | null = null

  constructor(
    private readonly files: MessagesFiles,
    private readonly options: MessagesStoreOptions,
  ) {}

  #now(): number {
    return (this.options.now ?? Date.now)()
  }

  async #query(sql: string, params: readonly MessagesValue[] = []): Promise<readonly MessagesRow[]> {
    try {
      return await this.files.query('chat', sql, params)
    } catch (error) {
      if (error instanceof MessagesFilesError && error.code === 'invalid') {
        // A statement this store wrote was refused: the layout moved under it.
        throw new MessagesStoreError('unsupported')
      }
      throw new MessagesStoreError('unavailable')
    }
  }

  /** Checks chat.db has what the store reads. Throws `unsupported` or `unavailable`. */
  async layout(): Promise<Layout> {
    if (this.#layout !== null) return this.#layout
    let info: Awaited<ReturnType<MessagesFiles['info']>>
    try {
      info = await this.files.info()
    } catch {
      throw new MessagesStoreError('unavailable')
    }
    if (!info.chat) throw new MessagesStoreError('unavailable')
    const columns: Record<string, Set<string>> = {}
    for (const table of Object.keys(REQUIRED)) {
      const rows = await this.#query(`PRAGMA table_info(${table})`)
      columns[table] = new Set(rows.map((r) => String(r['name'])))
      for (const name of REQUIRED[table] ?? []) {
        if (!columns[table]?.has(name)) throw new MessagesStoreError('unsupported')
      }
    }
    const keep = (table: 'message' | 'attachment') =>
      new Set(OPTIONAL[table].filter((c) => columns[table]?.has(c)))
    this.#layout = { message: keep('message'), attachment: keep('attachment') }
    return this.#layout
  }

  // ---------- Names ----------

  /** Names from Contacts by handle key; empty when Contacts can't be read. Cached for a while. */
  async #names(): Promise<ReadonlyMap<string, string>> {
    const now = this.#now()
    if (this.#contacts !== null && now - this.#contacts.at < CONTACTS_TTL_MS) return this.#contacts.byKey
    const byKey = new Map<string, string>()
    try {
      const { contactSources } = await this.files.info()
      for (const source of contactSources) await this.#readContacts(source, byKey)
    } catch {
      // Names are a nicety: without Contacts, people show by number or address.
    }
    this.#contacts = { at: now, byKey }
    return byKey
  }

  async #readContacts(source: string, byKey: Map<string, string>): Promise<void> {
    const page = async (sql: string): Promise<MessagesRow[]> => {
      const rows: MessagesRow[] = []
      for (let offset = 0; offset < 50 * PAGE_ROWS; offset += PAGE_ROWS) {
        const got = await this.files.query('contacts', `${sql} LIMIT ? OFFSET ?`, [PAGE_ROWS, offset], source)
        rows.push(...got)
        if (got.length < PAGE_ROWS) break
      }
      return rows
    }
    const people = await page(
      'SELECT Z_PK AS id, ZFIRSTNAME AS first, ZLASTNAME AS last, ZNICKNAME AS nick, ZORGANIZATION AS org FROM ZABCDRECORD',
    )
    const names = new Map<number, string>()
    for (const p of people) {
      const full = [p['first'], p['last']].filter((x) => typeof x === 'string' && x.trim() !== '').join(' ')
      const name = full !== '' ? full : [p['nick'], p['org']].find((x) => typeof x === 'string' && x !== '')
      if (typeof p['id'] === 'number' && typeof name === 'string') names.set(p['id'], name.trim())
    }
    const phones = await page('SELECT ZOWNER AS owner, ZFULLNUMBER AS value FROM ZABCDPHONENUMBER')
    const emails = await page('SELECT ZOWNER AS owner, ZADDRESS AS value FROM ZABCDEMAILADDRESS')
    for (const row of [...phones, ...emails]) {
      const name = typeof row['owner'] === 'number' ? names.get(row['owner']) : undefined
      const key = typeof row['value'] === 'string' ? handleKey(row['value']) : null
      if (name !== undefined && key !== null && !byKey.has(key)) byKey.set(key, name)
    }
  }

  #person(handle: string | null, names: ReadonlyMap<string, string>): Person | null {
    if (handle === null || handle === '') return null
    const key = handleKey(handle)
    return { handle, name: key === null ? null : (names.get(key) ?? null) }
  }

  // ---------- Conversations ----------

  #hidden(): readonly string[] {
    return [...this.options.hidden()].slice(0, MAX_HIDDEN)
  }

  /** `AND c.chat_identifier NOT IN (…)` for the hidden conversations, with its parameters. */
  #notHidden(): { sql: string; params: string[] } {
    const hidden = this.#hidden()
    if (hidden.length === 0) return { sql: '', params: [] }
    return { sql: ` AND c.chat_identifier NOT IN (${hidden.map(() => '?').join(', ')})`, params: [...hidden] }
  }

  /** Every conversation with a message, newest first, hidden ones too when asked. */
  async #groups(includeHidden: boolean, only?: string): Promise<Group[]> {
    await this.layout()
    const hidden = includeHidden ? { sql: '', params: [] } : this.#notHidden()
    const where = only === undefined ? '' : ' AND c.chat_identifier = ?'
    const rows = await this.#query(
      `SELECT c.chat_identifier AS id, MAX(c.style) AS style,
         ${msOf('MAX((SELECT MAX(j.message_date) FROM chat_message_join j WHERE j.chat_id = c.ROWID))')} AS last, MAX(NULLIF(c.display_name, '')) AS display,
         group_concat(DISTINCT c.service_name) AS services
       FROM chat c WHERE c.chat_identifier IS NOT NULL${hidden.sql}${where}
       GROUP BY c.chat_identifier HAVING last IS NOT NULL
       ORDER BY MAX((SELECT MAX(j.message_date) FROM chat_message_join j WHERE j.chat_id = c.ROWID)) DESC LIMIT ?`,
      [...hidden.params, ...(only === undefined ? [] : [only]), MAX_CHATS],
    )
    if (rows.length === 0) return []
    const ids = rows.map((r) => String(r['id']))
    const handles = new Map<string, string[]>()
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      const people = await this.#query(
        `SELECT DISTINCT c.chat_identifier AS id, h.id AS handle FROM chat c
         JOIN chat_handle_join chj ON chj.chat_id = c.ROWID JOIN handle h ON h.ROWID = chj.handle_id
         WHERE c.chat_identifier IN (${part.map(() => '?').join(', ')}) ORDER BY h.id`,
        part,
      )
      for (const p of people) {
        const list = handles.get(String(p['id'])) ?? []
        const handle = String(p['handle'])
        // The same person over SMS and iMessage is one handle id.
        if (!list.includes(handle)) list.push(handle)
        handles.set(String(p['id']), list)
      }
    }
    return rows.map((r) => {
      const id = String(r['id'])
      return {
        id,
        group: r['style'] === 43 || /^chat\d/.test(id),
        display: typeof r['display'] === 'string' ? r['display'] : null,
        services: String(r['services'] ?? '')
          .split(',')
          .filter((s) => s !== ''),
        last: typeof r['last'] === 'number' ? r['last'] : 0,
        handles: handles.get(id) ?? (/^chat\d/.test(id) ? [] : [id]),
      }
    })
  }

  #chatName(group: Group, names: ReadonlyMap<string, string>): string {
    if (group.display !== null) return group.display
    const people = group.handles.map((h) => this.#person(h, names)?.name ?? h)
    if (people.length === 0) return group.id
    return people.join(', ')
  }

  async #summaries(groups: readonly Group[], names: ReadonlyMap<string, string>): Promise<ChatSummary[]> {
    if (groups.length === 0) return []
    const ids = groups.map((g) => g.id)
    const unread = await this.#query(
      `SELECT c.chat_identifier AS id, COUNT(DISTINCT m.ROWID) AS n FROM chat c
       JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id
       WHERE m.is_read = 0 AND m.is_from_me = 0 AND m.item_type = 0
         AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
         AND c.chat_identifier IN (${ids.map(() => '?').join(', ')})
       GROUP BY c.chat_identifier`,
      ids,
    )
    const unreadBy = new Map(unread.map((r) => [String(r['id']), Number(r['n'] ?? 0)]))
    const out: ChatSummary[] = []
    for (const g of groups) {
      const last = await this.#page(g.id, { limit: 1 }, names, SEARCH_CHARS)
      const m = last.messages[0]
      out.push({
        id: g.id,
        name: this.#chatName(g, names),
        group: g.group,
        services: g.services,
        participants: g.handles.map((h) => this.#person(h, names)).filter((p): p is Person => p !== null),
        lastMessage:
          m === undefined
            ? null
            : {
                date: m.date,
                fromMe: m.fromMe,
                from: m.from,
                text:
                  m.text ??
                  (m.attachments.length === 0
                    ? null
                    : `[${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]`),
              },
        unread: unreadBy.get(g.id) ?? 0,
      })
    }
    return out
  }

  /** The conversations agents may see, newest first. */
  async chats(query: ChatsQuery = {}): Promise<{ chats: ChatSummary[]; nextOffset: number | null }> {
    const names = await this.#names()
    let groups = await this.#groups(false)
    const words = query.text?.trim().toLowerCase()
    if (words !== undefined && words !== '') {
      // A number as the person writes it locally (0400 …) matches one stored with its country code.
      const digits = words.replace(/\D/g, '').replace(/^0+/, '')
      groups = groups.filter((g) => {
        const hay = [this.#chatName(g, names), g.id, ...g.handles].join('\n').toLowerCase()
        if (hay.includes(words)) return true
        return digits.length >= 4 && g.handles.some((h) => h.replace(/\D/g, '').includes(digits))
      })
    }
    const limit = Math.min(query.limit ?? DEFAULT_CHATS_LIMIT, MAX_CHATS_LIMIT)
    const offset = query.offset ?? 0
    const page = groups.slice(offset, offset + limit)
    return {
      chats: await this.#summaries(page, names),
      nextOffset: offset + limit < groups.length ? offset + limit : null,
    }
  }

  /** Every conversation, hidden ones too, for the person's settings: id, name, people, last date. */
  async allChats(limit = 1_000): Promise<
    readonly {
      readonly id: string
      readonly name: string
      readonly handles: readonly string[]
      readonly group: boolean
      readonly last: string | null
    }[]
  > {
    const names = await this.#names()
    const groups = await this.#groups(true)
    return groups.slice(0, limit).map((g) => ({
      id: g.id,
      name: this.#chatName(g, names),
      handles: g.handles,
      group: g.group,
      last: iso(g.last),
    }))
  }

  // ---------- Messages ----------

  #columns(layout: Layout): string {
    const has = (c: string) => layout.message.has(c)
    return [
      'm.ROWID AS id',
      'm.guid AS guid',
      'message_text(m.text, m.attributedBody) AS body',
      `${msOf('m.date')} AS date`,
      'm.is_from_me AS fromMe',
      'm.is_read AS isRead',
      'm.service AS service',
      'm.cache_has_attachments AS hasAttachments',
      'h.id AS handle',
      'c.chat_identifier AS chatId',
      has('date_edited') ? 'm.date_edited AS edited' : '0 AS edited',
      has('date_retracted') ? 'm.date_retracted AS retracted' : '0 AS retracted',
      has('thread_originator_guid') ? 'm.thread_originator_guid AS replyGuid' : 'NULL AS replyGuid',
    ].join(', ')
  }

  /** Rows of messages (newest first, as asked) made into MessageItems, oldest last. */
  async #items(
    rows: readonly MessagesRow[],
    names: ReadonlyMap<string, string>,
    maxChars: number,
    chatIds: readonly string[],
  ): Promise<MessageItem[]> {
    if (rows.length === 0) return []
    const layout = await this.layout()
    const ids = rows.map((r) => Number(r['id']))
    const attachments = await this.#attachments(ids, layout)
    const reactions = await this.#reactions(rows, chatIds, names, layout)
    const replyIds = await this.#replyIds(rows)
    const hideCodes = this.options.hideCodes()
    return rows.map((r) => {
      const id = Number(r['id'])
      const fromMe = r['fromMe'] === 1
      const raw = typeof r['body'] === 'string' ? cleanText(r['body']) : null
      const hidden = hideCodes && !fromMe && looksLikeCode(raw) ? 'code' : null
      const text = hidden === null ? raw : HIDDEN_CODE_TEXT
      const shown = text === null ? null : text.slice(0, maxChars)
      const retracted = typeof r['retracted'] === 'number' && r['retracted'] > 0
      return {
        id,
        chatId: String(r['chatId']),
        date: iso(r['date'] ?? null),
        fromMe,
        from: fromMe ? null : this.#person(typeof r['handle'] === 'string' ? r['handle'] : null, names),
        text: shown === '' ? null : shown,
        textTruncated: text !== null && text.length > maxChars,
        hidden,
        service: typeof r['service'] === 'string' ? r['service'] : null,
        unread: !fromMe && r['isRead'] === 0,
        edited: typeof r['edited'] === 'number' && r['edited'] > 0,
        unsent: retracted,
        replyTo: typeof r['replyGuid'] === 'string' ? (replyIds.get(r['replyGuid']) ?? null) : null,
        attachments: attachments.get(id) ?? [],
        reactions: reactions.get(String(r['guid'])) ?? [],
      }
    })
  }

  async #attachmentRows(ids: readonly number[], layout: Layout): Promise<readonly MessagesRow[]> {
    if (ids.length === 0) return []
    const hide = layout.attachment.has('hide_attachment')
      ? ' AND (a.hide_attachment IS NULL OR a.hide_attachment = 0)'
      : ''
    return this.#query(
      `SELECT maj.message_id AS messageId, a.ROWID AS id, a.filename AS filename, a.mime_type AS type,
         a.transfer_name AS name, a.total_bytes AS size${layout.attachment.has('uti') ? ', a.uti AS uti' : ', NULL AS uti'}
       FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
       WHERE maj.message_id IN (${ids.map(() => '?').join(', ')})${hide}
       ORDER BY maj.message_id, a.ROWID`,
      ids,
    )
  }

  async #attachments(ids: readonly number[], layout: Layout): Promise<Map<number, AttachmentInfo[]>> {
    const out = new Map<number, AttachmentInfo[]>()
    for (const row of await this.#attachmentRows(ids, layout)) {
      const name = attachmentName(row)
      // Link previews and other app data Messages keeps as attachments aren't the person's files.
      if (name.endsWith('.pluginPayloadAttachment')) continue
      const messageId = Number(row['messageId'])
      const list = out.get(messageId) ?? []
      list.push({
        index: list.length + 1,
        name,
        type: attachmentType(row),
        size: typeof row['size'] === 'number' ? row['size'] : null,
      })
      out.set(messageId, list)
    }
    return out
  }

  /** Reactions to the given messages, by the message's guid, with removals applied. */
  async #reactions(
    rows: readonly MessagesRow[],
    chatIds: readonly string[],
    names: ReadonlyMap<string, string>,
    layout: Layout,
  ): Promise<Map<string, Reaction[]>> {
    const out = new Map<string, Reaction[]>()
    const guids = new Set(rows.map((r) => String(r['guid'])))
    const oldest = Math.min(...rows.map((r) => (typeof r['date'] === 'number' ? r['date'] : 0)))
    const ids = [...new Set(chatIds)]
    if (ids.length === 0) return out
    const emoji = layout.message.has('associated_message_emoji') ? 'm.associated_message_emoji' : 'NULL'
    const reactionRows = await this.#query(
      `SELECT m.associated_message_guid AS target, m.associated_message_type AS type, m.is_from_me AS fromMe,
         h.id AS handle, ${emoji} AS emoji
       FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE c.chat_identifier IN (${ids.map(() => '?').join(', ')})
         AND m.associated_message_type >= 2000 AND m.associated_message_type < 4000 AND m.date >= ? * 1000000
       ORDER BY m.date, m.ROWID LIMIT ?`,
      [...ids, oldest, PAGE_ROWS],
    )
    for (const r of reactionRows) {
      const target = typeof r['target'] === 'string' ? r['target'].replace(/^(p:\d+\/|bp:)/, '') : ''
      if (!guids.has(target)) continue
      const type = Number(r['type'])
      const kind = REACTION_KINDS[type % 1000]
      if (kind === undefined) continue
      const fromMe = r['fromMe'] === 1
      const handle = typeof r['handle'] === 'string' ? r['handle'] : null
      const list = (out.get(target) ?? []).filter(
        // A later reaction from the same person replaces their earlier one; a removal just removes it.
        (x) => !(x.fromMe === fromMe && (fromMe || x.from?.handle === handle)),
      )
      if (type < 3000)
        list.push({
          fromMe,
          from: fromMe ? null : this.#person(handle, names),
          kind,
          emoji: typeof r['emoji'] === 'string' ? r['emoji'] : null,
        })
      out.set(target, list)
    }
    return out
  }

  async #replyIds(rows: readonly MessagesRow[]): Promise<Map<string, number>> {
    const guids = [
      ...new Set(rows.map((r) => r['replyGuid']).filter((g): g is string => typeof g === 'string')),
    ]
    const out = new Map<string, number>()
    if (guids.length === 0) return out
    const found = await this.#query(
      `SELECT ROWID AS id, guid FROM message WHERE guid IN (${guids.map(() => '?').join(', ')})`,
      guids,
    )
    for (const f of found) out.set(String(f['guid']), Number(f['id']))
    return out
  }

  /** One page of a conversation, newest-first rows turned oldest first. */
  async #page(
    chatId: string,
    query: ConversationQuery,
    names: ReadonlyMap<string, string>,
    maxChars: number,
  ): Promise<{ messages: MessageItem[]; more: boolean }> {
    const layout = await this.layout()
    const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE)
    const params: MessagesValue[] = [chatId]
    let bound = ''
    let order = 'DESC'
    const anchorId = query.before ?? query.after
    if (anchorId !== undefined) {
      const anchor = await this.#query(
        `SELECT m.ROWID AS id FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id WHERE m.ROWID = ? AND c.chat_identifier = ?`,
        [anchorId, chatId],
      )
      if (anchor.length === 0) throw new MessagesStoreError('not-found')
      // The anchor's date stays in SQL: nanoseconds don't survive a JSON number.
      const date = '(SELECT a.date FROM message a WHERE a.ROWID = ?)'
      if (query.before !== undefined) bound = ` AND (m.date < ${date} OR (m.date = ${date} AND m.ROWID < ?))`
      else {
        bound = ` AND (m.date > ${date} OR (m.date = ${date} AND m.ROWID > ?))`
        order = 'ASC'
      }
      params.push(anchorId, anchorId, anchorId)
    }
    const rows = await this.#query(
      `SELECT ${this.#columns(layout)}
       FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE c.chat_identifier = ? AND m.item_type = 0
         AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)${bound}
       GROUP BY m.ROWID ORDER BY m.date ${order}, m.ROWID ${order} LIMIT ?`,
      [...params, limit + 1],
    )
    const more = rows.length > limit
    const kept = rows.slice(0, limit)
    const items = await this.#items(kept, names, maxChars, [chatId])
    return { messages: order === 'DESC' ? items.reverse() : items, more }
  }

  /** A conversation's messages, oldest first: the newest page, or the page before or after a message. */
  async conversation(chatId: string, query: ConversationQuery = {}): Promise<Conversation> {
    if (this.#hidden().includes(chatId)) throw new MessagesStoreError('not-found')
    const names = await this.#names()
    const groups = await this.#groups(false, chatId)
    const group = groups[0]
    if (group === undefined) throw new MessagesStoreError('not-found')
    const maxChars = Math.min(query.maxChars ?? DEFAULT_MESSAGE_CHARS, MAX_MESSAGE_CHARS)
    const page = await this.#page(chatId, query, names, maxChars)
    const [chat] = await this.#summaries([group], names)
    const first = page.messages[0]?.id ?? null
    const last = page.messages[page.messages.length - 1]?.id ?? null
    let earlier: number | null
    let later: number | null
    if (query.after !== undefined) {
      // Going forward: older messages are there (the anchor at least); newer ones if more.
      earlier = first ?? query.after
      later = page.more ? last : null
    } else {
      earlier = page.more ? first : null
      later = query.before === undefined ? null : (last ?? query.before)
    }
    return { chat: chat as ChatSummary, messages: page.messages, earlier, later }
  }

  /** Handles whose number, address or Contacts name contains `from`. */
  async #handlesFrom(from: string, names: ReadonlyMap<string, string>): Promise<string[]> {
    const words = from.trim().toLowerCase()
    const digits = words.replace(/\D/g, '').replace(/^0+/, '')
    const all: string[] = []
    for (let offset = 0; offset < 25 * PAGE_ROWS; offset += PAGE_ROWS) {
      const rows = await this.#query('SELECT DISTINCT id FROM handle ORDER BY id LIMIT ? OFFSET ?', [
        PAGE_ROWS,
        offset,
      ])
      all.push(...rows.map((r) => String(r['id'])))
      if (rows.length < PAGE_ROWS) break
    }
    return all
      .filter((h) => {
        if (h.toLowerCase().includes(words)) return true
        if (digits.length >= 4 && h.replace(/\D/g, '').includes(digits)) return true
        const name = this.#person(h, names)?.name
        return name !== null && name !== undefined && name.toLowerCase().includes(words)
      })
      .slice(0, 200)
  }

  /** Messages in the conversations agents may see, newest first. */
  async search(query: SearchQuery = {}): Promise<{ messages: SearchHit[]; nextOffset: number | null }> {
    const layout = await this.layout()
    if (query.chatId !== undefined && this.#hidden().includes(query.chatId))
      return { messages: [], nextOffset: null }
    const names = await this.#names()
    const limit = Math.min(query.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
    const hidden = this.#notHidden()
    const clauses: string[] = []
    const params: MessagesValue[] = [...hidden.params]
    if (query.chatId !== undefined) {
      clauses.push('c.chat_identifier = ?')
      params.push(query.chatId)
    }
    if (query.from !== undefined) {
      const handles = await this.#handlesFrom(query.from, names)
      if (handles.length === 0) return { messages: [], nextOffset: null }
      clauses.push(`m.is_from_me = 0 AND h.id IN (${handles.map(() => '?').join(', ')})`)
      params.push(...handles)
    }
    if (query.fromMe !== undefined) clauses.push(query.fromMe ? 'm.is_from_me = 1' : 'm.is_from_me = 0')
    if (query.since !== undefined) {
      clauses.push('m.date >= ? * 1000000')
      params.push(appleDate(Date.parse(query.since)))
    }
    if (query.until !== undefined) {
      clauses.push('m.date < ? * 1000000')
      params.push(appleDate(Date.parse(query.until)))
    }
    if (query.hasAttachment === true) clauses.push('m.cache_has_attachments = 1')
    if (query.hasAttachment === false) clauses.push('m.cache_has_attachments = 0')
    const text = query.text?.trim().toLowerCase()
    if (text !== undefined && text !== '') {
      clauses.push('instr(lower(message_text(m.text, m.attributedBody)), ?) > 0')
      params.push(text)
    }
    const where = clauses.map((c) => ` AND ${c}`).join('')
    const hideCodes = this.options.hideCodes()
    const hits: SearchHit[] = []
    let offset = query.offset ?? 0
    // Code-shaped messages never match, so a page is filled from as many rows as it takes, a few
    // pages' worth at most.
    for (let round = 0; round < 5 && hits.length < limit; round++) {
      const want = limit - hits.length
      const rows = await this.#query(
        `SELECT ${this.#columns(layout)}
         FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE m.item_type = 0 AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)${hidden.sql}${where}
         GROUP BY m.ROWID ORDER BY m.date DESC, m.ROWID DESC LIMIT ? OFFSET ?`,
        [...params, want + 1, offset],
      )
      const more = rows.length > want
      const kept = rows.slice(0, want)
      offset += kept.length
      const items = await this.#items(kept, names, SEARCH_CHARS, [
        ...new Set(kept.map((r) => String(r['chatId']))),
      ])
      const groups = new Map<string, Group>()
      for (const item of items) {
        if (hideCodes && item.hidden === 'code') continue
        let group = groups.get(item.chatId)
        if (group === undefined) {
          group = (await this.#groups(false, item.chatId))[0]
          if (group !== undefined) groups.set(item.chatId, group)
        }
        hits.push({ ...item, chatName: group === undefined ? item.chatId : this.#chatName(group, names) })
      }
      if (!more) return { messages: hits, nextOffset: null }
    }
    return { messages: hits, nextOffset: offset }
  }

  /** One attachment's bytes, from a message in a conversation agents may see. */
  async attachment(messageId: number, index: number): Promise<AttachmentData> {
    const layout = await this.layout()
    const hidden = this.#notHidden()
    const owner = await this.#query(
      `SELECT c.chat_identifier AS chatId FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id WHERE m.ROWID = ?${hidden.sql} LIMIT 1`,
      [messageId, ...hidden.params],
    )
    if (owner.length === 0) throw new MessagesStoreError('not-found')
    const rows = (await this.#attachmentRows([messageId], layout)).filter(
      (r) => !attachmentName(r).endsWith('.pluginPayloadAttachment'),
    )
    const row = rows[index - 1]
    if (row === undefined) throw new MessagesStoreError('not-found')
    const info: AttachmentInfo = {
      index,
      name: attachmentName(row),
      type: attachmentType(row),
      size: typeof row['size'] === 'number' ? row['size'] : null,
    }
    const path = attachmentPath(row['filename'] ?? null)
    if (path === null) return { info, data: null, reason: 'not-downloaded' }
    try {
      return { info, data: await this.files.file(path) }
    } catch (error) {
      if (error instanceof MessagesFilesError && error.code === 'too-large')
        return { info, data: null, reason: 'too-large' }
      if (error instanceof MessagesFilesError && error.code === 'not-found')
        return { info, data: null, reason: 'not-downloaded' }
      throw new MessagesStoreError('unavailable')
    }
  }

  /**
   * The texts of recent incoming messages from one handle, newest first, codes included: for
   * Valet's own one-time-code lookups, never an agent's tool. The hidden list doesn't apply either.
   */
  async recentFrom(handle: string, sinceMs: number, limit = 50): Promise<string[]> {
    await this.layout()
    const rows = await this.#query(
      `SELECT message_text(m.text, m.attributedBody) AS body FROM message m JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.is_from_me = 0 AND lower(h.id) = ? AND m.date >= ? * 1000000 ORDER BY m.date DESC LIMIT ?`,
      [handle.toLowerCase(), appleDate(sinceMs), Math.min(limit, 50)],
    )
    return rows.map((r) => r['body']).filter((b): b is string => typeof b === 'string')
  }
}

/** A handle's key for matching Contacts: an email lowercased, or a number's last nine digits. */
export function handleKey(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.includes('@')) return trimmed.toLowerCase()
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 3) return trimmed === '' ? null : trimmed.toLowerCase()
  return digits.length > 9 ? digits.slice(-9) : digits
}

/** A message's text without the placeholders Messages puts where attachments sit. */
function cleanText(text: string): string {
  return text.replace(/\uFFFC/g, '').trim()
}

function attachmentName(row: MessagesRow): string {
  const name = row['name']
  if (typeof name === 'string' && name !== '') return name
  const file = row['filename']
  if (typeof file === 'string' && file !== '') return file.split('/').pop() ?? 'attachment'
  return 'attachment'
}

const UTI_TYPES: Readonly<Record<string, string>> = {
  'public.jpeg': 'image/jpeg',
  'public.png': 'image/png',
  'public.heic': 'image/heic',
  'com.compuserve.gif': 'image/gif',
  'public.tiff': 'image/tiff',
  'com.apple.coreaudio-format': 'audio/x-caf',
  'com.apple.quicktime-movie': 'video/quicktime',
  'public.mpeg-4': 'video/mp4',
  'com.adobe.pdf': 'application/pdf',
  'public.vcard': 'text/vcard',
}

function attachmentType(row: MessagesRow): string {
  const type = row['type']
  if (typeof type === 'string' && type !== '') return type
  const uti = row['uti']
  if (typeof uti === 'string' && UTI_TYPES[uti] !== undefined) return UTI_TYPES[uti] as string
  return 'application/octet-stream'
}

const ATTACHMENTS_DIR = 'Library/Messages/Attachments/'

/** The path inside ~/Library/Messages/Attachments that Messages recorded, or null. */
export function attachmentPath(filename: MessagesValue): string | null {
  if (typeof filename !== 'string') return null
  const at = filename.indexOf(ATTACHMENTS_DIR)
  if (at < 0) return null
  const rest = filename.slice(at + ATTACHMENTS_DIR.length)
  return rest === '' ? null : rest
}
