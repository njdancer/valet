// How Valet reaches the Messages database, its attachments and the Contacts databases. Only a
// process with Full Disk Access can open them, which in the app is the reader helper alone
// (swift-bridge, MessagesAccess.swift), over its socket. Tests, and the made-up database CI builds,
// use DirectMessagesFiles (direct-files.ts) on files this process can read; the app never imports
// it. Both answer the same three questions with the same refusals.

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  answerRows,
  type HelperMailFilesOptions,
  MailFilesError,
  type MailRow,
  type MailValue,
  ReaderSocket,
} from '@valet/native-mail'

export type MessagesDb = 'chat' | 'contacts'
export type { MailRow as MessagesRow, MailValue as MessagesValue }
/** The helper's failures are Mail's: invalid, not-found, unavailable, too-large. */
export { MailFilesError as MessagesFilesError }

/**
 * The socket the reader helper with this launchd label listens on (valet-messages-helper's serve):
 * Mail, Messages (the tools and Valet's own code lookup alike), Calendar and Reminders.
 */
export function messagesHelperSocketPath(label: string, home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', label, 'helper.sock')
}

/** The Contacts database at the top of the AddressBook folder; others are named by their folder. */
export const MAIN_CONTACT_SOURCE = 'main'

export interface MessagesInfo {
  /** Whether chat.db is there and readable (false: no Full Disk Access, or Messages never ran). */
  readonly chat: boolean
  /** The Contacts databases there are, "main" first. */
  readonly contactSources: readonly string[]
}

export interface MessagesFiles {
  info(): Promise<MessagesInfo>
  /**
   * One read-only statement. On chat.db, `message_text(text, attributedBody)` gives a message's
   * text however Messages stored it. `source` names the Contacts database, for `contacts` only.
   */
  query(
    db: MessagesDb,
    sql: string,
    params: readonly MailValue[],
    source?: string,
  ): Promise<readonly MailRow[]>
  /** One file, by its path inside ~/Library/Messages/Attachments. */
  file(path: string): Promise<Buffer>
}

/** Through the reader helper's socket. */
export class HelperMessagesFiles implements MessagesFiles {
  readonly #reader: ReaderSocket

  constructor(options: HelperMailFilesOptions) {
    this.#reader = new ReaderSocket(options)
  }

  async info(): Promise<MessagesInfo> {
    const answer = await this.#reader.ask({ op: 'messages.info' })
    const chat = answer['chat']
    const sources = answer['contactSources']
    if (typeof chat !== 'boolean' || !Array.isArray(sources)) throw new MailFilesError('unavailable')
    return { chat, contactSources: sources.filter((s): s is string => typeof s === 'string') }
  }

  async query(
    db: MessagesDb,
    sql: string,
    params: readonly MailValue[],
    source?: string,
  ): Promise<readonly MailRow[]> {
    const request = source === undefined ? { db, sql, params } : { db, source, sql, params }
    return answerRows(await this.#reader.ask({ op: 'messages.query', ...request }))
  }

  async file(path: string): Promise<Buffer> {
    const answer = await this.#reader.ask({ op: 'messages.file', path })
    const data = answer['base64']
    if (typeof data !== 'string') throw new MailFilesError('unavailable')
    return Buffer.from(data, 'base64')
  }
}
