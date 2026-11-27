// The Messages and Contacts files read in this process, for tests and the made-up database CI
// builds: never the person's. The app never imports this module (it reaches them only through the
// reader helper), and it does what the helper does (MessagesAccess.swift) closely enough that the
// contract suite can check one against the other.

import * as nodeFs from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MAIN_CONTACT_SOURCE,
  type MessagesDb,
  type MessagesFiles,
  MessagesFilesError,
  type MessagesInfo,
  type MessagesRow,
  type MessagesValue,
} from './files'
import { attributedBodyText } from './typedstream'

const TABLES: Readonly<Record<MessagesDb, ReadonlySet<string>>> = {
  chat: new Set([
    'message',
    'chat',
    'handle',
    'chat_message_join',
    'chat_handle_join',
    'attachment',
    'message_attachment_join',
  ]),
  contacts: new Set(['ZABCDRECORD', 'ZABCDPHONENUMBER', 'ZABCDEMAILADDRESS']),
}

const ADDRESS_BOOK_FILE = 'AddressBook-v22.abcddb'
const SOURCE_NAME = /^[A-Za-z0-9-]{1,64}$/
const MAX_ROWS = 5_000
const MAX_FILE_BYTES = 25 * 1024 * 1024

export interface DirectMessagesFilesOptions {
  /** ~/Library/Messages, or a made-up one. */
  readonly messagesDir: string
  /** ~/Library/Application Support/AddressBook, or a made-up one. */
  readonly addressBookDir: string
}

/** The text column when it has text, else the attributedBody archive's string, else null. */
export function messageText(text: unknown, body: unknown): string | null {
  if (typeof text === 'string' && text !== '') return text
  if (body instanceof Uint8Array) return attributedBodyText(body)
  return null
}

export class DirectMessagesFiles implements MessagesFiles {
  constructor(private readonly options: DirectMessagesFilesOptions) {}

  async info(): Promise<MessagesInfo> {
    let chat = true
    try {
      await nodeFs.access(join(this.options.messagesDir, 'chat.db'), nodeFs.constants.R_OK)
    } catch {
      chat = false
    }
    return { chat, contactSources: await this.#sources() }
  }

  async #sources(): Promise<string[]> {
    const dir = this.options.addressBookDir
    const sources: string[] = []
    if (await exists(join(dir, ADDRESS_BOOK_FILE))) sources.push(MAIN_CONTACT_SOURCE)
    const names = await nodeFs.readdir(join(dir, 'Sources')).catch(() => [] as string[])
    for (const name of [...names].sort()) {
      if (!SOURCE_NAME.test(name) || name === MAIN_CONTACT_SOURCE) continue
      if (await exists(join(dir, 'Sources', name, ADDRESS_BOOK_FILE))) sources.push(name)
    }
    return sources
  }

  async query(
    db: MessagesDb,
    sql: string,
    params: readonly MessagesValue[],
    source?: string,
  ): Promise<readonly MessagesRow[]> {
    if ((db === 'contacts') !== (source !== undefined)) throw new MessagesFilesError('invalid')
    if (source !== undefined && !SOURCE_NAME.test(source)) throw new MessagesFilesError('invalid')
    // The helper's authorizer, approximately: one statement that only reads the listed tables.
    const trimmed = sql.trim()
    if (!/^(select|pragma\s+table_info\s*\(\s*\w+\s*\))/i.test(trimmed) || trimmed.includes(';')) {
      throw new MessagesFilesError('invalid')
    }
    const pragma = /^pragma\s+table_info\s*\(\s*(\w+)\s*\)$/i.exec(trimmed)
    if (pragma !== null && !TABLES[db].has(pragma[1] ?? '')) throw new MessagesFilesError('invalid')
    if (/\bsqlite_\w+/i.test(trimmed)) throw new MessagesFilesError('invalid')
    let path: string
    if (db === 'chat') path = join(this.options.messagesDir, 'chat.db')
    else {
      if (!(await this.#sources()).includes(source ?? '')) throw new MessagesFilesError('not-found')
      path =
        source === MAIN_CONTACT_SOURCE
          ? join(this.options.addressBookDir, ADDRESS_BOOK_FILE)
          : join(this.options.addressBookDir, 'Sources', source ?? '', ADDRESS_BOOK_FILE)
    }
    if (!(await exists(path))) throw new MessagesFilesError('unavailable')
    let database: DatabaseSync
    try {
      database = new DatabaseSync(path, { readOnly: true })
    } catch {
      throw new MessagesFilesError('unavailable')
    }
    try {
      if (db === 'chat') database.function('message_text', { deterministic: true }, messageText)
      const statement = database.prepare(trimmed)
      // Like the helper's JSON: a big integer comes as the nearest number.
      statement.setReadBigInts(true)
      const rows = statement.all(...params) as Record<string, unknown>[]
      if (rows.length > MAX_ROWS) throw new MessagesFilesError('too-large')
      // The helper sends text and numbers; anything else (a blob) as null.
      return rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            typeof v === 'bigint' ? Number(v) : typeof v === 'string' || typeof v === 'number' ? v : null,
          ]),
        ),
      )
    } catch (error) {
      if (error instanceof MessagesFilesError) throw error
      throw new MessagesFilesError('invalid')
    } finally {
      database.close()
    }
  }

  async file(path: string): Promise<Buffer> {
    if (path === '' || path.split('/').some((p) => p === '' || p === '.' || p === '..' || p.includes('\0')))
      throw new MessagesFilesError('invalid')
    let root: string
    try {
      root = await nodeFs.realpath(join(this.options.messagesDir, 'Attachments'))
    } catch {
      throw new MessagesFilesError('unavailable')
    }
    let resolved: string
    try {
      resolved = await nodeFs.realpath(resolve(root, path))
    } catch {
      throw new MessagesFilesError('not-found')
    }
    const rel = relative(root, resolved)
    if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) throw new MessagesFilesError('invalid')
    const info = await nodeFs.stat(resolved).catch(() => null)
    if (info === null || !info.isFile()) throw new MessagesFilesError('not-found')
    if (info.size > MAX_FILE_BYTES) throw new MessagesFilesError('too-large')
    return nodeFs.readFile(resolved)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await nodeFs.access(path)
    return true
  } catch {
    return false
  }
}
