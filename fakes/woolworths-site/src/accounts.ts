// Accounts and www visitor sessions. Every visitor carries an httpOnly `wow-auth-token`, logged in
// or not, as the live site does; whether it is logged in is server-side state behind the token. The
// token is replaced on every change of login state so a pre-login token never becomes a logged-in one.
// Signing in itself happens on the separate auth origin (auth-server.ts), as on the live site.

import { randomBytes } from 'node:crypto'
import type { Trolley } from './trolley'

export const SESSION_COOKIE = 'wow-auth-token'

/** How an account's second factor reaches the person, as Auth0's challenge pages name them. */
export type MfaChannel = 'sms' | 'email' | 'otp'

export interface FakeAccount {
  readonly username: string
  readonly password: string
  /** When set, the account has MFA and this is the code it accepts. */
  readonly otpCode?: string
  /** Which challenge page asks for the code. Defaults to `sms`. */
  readonly mfa?: MfaChannel
  /** Auth0 has blocked the account: the right password is refused with a "blocked" error. */
  readonly blocked?: boolean
  /** Shown in the bootstrap response and the page header. Defaults to "Shopper". */
  readonly firstName?: string
}

export interface AccountState {
  readonly account: FakeAccount
  readonly trolley: Trolley
}

export interface Visitor {
  readonly token: string
  /** Set once logged in. */
  readonly username: string | null
  /** An anonymous visitor's own trolley. Logged-in visitors use their account's. */
  readonly trolley: Trolley
  /**
   * The pick-up store this session chose, by its address id. It belongs to the session, not the
   * account (assumed: README), so a login, which starts a new session, starts without one.
   */
  readonly fulfilment: { addressId: number | null }
}

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

export class AccountStore {
  private readonly accounts = new Map<string, AccountState>()
  private readonly visitors = new Map<string, Visitor>()
  /** Tokens of logged-in sessions that expireSessions() ended. */
  private readonly expired = new Set<string>()
  /** While true, every password is wrong, as if the person had changed theirs elsewhere. */
  passwordsRejected = false

  constructor(accounts: readonly FakeAccount[]) {
    for (const account of accounts) {
      if (this.accounts.has(account.username)) throw new Error('duplicate fake account')
      this.accounts.set(account.username, { account, trolley: new Map() })
    }
  }

  account(username: string): AccountState | null {
    return this.accounts.get(username) ?? null
  }

  /** The account whose username and password both match exactly, or null. */
  authenticate(username: string, password: string): AccountState | null {
    const state = this.accounts.get(username)
    if (this.passwordsRejected) return null
    return state !== undefined && state.account.password === password ? state : null
  }

  visitor(token: string | undefined): Visitor | null {
    return token === undefined ? null : (this.visitors.get(token) ?? null)
  }

  /** Starts a new visitor session, discarding `replacing` if given. */
  startVisitor(username: string | null = null, replacing?: Visitor): Visitor {
    if (replacing !== undefined) this.visitors.delete(replacing.token)
    const visitor: Visitor = { token: newToken(), username, trolley: new Map(), fulfilment: { addressId: null } }
    this.visitors.set(visitor.token, visitor)
    return visitor
  }

  trolleyOf(visitor: Visitor): Trolley {
    if (visitor.username === null) return visitor.trolley
    return this.accounts.get(visitor.username)?.trolley ?? visitor.trolley
  }

  /** The pick-up address ids of the sessions now logged in to `username`, oldest first. */
  pickupAddressesOf(username: string): (number | null)[] {
    return [...this.visitors.values()].filter((v) => v.username === username).map((v) => v.fulfilment.addressId)
  }

  /** The pick-up address ids of the anonymous sessions, oldest first. */
  anonymousPickupAddresses(): (number | null)[] {
    return [...this.visitors.values()].filter((v) => v.username === null).map((v) => v.fulfilment.addressId)
  }

  firstNameOf(visitor: Visitor): string | null {
    if (visitor.username === null) return null
    return this.accounts.get(visitor.username)?.account.firstName ?? 'Shopper'
  }

  /** Logs every www visitor out, as if the site expired all sessions. Auth0's sessions survive. */
  expireSessions(): void {
    for (const visitor of this.visitors.values()) {
      if (visitor.username !== null) this.expired.add(visitor.token)
    }
    this.visitors.clear()
  }

  /** Whether `token` was a logged-in session that expireSessions() ended. */
  wasExpired(token: string | undefined): boolean {
    return token !== undefined && this.expired.has(token)
  }
}
