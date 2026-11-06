// Fakes for the interpreter's other effects. None of them touches 1Password, Messages or a clock.

import {
  type AuditEvent,
  type AuditRecord,
  type AuditSink,
  CredentialError,
  type CredentialProvider,
  type FetchResult,
  type Grant,
  type GrantStore,
  type MessagesOtpQuery,
  type OtpReader,
  type SecretField,
  SecretValue,
} from '@siteadapter/core'
import type { AuthProbe } from '../src/types'
import type { UrlPatternMatcher } from '../src/url-matcher'
import type { FakeAuthPage } from './fake-auth-page'

/** Thrown by FakeClock when the code under test has slept too often or too long. Tests only. */
export class RunawayLoop extends Error {
  constructor(reason: string) {
    super(`runaway loop: ${reason}`)
    this.name = 'RunawayLoop'
  }
}

/**
 * A clock that only moves when the code under test sleeps. It gives up after too many sleeps, or
 * too much fake time, so that a broken deadline check fails its test instead of spinning the suite
 * in microtasks forever, where vitest's timeout timer would never get to fire.
 */
export class FakeClock {
  static readonly MAX_SLEEPS = 10_000
  /** Well past any flow budget a test sets. */
  static readonly MAX_ELAPSED_MS = 24 * 60 * 60 * 1000

  readonly sleeps: number[] = []
  /** Runs after each sleep, for tests that change the page while the interpreter waits. */
  onSleep: (() => void) | null = null
  /** Set once a sleep has been refused, in case the code under test swallows the error. */
  runaway = false
  private readonly startedAt: number

  constructor(public now: number) {
    this.startedAt = now
  }

  readonly clock = (): Date => new Date(this.now)

  readonly sleep = async (ms: number): Promise<void> => {
    if (this.sleeps.length >= FakeClock.MAX_SLEEPS) this.refuse(`more than ${FakeClock.MAX_SLEEPS} sleeps`)
    if (!Number.isFinite(ms) || ms < 0) this.refuse(`sleep(${ms})`)
    if (this.now + ms - this.startedAt > FakeClock.MAX_ELAPSED_MS) this.refuse('a day of fake time')
    this.sleeps.push(ms)
    this.now += ms
    this.onSleep?.()
  }

  private refuse(reason: string): never {
    this.runaway = true
    throw new RunawayLoop(reason)
  }
}

export class FakeGrantStore implements GrantStore {
  constructor(readonly grants: Grant[]) {}

  async find(adapterId: string, adapterHash: string, secret: string): Promise<Grant | null> {
    return (
      this.grants.find(
        (g) => g.adapterId === adapterId && g.adapterHash === adapterHash && g.secret === secret,
      ) ?? null
    )
  }

  async list(): Promise<readonly Grant[]> {
    return this.grants
  }

  async put(grant: Grant): Promise<void> {
    this.grants.push(grant)
  }

  async revoke(adapterId: string, secret: string): Promise<void> {
    const index = this.grants.findIndex((g) => g.adapterId === adapterId && g.secret === secret)
    if (index >= 0) this.grants.splice(index, 1)
  }
}

export class FakeProvider implements CredentialProvider {
  readonly kind = 'fake' as const
  readonly calls: { itemRef: string; field: SecretField }[] = []
  /** Every value handed out, so tests can check each one was disposed. */
  readonly issued: SecretValue[] = []
  /** Runs before resolving, for tests where the page moves while the person approves Touch ID. */
  beforeResolve: (() => void) | null = null

  constructor(readonly items: Record<string, Partial<Record<SecretField, string>>>) {}

  async resolve(itemRef: string, field: SecretField): Promise<SecretValue> {
    this.calls.push({ itemRef, field })
    this.beforeResolve?.()
    const item = this.items[itemRef]
    if (item === undefined) throw new CredentialError('not-found')
    const value = item[field]
    if (value === undefined) throw new CredentialError('field-missing')
    const secret = SecretValue.fromString(value)
    this.issued.push(secret)
    return secret
  }
}

export interface FakeMessage {
  readonly at: number
  readonly sender: string
  readonly body: string
}

/**
 * Behaves as the Messages reader is specified to: the newest message that has arrived by now, from
 * the sender, matching the pattern, no older than maxAge and not before `notBefore`.
 */
export class FakeOtpReader implements OtpReader {
  readonly calls: { query: MessagesOtpQuery; notBefore: Date }[] = []
  readonly issued: SecretValue[] = []
  failWith: CredentialError | null = null
  /** Runs before each read, for tests where the page moves while the reader looks for a code. */
  beforeRead: (() => void) | null = null

  constructor(
    readonly clock: FakeClock,
    readonly messages: FakeMessage[],
  ) {}

  async latest(query: MessagesOtpQuery, notBefore: Date): Promise<SecretValue> {
    this.calls.push({ query, notBefore })
    this.beforeRead?.()
    if (this.failWith !== null) throw this.failWith
    const pattern = new RegExp(query.pattern)
    const candidates = this.messages
      .filter((m) => m.at <= this.clock.now)
      .filter((m) => m.at >= notBefore.getTime())
      .filter((m) => m.at >= this.clock.now - query.maxAgeSeconds * 1000)
      .filter((m) => m.sender === query.sender)
      .sort((a, b) => b.at - a.at)
    for (const message of candidates) {
      const match = pattern.exec(message.body)
      if (match !== null) {
        const secret = SecretValue.fromString(match[1] ?? match[0])
        this.issued.push(secret)
        return secret
      }
    }
    throw new CredentialError('not-found')
  }
}

/**
 * The auth partition's probe hook. By default it reads the fake page's cookie jar, and answers a
 * fetch with whatever `respond` returns. Tests replace either to script what the site says.
 */
export class FakeProbe implements AuthProbe {
  readonly fetched: string[] = []
  readonly cookieQueries: (readonly string[])[] = []
  cookies: () => readonly string[]
  respond: (url: string) => FetchResult = () => ({ status: 404, contentType: null, body: null })

  constructor(page: FakeAuthPage) {
    this.cookies = () => [...page.cookies]
  }

  /** How many times the flow asked, by either route. */
  get calls(): number {
    return this.fetched.length + this.cookieQueries.length
  }

  async fetch(url: string): Promise<FetchResult> {
    this.fetched.push(url)
    return this.respond(url)
  }

  async cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]> {
    this.cookieQueries.push(cookieDomains)
    return this.cookies()
  }
}

export class RecordingAudit implements AuditSink {
  readonly events: AuditEvent[] = []
  /** When set, appending an event of this type throws. */
  failOn: AuditEvent['type'] | null = null

  async append(event: AuditEvent): Promise<AuditRecord> {
    if (event.type === this.failOn) throw new Error('audit log unavailable')
    this.events.push(event)
    return { seq: this.events.length, at: '2026-11-07T00:00:00.000Z', event, prev: '', hash: '' }
  }
}

/**
 * Runs urlRegex patterns on this thread, so flow tests stay deterministic and quick. The real
 * matcher runs them in a worker under a deadline; url-matcher.test.ts tests that one.
 */
export class InProcessUrlMatcher implements UrlPatternMatcher {
  readonly tests: { pattern: string; text: string }[] = []
  closed = false

  async test(pattern: string, text: string): Promise<boolean> {
    this.tests.push({ pattern, text })
    return new RegExp(pattern).test(text)
  }

  close(): void {
    this.closed = true
  }
}
