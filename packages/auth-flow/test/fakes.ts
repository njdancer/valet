// Fakes for the interpreter's other effects. None of them touches 1Password, Messages or a clock.

import {
  type AuditEvent,
  type AuditRecord,
  type AuditSink,
  CredentialError,
  type CredentialProvider,
  type Grant,
  type GrantStore,
  type MessagesOtpQuery,
  type OtpReader,
  type SecretField,
  SecretValue,
} from '@siteadapter/core'

/** A clock that only moves when the code under test sleeps. */
export class FakeClock {
  readonly sleeps: number[] = []
  /** Runs after each sleep, for tests that change the page while the interpreter waits. */
  onSleep: (() => void) | null = null

  constructor(public now: number) {}

  readonly clock = (): Date => new Date(this.now)

  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms)
    this.now += ms
    this.onSleep?.()
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

  constructor(
    readonly clock: FakeClock,
    readonly messages: FakeMessage[],
  ) {}

  async latest(query: MessagesOtpQuery, notBefore: Date): Promise<SecretValue> {
    this.calls.push({ query, notBefore })
    if (this.failWith !== null) throw this.failWith
    const pattern = new RegExp(query.pattern)
    const candidates = this.messages
      .filter((m) => m.at <= this.clock.now)
      .filter((m) => m.at >= notBefore.getTime())
      .filter((m) => m.at >= this.clock.now - query.maxAgeSeconds * 1000)
      .filter((m) => query.sender === undefined || m.sender === query.sender)
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
