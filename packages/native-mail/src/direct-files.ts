// Mail's files read in this process, for tests and the made-up library CI builds: never the
// person's. The app never imports this module (it reaches Mail only through the reader helper).

import * as nodeFs from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type ListEntry,
  type MailDb,
  type MailFiles,
  MailFilesError,
  type MailRow,
  type MailValue,
} from './files'

const TABLES: Readonly<Record<MailDb, ReadonlySet<string>>> = {
  envelope: new Set([
    'messages',
    'subjects',
    'addresses',
    'recipients',
    'mailboxes',
    'summaries',
    'attachments',
    'conversations',
    'message_global_data',
  ]),
  accounts: new Set(['ZACCOUNT', 'ZACCOUNTTYPE']),
}

export interface DirectMailFilesOptions {
  /** ~/Library/Mail, or a made-up one. */
  readonly mailDir: string
  readonly accountsDb: string
  /** What Spotlight would find; tests only. */
  readonly spotlight?: (term: string, library: string) => Promise<readonly string[]>
}

/** Mail's files read in this process: for tests and the fixture library, never the person's. */
export class DirectMailFiles implements MailFiles {
  constructor(private readonly options: DirectMailFilesOptions) {}

  async library(): Promise<string> {
    let names: string[]
    try {
      names = await nodeFs.readdir(this.options.mailDir)
    } catch {
      throw new MailFilesError('unavailable')
    }
    let best: number | null = null
    for (const name of names) {
      const m = /^V(\d{1,3})$/.exec(name)
      if (m === null) continue
      const number = Number(m[1])
      try {
        await nodeFs.access(join(this.options.mailDir, name, 'MailData', 'Envelope Index'))
      } catch {
        continue
      }
      if (best === null || number > best) best = number
    }
    if (best === null) throw new MailFilesError('unavailable')
    return `V${best}`
  }

  async query(db: MailDb, sql: string, params: readonly MailValue[]): Promise<readonly MailRow[]> {
    // The helper's authorizer, approximately: one statement that only reads the listed tables.
    const trimmed = sql.trim()
    if (!/^(select|pragma\s+table_info\s*\(\s*\w+\s*\))/i.test(trimmed) || trimmed.includes(';')) {
      throw new MailFilesError('invalid')
    }
    const pragma = /^pragma\s+table_info\s*\(\s*(\w+)\s*\)$/i.exec(trimmed)
    if (pragma !== null && !TABLES[db].has(pragma[1] ?? '')) throw new MailFilesError('invalid')
    const path =
      db === 'envelope'
        ? join(this.options.mailDir, await this.library(), 'MailData', 'Envelope Index')
        : this.options.accountsDb
    let database: DatabaseSync
    try {
      database = new DatabaseSync(path, { readOnly: true })
    } catch {
      throw new MailFilesError('unavailable')
    }
    try {
      const statement = database.prepare(trimmed)
      return statement.all(...params) as MailRow[]
    } catch {
      throw new MailFilesError('invalid')
    } finally {
      database.close()
    }
  }

  async #inside(path: string): Promise<string> {
    if (path.split('/').some((part) => part === '' || part === '.' || part === '..') && path !== '') {
      throw new MailFilesError('invalid')
    }
    const root = await nodeFs.realpath(join(this.options.mailDir, await this.library()))
    let resolved: string
    try {
      resolved = await nodeFs.realpath(resolve(root, path))
    } catch {
      throw new MailFilesError('not-found')
    }
    const rel = relative(root, resolved)
    if (rel.startsWith('..') || rel.startsWith(sep)) throw new MailFilesError('invalid')
    return resolved
  }

  async file(path: string): Promise<Buffer> {
    const resolved = await this.#inside(path)
    if (!resolved.endsWith('.emlx')) throw new MailFilesError('invalid')
    try {
      return await nodeFs.readFile(resolved)
    } catch {
      throw new MailFilesError('not-found')
    }
  }

  async list(path: string): Promise<readonly ListEntry[]> {
    const resolved = await this.#inside(path)
    try {
      const entries = await nodeFs.readdir(resolved, { withFileTypes: true })
      return entries
        .filter((e) => e.isDirectory() || e.isFile())
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch {
      throw new MailFilesError('not-found')
    }
  }

  async spotlight(term: string): Promise<readonly string[]> {
    if (this.options.spotlight === undefined) return []
    return this.options.spotlight(term, await this.library())
  }
}
