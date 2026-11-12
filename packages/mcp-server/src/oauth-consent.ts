// Consent requests waiting for the person at their Mac (relay.md, "Consent happens on the Mac").
//
// `/authorize` never decides by itself. It opens a request here and shows the browser that started
// the flow a code. The Mac lists every pending request without its code; the person types the code
// from their own browser, and only the request that code belongs to can be approved. So a request
// someone else started (from their own claude.ai account, against the person's public URL) can't
// be approved by a person who didn't see that someone's browser.
//
// - At most five pending at once, each expiring five minutes after it opened.
// - Three wrong codes cancel every pending request.
// - A request, once answered, stays known to the browser that holds its handle until it expires,
//   so the browser's waiting page can take the person on to the client (or tell them it ended).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { CONSENT_CODE_ALPHABET } from '@valet/core'
import { generateToken } from './token'

export const MAX_PENDING_CONSENTS = 5
/** Ten minutes, as long as an approval waits (APPROVAL_TTL_MS): time to reach a phone. */
export const CONSENT_TTL_MS = 10 * 60_000
export const MAX_WRONG_CODES = 3

/**
 * Letters only, without I or O (core's CONSENT_CODE_ALPHABET), so a phone keyboard needs no
 * switching and nothing is misread.
 */
export const CODE_ALPHABET = CONSENT_CODE_ALPHABET
export const CODE_LENGTH = 8

export type ConsentStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'cancelled'

/** What the authorisation request asked for, checked by /authorize before a request is opened. */
export interface AuthorizationRequest {
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string | null
  readonly codeChallenge: string
  readonly resource: string
}

export interface ConsentRequest extends AuthorizationRequest {
  /** Shown on the Mac and used to decline one request. Not a secret. */
  readonly id: string
  /** The browser's own reference, in its waiting page's URL. Never shown on the Mac. */
  readonly handle: string
  /** Shown in the browser only. Never shown on the Mac, never in a list. */
  readonly code: string
  /** The client's claimed identity: its redirect URI's host. */
  readonly clientHost: string
  readonly clientName: string | null
  /** Where the request came from, as the tunnel reported it; null when unknown. */
  readonly source: string | null
  readonly requestedAt: number
  readonly expiresAt: number
  status: ConsentStatus
  /** The tools the person ticked, once approved. */
  tools: readonly string[]
}

/** A pending request as the Mac shows it: no code and no handle. */
export interface ConsentPrompt {
  readonly id: string
  readonly clientId: string
  readonly clientHost: string
  readonly clientName: string | null
  readonly source: string | null
  readonly requestedAt: number
  readonly expiresAt: number
}

export type ApproveResult =
  | { readonly ok: true; readonly request: ConsentRequest }
  | { readonly ok: false; readonly reason: 'wrong-code' | 'cancelled' }

export interface ConsentRequestsOptions {
  readonly now?: () => number
  readonly newCode?: () => string
  readonly newHandle?: () => string
  readonly newId?: () => string
  /** The pending set changed: a request opened, was answered, or ended. Must not throw. */
  readonly changed?: () => void
  /** A request ended without approval (declined, expired, cancelled), for the audit log. */
  readonly ended?: (request: ConsentRequest) => void
}

export class ConsentRequests {
  private readonly requests = new Map<string, ConsentRequest>()
  private wrongCodes = 0
  private readonly now: () => number
  private readonly newCode: () => string
  private readonly newHandle: () => string
  private readonly newId: () => string

  constructor(private readonly options: ConsentRequestsOptions = {}) {
    this.now = options.now ?? Date.now
    this.newCode = options.newCode ?? (() => generateCode())
    this.newHandle = options.newHandle ?? generateToken
    this.newId = options.newId ?? (() => `cs_${randomBytes(9).toString('base64url')}`)
  }

  /** Opens a request, or null when five are already pending. */
  open(
    request: AuthorizationRequest,
    about: Pick<ConsentRequest, 'clientHost' | 'clientName' | 'source'>,
  ): ConsentRequest | null {
    this.sweep()
    if (this.pending().length >= MAX_PENDING_CONSENTS) return null
    const now = this.now()
    const entry: ConsentRequest = {
      ...request,
      ...about,
      id: this.newId(),
      handle: this.newHandle(),
      code: this.newCode(),
      requestedAt: now,
      expiresAt: now + CONSENT_TTL_MS,
      status: 'pending',
      tools: [],
    }
    this.requests.set(entry.handle, entry)
    this.notify()
    return entry
  }

  /** The request behind a browser's handle, whatever its status; null once expired and gone. */
  byHandle(handle: string): ConsentRequest | null {
    this.sweep()
    return this.requests.get(handle) ?? null
  }

  /** The browser has been sent on: its request is finished with. */
  finish(handle: string): void {
    this.requests.delete(handle)
  }

  /** What the Mac lists: pending requests, oldest first, without codes. */
  prompts(): ConsentPrompt[] {
    this.sweep()
    return this.pending().map((r) => ({
      id: r.id,
      clientId: r.clientId,
      clientHost: r.clientHost,
      clientName: r.clientName,
      source: r.source,
      requestedAt: r.requestedAt,
      expiresAt: r.expiresAt,
    }))
  }

  /**
   * The person typed a code and ticked tools. Only the request the code belongs to is approved.
   * A wrong code counts; the third cancels every pending request.
   */
  /**
   * The pending request a typed code names, as the Mac shows it (no code, no handle), without
   * approving it or counting a wrong code: what the Touch ID prompt for the approval describes.
   */
  matching(typed: string): ConsentPrompt | null {
    this.sweep()
    const code = normaliseCode(typed)
    const match = code === null ? undefined : this.pending().find((r) => codesEqual(r.code, code))
    if (match === undefined) return null
    return {
      id: match.id,
      clientId: match.clientId,
      clientHost: match.clientHost,
      clientName: match.clientName,
      source: match.source,
      requestedAt: match.requestedAt,
      expiresAt: match.expiresAt,
    }
  }

  approve(typed: string, tools: readonly string[]): ApproveResult {
    this.sweep()
    const code = normaliseCode(typed)
    const match = code === null ? undefined : this.pending().find((r) => codesEqual(r.code, code))
    if (match === undefined) {
      this.wrongCodes++
      if (this.wrongCodes < MAX_WRONG_CODES) return { ok: false, reason: 'wrong-code' }
      this.cancelAll('cancelled')
      return { ok: false, reason: 'cancelled' }
    }
    match.status = 'approved'
    match.tools = [...tools]
    this.settled()
    return { ok: true, request: match }
  }

  /** Declines one pending request by its id. False when there's none. */
  decline(id: string): boolean {
    const entry = this.pending().find((r) => r.id === id)
    if (entry === undefined) return false
    this.end(entry, 'declined')
    this.settled()
    return true
  }

  /** Declines every pending request, e.g. when the person closes the window or pauses. */
  declineAll(): number {
    return this.cancelAll('declined')
  }

  private cancelAll(status: 'declined' | 'cancelled'): number {
    const pending = this.pending()
    for (const entry of pending) this.end(entry, status)
    this.settled()
    return pending.length
  }

  private pending(): ConsentRequest[] {
    return [...this.requests.values()].filter((r) => r.status === 'pending')
  }

  private end(entry: ConsentRequest, status: 'declined' | 'expired' | 'cancelled'): void {
    entry.status = status
    try {
      this.options.ended?.(entry)
    } catch {
      // The app's audit is not ours to fail.
    }
  }

  /** Once nothing is pending, wrong codes start counting from zero again. */
  private settled(): void {
    if (this.pending().length === 0) this.wrongCodes = 0
    this.notify()
  }

  private sweep(): void {
    const now = this.now()
    let changed = false
    for (const [handle, entry] of this.requests) {
      if (now < entry.expiresAt) continue
      if (entry.status === 'pending') this.end(entry, 'expired')
      this.requests.delete(handle)
      changed = true
    }
    if (changed) this.settled()
  }

  private notify(): void {
    try {
      this.options.changed?.()
    } catch {
      // As above.
    }
  }
}

/** Eight letters from CODE_ALPHABET, without modulo bias: bytes of 240 and above are drawn again. */
export function generateCode(random: (size: number) => Buffer = randomBytes): string {
  const limit = 256 - (256 % CODE_ALPHABET.length)
  let out = ''
  while (out.length < CODE_LENGTH) {
    for (const byte of random(CODE_LENGTH)) {
      if (byte >= limit || out.length === CODE_LENGTH) continue
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    }
  }
  return out
}

/** A code as the person typed it: case, spaces and dashes ignored. */
export function normaliseCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== CODE_LENGTH) return null
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null
  return code
}

/** The code as the browser shows it: two groups of four. */
export function displayCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function codesEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}
