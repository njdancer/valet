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
}

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

export class AccountStore {
  private readonly accounts = new Map<string, AccountState>()
  private readonly visitors = new Map<string, Visitor>()

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
    return state !== undefined && state.account.password === password ? state : null
  }

  visitor(token: string | undefined): Visitor | null {
    return token === undefined ? null : (this.visitors.get(token) ?? null)
  }

  /** Starts a new visitor session, discarding `replacing` if given. */
  startVisitor(username: string | null = null, replacing?: Visitor): Visitor {
    if (replacing !== undefined) this.visitors.delete(replacing.token)
    const visitor: Visitor = { token: newToken(), username, trolley: new Map() }
    this.visitors.set(visitor.token, visitor)
    return visitor
  }

  trolleyOf(visitor: Visitor): Trolley {
    if (visitor.username === null) return visitor.trolley
    return this.accounts.get(visitor.username)?.trolley ?? visitor.trolley
  }

  firstNameOf(visitor: Visitor): string | null {
    if (visitor.username === null) return null
    return this.accounts.get(visitor.username)?.account.firstName ?? 'Shopper'
  }

  /** Logs every www visitor out, as if the site expired all sessions. Auth0's sessions survive. */
  expireSessions(): void {
    this.visitors.clear()
  }
}
