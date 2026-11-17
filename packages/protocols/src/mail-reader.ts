// Sign-in links and codes from mail (docs/imap.md#email-sign-in): core's MailReader, run by Valet,
// never by adapter code. Each lookup runs the protocol host's one built-in, read-only operation in
// the mail account the person's grant names, signed in as that account's own protocol adapter (its
// CredentialGate, so the use is audited), through the broker's tunnel to that adapter's endpoint.
//
// A login waits for its mail by asking again every few seconds; one host session per account is
// kept between those asks for a short while, so the server sees one sign-in, not one per ask.

import {
  CredentialError,
  type ImapProtocol,
  type MailAccountRef,
  type MailReader,
  type MailSignInQuery,
  SecretValue,
  ValetError,
} from '@valet/core'
import { type BrokerOptions, EgressBroker, type RunContext, RunMeter } from '@valet/egress'
import { ImapHostSession, type ProtocolHostOptions, type SignInValues } from './host-session'
import { CODE_SHAPE } from './imap/signin'

export interface MailAccount {
  /** The protocol adapter's IMAP settings: its endpoint and folders. INBOX must be allowed. */
  readonly protocol: ImapProtocol
  /** Signs in with that adapter's kept credential, through its CredentialGate. */
  readonly signIn: () => Promise<SignInValues>
  /** Records the connection, as the adapter's own calls are recorded. */
  readonly record?: RunContext['record']
  readonly broker?: BrokerOptions
  /**
   * Whether any tool of the account's adapters may change INBOX (core's mayWriteInbox). Such an
   * account is refused: a write tool could plant a sign-in mail with forged headers.
   */
  readonly mayWriteInbox: boolean
}

export interface HostMailReaderOptions {
  readonly host: ProtocolHostOptions
  /** The account a grant names, or null if Valet holds no such account. */
  readonly account: (ref: MailAccountRef) => Promise<MailAccount | null>
  readonly now?: () => Date
  /** How long a session is kept after its last lookup. Default 30 s. */
  readonly idleMs?: number
  /** The longest one session is used for. Default 10 minutes. */
  readonly maxSessionMs?: number
  /** One lookup's upload budget, its sign-in included. Default 64 KB. */
  readonly uploadBytes?: number
}

interface Live {
  readonly session: Promise<ImapHostSession>
  readonly controller: AbortController
  readonly startedAt: number
  idle: NodeJS.Timeout | null
}

export class HostMailReader implements MailReader {
  private readonly live = new Map<MailAccountRef, Live>()

  constructor(private readonly options: HostMailReaderOptions) {}

  async find(query: MailSignInQuery, notBefore: Date): Promise<SecretValue> {
    const now = this.options.now?.() ?? new Date()
    const live = await this.session(query.account)
    let found: { found: true; value: string } | { found: false }
    try {
      const session = await live.session
      found = await session.signInMail({
        from: query.from,
        ...(query.subjectContains === undefined ? {} : { subjectContains: query.subjectContains }),
        after: notBefore.getTime(),
        now: now.getTime(),
        maxAgeSeconds: query.maxAgeSeconds,
        extract: query.extract,
      })
    } catch (error) {
      this.drop(query.account)
      if (error instanceof ValetError && error.errorClass === 'auth-failed')
        throw new CredentialError('locked')
      throw new CredentialError('unavailable')
    }
    this.keep(query.account, live)
    if (!found.found) throw new CredentialError('not-found')
    // The host is checked like any untrusted source: a code must look like one, a link must be on
    // the origin asked for.
    if ('pattern' in query.extract) {
      if (!CODE_SHAPE.test(found.value)) throw new CredentialError('not-found')
    } else {
      let url: URL | null = null
      try {
        url = new URL(found.value)
      } catch {}
      if (url === null || url.protocol !== 'https:' || url.origin !== query.extract.linkOrigin)
        throw new CredentialError('not-found')
    }
    return SecretValue.fromString(found.value)
  }

  /** Ends every session. */
  close(): void {
    for (const account of [...this.live.keys()]) this.drop(account)
  }

  private async session(ref: MailAccountRef): Promise<Live> {
    // The account is asked for on every lookup, a kept session too: a grant revoked, or an account
    // that may now write INBOX, ends its session before anything more is read.
    const account = await this.options.account(ref).catch(() => null)
    const folders = account?.protocol.folders
    const refusal =
      account === null
        ? new CredentialError('not-found')
        : account.mayWriteInbox !== false ||
            (folders !== undefined && !folders.some((f) => f.toUpperCase() === 'INBOX'))
          ? new CredentialError('unavailable')
          : null
    if (refusal !== null || account === null) {
      this.drop(ref)
      throw refusal ?? new CredentialError('not-found')
    }
    const existing = this.live.get(ref)
    const now = Date.now()
    if (existing !== undefined && now - existing.startedAt < (this.options.maxSessionMs ?? 10 * 60_000)) {
      if (existing.idle !== null) clearTimeout(existing.idle)
      existing.idle = null
      return existing
    }
    if (existing !== undefined) this.drop(ref)
    const controller = new AbortController()
    const broker = new EgressBroker(
      { egress: [], endpoints: [account.protocol.endpoint] },
      account.broker ?? {},
    )
    const run: RunContext = {
      meter: new RunMeter(this.options.uploadBytes ?? 64 * 1024),
      signal: controller.signal,
      record: account.record ?? (() => {}),
    }
    const session = ImapHostSession.start({
      host: this.options.host,
      endpoint: account.protocol.endpoint,
      purpose: 'read',
      folders: ['INBOX'],
      openTunnels: broker.tunnels(run),
      signIn: account.signIn,
      signal: controller.signal,
    })
    session.catch(() => undefined)
    const live: Live = { session, controller, startedAt: now, idle: null }
    this.live.set(ref, live)
    return live
  }

  private keep(ref: MailAccountRef, live: Live): void {
    if (this.live.get(ref) !== live) return
    live.idle = setTimeout(() => this.drop(ref), this.options.idleMs ?? 30_000)
    live.idle.unref?.()
  }

  private drop(ref: MailAccountRef): void {
    const live = this.live.get(ref)
    if (live === undefined) return
    this.live.delete(ref)
    if (live.idle !== null) clearTimeout(live.idle)
    void live.session.then(
      (s) => s.end().finally(() => live.controller.abort()),
      () => live.controller.abort(),
    )
  }
}
