// Reads SMS one-time codes through the Messages helper (D8): a launch agent, registered with
// SMAppService, that alone holds Full Disk Access (swift-bridge/Sources/valet-messages-helper).
// Valet itself then needs no Full Disk Access, so neither does any process that inherits from it.
//
// The checks before the question are the in-process reader's (prepareOtpLookup): the grant, one
// exact sender, a screened pattern. The helper answers one question per connection on a Unix socket
// only this user can reach: the newest code-shaped capture from that handle since a time. The answer
// is re-checked here for shape before it becomes a SecretValue.

import * as nodeFs from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialError,
  type Grant,
  type MessagesOtpQuery,
  type OtpReader,
  SecretValue,
  ValetError,
} from '@valet/core'
import { isCodeShaped, prepareOtpLookup } from './messages-otp'
import { nodeTimers, type Timers } from './process'

/** The helper looks no further back than this (Messages.swift's maxLookbackMs). */
export const HELPER_MAX_LOOKBACK_MS = 30 * 60_000

/** The socket the agent with this launchd label listens on (valet-messages-helper's serve). */
export function messagesHelperSocketPath(label: string, home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', label, 'helper.sock')
}

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

export const nodeConnector: Connector = (path) => createConnection({ path })

/** The file facts used to check the socket before connecting. */
export type SocketFiles = Pick<typeof nodeFs, 'lstat'>

export interface MessagesHelperOtpReaderOptions {
  readonly socketPath: string
  readonly connect?: Connector
  readonly files?: SocketFiles
  readonly now?: () => Date
  readonly timers?: Timers
  /** Covers connecting, the helper's lookup and its deadline on the match. */
  readonly timeoutMs?: number
  /** Refuse every lookup that doesn't come with the messages grant for its sender. Default false. */
  readonly requireGrant?: boolean
  readonly uid?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 4 * 1024

export class MessagesHelperOtpReader implements OtpReader {
  readonly #socketPath: string
  readonly #connect: Connector
  readonly #files: SocketFiles
  readonly #now: () => Date
  readonly #timers: Timers
  readonly #timeoutMs: number
  readonly #requireGrant: boolean
  readonly #uid: number | undefined

  constructor(options: MessagesHelperOtpReaderOptions) {
    this.#socketPath = options.socketPath
    this.#connect = options.connect ?? nodeConnector
    this.#files = options.files ?? nodeFs
    this.#now = options.now ?? (() => new Date())
    this.#timers = options.timers ?? nodeTimers
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#requireGrant = options.requireGrant ?? false
    this.#uid = options.uid ?? process.getuid?.()
  }

  /** As MessagesOtpReader.latest, answered by the helper. */
  async latest(query: MessagesOtpQuery, notBefore: Date, grant?: Grant): Promise<SecretValue> {
    const now = this.#now()
    const { sender, sinceMs } = prepareOtpLookup(query, notBefore, now, grant, this.#requireGrant)
    const request = {
      v: 1,
      handle: sender.handle,
      services: sender.services,
      pattern: query.pattern,
      sinceMs: Math.ceil(Math.min(now.getTime(), Math.max(sinceMs, now.getTime() - HELPER_MAX_LOOKBACK_MS))),
    }
    await this.#checkSocket()
    const response = await this.#ask(`${JSON.stringify(request)}\n`)
    return answerOf(response)
  }

  /** Only a socket this user owns: another account can't stand in for the helper. */
  async #checkSocket(): Promise<void> {
    let info: Awaited<ReturnType<SocketFiles['lstat']>>
    try {
      info = await this.#files.lstat(this.#socketPath)
    } catch {
      // Not registered, not approved in Login Items, or not running yet.
      throw new CredentialError('unavailable')
    }
    if (!info.isSocket() || (this.#uid !== undefined && info.uid !== this.#uid)) {
      throw new CredentialError('unavailable')
    }
  }

  #ask(line: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      let socket: SocketLike
      const finish = (outcome: Buffer | null): void => {
        if (settled) return
        settled = true
        this.#timers.clearTimeout(timer)
        socket.destroy()
        if (outcome === null) {
          for (const chunk of chunks) chunk.fill(0)
          reject(new CredentialError('unavailable'))
        } else {
          resolve(outcome)
        }
      }
      const timer = this.#timers.setTimeout(() => finish(null), this.#timeoutMs)
      try {
        socket = this.#connect(this.#socketPath)
      } catch {
        this.#timers.clearTimeout(timer)
        reject(new CredentialError('unavailable'))
        return
      }
      socket.on('connect', () => socket.write(line))
      socket.on('data', (chunk) => {
        if (settled) {
          chunk.fill(0)
          return
        }
        chunks.push(chunk)
        size += chunk.length
        const joined = Buffer.concat(chunks)
        const newline = joined.indexOf(0x0a)
        if (newline >= 0) {
          for (const part of chunks) part.fill(0)
          const answer = Buffer.from(joined.subarray(0, newline))
          joined.fill(0)
          finish(answer)
        } else if (size > MAX_RESPONSE_BYTES) {
          joined.fill(0)
          finish(null)
        } else {
          joined.fill(0)
        }
      })
      socket.on('error', () => finish(null))
      socket.on('close', () => finish(null))
    })
  }
}

/** The helper's answer line as a code, or the failure it reports. Zeroes `line`. */
function answerOf(line: Buffer): SecretValue {
  let parsed: unknown
  try {
    parsed = JSON.parse(line.toString('utf8'))
  } catch {
    parsed = null
  } finally {
    line.fill(0)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CredentialError('unavailable')
  const { code, error } = parsed as { code?: unknown; error?: unknown }
  if (typeof code === 'string') {
    if (!isCodeShaped(code)) throw new CredentialError('not-found')
    return SecretValue.fromString(code)
  }
  if (error === 'not-found') throw new CredentialError('not-found')
  if (error === 'invalid') throw new ValetError('otp', 'invalid')
  throw new CredentialError('unavailable')
}
