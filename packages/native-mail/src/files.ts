// How Valet reaches Mail's files. Only a process with Full Disk Access can open them, which in the
// app is the reader helper alone (swift-bridge, MailAccess.swift), over its socket. Tests, and the
// fixture library CI builds, use DirectMailFiles on a folder this process can read. Both answer the
// same five questions with the same refusals. DirectMailFiles is in direct-files.ts, which the app
// never imports.

import * as nodeFs from 'node:fs/promises'
import { createConnection } from 'node:net'

export type MailValue = string | number | null
export type MailRow = Readonly<Record<string, MailValue>>
export type MailDb = 'envelope' | 'accounts'

export type MailFilesFailure = 'invalid' | 'not-found' | 'unavailable' | 'too-large'

export class MailFilesError extends Error {
  constructor(readonly code: MailFilesFailure) {
    super(`mail files: ${code}`)
    this.name = 'MailFilesError'
  }
}

export interface ListEntry {
  readonly name: string
  readonly dir: boolean
}

export interface MailFiles {
  /** The library folder in use, e.g. "V10". */
  library(): Promise<string>
  query(db: MailDb, sql: string, params: readonly MailValue[]): Promise<readonly MailRow[]>
  /** One .emlx file, by its path inside the library. */
  file(path: string): Promise<Buffer>
  list(path: string): Promise<readonly ListEntry[]>
  /** The .emlx files Spotlight finds for a word, as paths inside the library. */
  spotlight(term: string): Promise<readonly string[]>
}

// ---------- Through the reader helper ----------

/** The part of a net.Socket this module uses. */
export interface SocketLike {
  write(data: string): unknown
  on(event: 'connect', listener: () => void): unknown
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
  destroy(): unknown
}

export type Connector = (path: string) => SocketLike

export interface HelperMailFilesOptions {
  readonly socketPath: string
  readonly connect?: Connector
  readonly lstat?: (path: string) => Promise<{ isSocket(): boolean; readonly uid: number }>
  readonly uid?: number
  readonly timeoutMs?: number
}

/** A file is at most 25 MB, sent as base64. */
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const FAILURES: ReadonlySet<string> = new Set(['invalid', 'not-found', 'unavailable', 'too-large'])

export class HelperMailFiles implements MailFiles {
  readonly #socketPath: string
  readonly #connect: Connector
  readonly #lstat: NonNullable<HelperMailFilesOptions['lstat']>
  readonly #uid: number | undefined
  readonly #timeoutMs: number

  constructor(options: HelperMailFilesOptions) {
    this.#socketPath = options.socketPath
    this.#connect = options.connect ?? ((path) => createConnection({ path }))
    this.#lstat = options.lstat ?? ((path) => nodeFs.lstat(path))
    this.#uid = options.uid ?? process.getuid?.()
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async library(): Promise<string> {
    const answer = await this.#ask({ op: 'mail.info' })
    const library = answer['library']
    if (typeof library !== 'string' || !/^V\d{1,3}$/.test(library)) throw new MailFilesError('unavailable')
    return library
  }

  async query(db: MailDb, sql: string, params: readonly MailValue[]): Promise<readonly MailRow[]> {
    const answer = await this.#ask({ op: 'mail.query', db, sql, params })
    const columns = answer['columns']
    const rows = answer['rows']
    if (!Array.isArray(columns) || !Array.isArray(rows) || !columns.every((c) => typeof c === 'string')) {
      throw new MailFilesError('unavailable')
    }
    return rows.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new MailFilesError('unavailable')
      const out: Record<string, MailValue> = {}
      columns.forEach((name: string, i) => {
        const value: unknown = row[i]
        out[name] = typeof value === 'string' || typeof value === 'number' ? value : null
      })
      return out
    })
  }

  async file(path: string): Promise<Buffer> {
    const answer = await this.#ask({ op: 'mail.file', path })
    const data = answer['base64']
    if (typeof data !== 'string') throw new MailFilesError('unavailable')
    return Buffer.from(data, 'base64')
  }

  async list(path: string): Promise<readonly ListEntry[]> {
    const answer = await this.#ask({ op: 'mail.list', path })
    const entries = answer['entries']
    if (!Array.isArray(entries)) throw new MailFilesError('unavailable')
    return entries.flatMap((e: unknown) => {
      if (typeof e !== 'object' || e === null) return []
      const { name, dir } = e as { name?: unknown; dir?: unknown }
      return typeof name === 'string' && typeof dir === 'boolean' ? [{ name, dir }] : []
    })
  }

  async spotlight(term: string): Promise<readonly string[]> {
    const answer = await this.#ask({ op: 'mail.spotlight', term })
    const paths = answer['paths']
    if (!Array.isArray(paths)) throw new MailFilesError('unavailable')
    return paths.filter((p): p is string => typeof p === 'string')
  }

  async #ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const info = await this.#lstat(this.#socketPath)
      if (!info.isSocket() || (this.#uid !== undefined && info.uid !== this.#uid)) {
        throw new MailFilesError('unavailable')
      }
    } catch {
      // Not installed, not allowed in Login Items, or not running yet.
      throw new MailFilesError('unavailable')
    }
    const raw = await this.#send(`${JSON.stringify({ v: 1, ...request })}\n`)
    let answer: unknown
    try {
      answer = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new MailFilesError('unavailable')
    }
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
      throw new MailFilesError('unavailable')
    }
    const error = (answer as Record<string, unknown>)['error']
    if (typeof error === 'string') {
      throw new MailFilesError(FAILURES.has(error) ? (error as MailFilesFailure) : 'unavailable')
    }
    return answer as Record<string, unknown>
  }

  #send(line: string): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      let socket: SocketLike | null = null
      const finish = (outcome: Buffer | MailFilesError): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket?.destroy()
        if (outcome instanceof MailFilesError) reject(outcome)
        else resolvePromise(outcome)
      }
      const timer = setTimeout(() => finish(new MailFilesError('unavailable')), this.#timeoutMs)
      try {
        socket = this.#connect(this.#socketPath)
      } catch {
        finish(new MailFilesError('unavailable'))
        return
      }
      socket.on('connect', () => socket?.write(line))
      socket.on('data', (chunk) => {
        if (settled) return
        const newline = chunk.indexOf(0x0a)
        const part = newline < 0 ? chunk : chunk.subarray(0, newline)
        size += part.length
        if (size > MAX_RESPONSE_BYTES) return finish(new MailFilesError('too-large'))
        chunks.push(part)
        if (newline >= 0) finish(Buffer.concat(chunks))
      })
      socket.on('error', () => finish(new MailFilesError('unavailable')))
      socket.on('close', () => {
        if (chunks.length > 0) finish(Buffer.concat(chunks))
        else finish(new MailFilesError('unavailable'))
      })
    })
  }
}
