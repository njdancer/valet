// Valet's own one-time-code lookup from Messages: the code a login types for the person, on the
// same reader as the Messages tools (MessagesStore over MessagesFiles, so in the app over the reader
// helper's socket, which alone has Full Disk Access). It is never an agent's tool and never reaches
// adapter code: the code comes back as a SecretValue for the login's filler.
//
// The checks before anything is read are credentials' (prepareOtpLookup): the grant, one exact
// sender, a screened pattern. Then only incoming messages from that handle over its services since
// the cut-off, and no further back than 30 minutes, are looked at; only those the Messages tools
// would hide as a one-time code (looksLikeCode) count; the adapter's pattern runs in a worker under
// a deadline; and only a code-shaped capture (isCodeShaped) is handed back.

import { CredentialError, type Grant, type MessagesOtpQuery, type OtpReader, SecretValue } from '@valet/core'
import { type PatternMatcher, prepareOtpLookup, WorkerPatternMatcher } from '@valet/credentials'
import { isCodeShaped, looksLikeCode } from './codes'
import type { MessagesFiles } from './files'
import { MessagesStore } from './store'

/** The lookup looks no further back than this, whatever a manifest's maxAgeSeconds says. */
export const OTP_MAX_LOOKBACK_MS = 30 * 60_000

export interface MessagesOtpReaderOptions {
  readonly files: MessagesFiles
  readonly now?: () => Date
  /** How many recent messages from the sender to consider (at most MAX_RECENT). */
  readonly limit?: number
  readonly matcher?: PatternMatcher
  /** Refuse every lookup that doesn't come with the messages grant for its sender. Default false. */
  readonly requireGrant?: boolean
}

export class MessagesOtpReader implements OtpReader {
  readonly #store: MessagesStore
  readonly #now: () => Date
  readonly #limit: number | undefined
  readonly #matcher: PatternMatcher
  readonly #requireGrant: boolean

  constructor(options: MessagesOtpReaderOptions) {
    this.#now = options.now ?? (() => new Date())
    // recentFrom ignores the hidden list and the code rule, so these never apply here.
    this.#store = new MessagesStore(options.files, {
      hidden: () => new Set(),
      hideCodes: () => true,
      now: () => this.#now().getTime(),
    })
    this.#limit = options.limit
    this.#matcher = options.matcher ?? new WorkerPatternMatcher()
    this.#requireGrant = options.requireGrant ?? false
  }

  /**
   * The newest code from `query.sender` since `notBefore`. With `grant`, it must be the messages
   * grant for that sender, or this throws `otp: not-granted` before reading anything.
   */
  async latest(query: MessagesOtpQuery, notBefore: Date, grant?: Grant): Promise<SecretValue> {
    const now = this.#now()
    const { sender, sinceMs } = prepareOtpLookup(query, notBefore, now, grant, this.#requireGrant)
    const since = Math.max(sinceMs, now.getTime() - OTP_MAX_LOOKBACK_MS)
    let texts: string[]
    try {
      texts = await this.#store.recentFrom(
        sender.handle,
        sender.services,
        since,
        this.#limit === undefined ? {} : { limit: this.#limit },
      )
    } catch {
      // No reader, no Full Disk Access, or a chat.db this version can't read.
      throw new CredentialError('unavailable')
    }
    const codes = texts.filter((text) => looksLikeCode(text))
    if (codes.length === 0) throw new CredentialError('not-found')
    // Newest first, so the first code-shaped capture is the newest code.
    const code = (await this.#matcher.captures(query.pattern, codes)).find(
      (capture): capture is string => capture !== null && isCodeShaped(capture),
    )
    if (code === undefined) throw new CredentialError('not-found')
    return SecretValue.fromString(code)
  }
}
