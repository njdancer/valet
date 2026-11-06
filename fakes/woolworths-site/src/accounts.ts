// Accounts and visitor sessions. Every visitor carries an httpOnly `wow-auth-token`, logged in or
// not, as the live site does; whether it is logged in is server-side state behind the token. The
// token is replaced on every change of login state so a pre-login token never becomes a logged-in one.

import { randomBytes } from 'node:crypto'
import type { Trolley } from './trolley'

export const SESSION_COOKIE = 'wow-auth-token'
export const DEVICE_COOKIE = 'wow-remembered-device'
/** How long "remember this device" skips the one-time code, in seconds. */
export const DEVICE_COOKIE_MAX_AGE = 90 * 24 * 60 * 60
/** Wrong one-time codes allowed before the half-finished login is thrown away. */
export const MAX_VERIFY_FAILURES = 3

export interface FakeAccount {
  readonly username: string
  readonly password: string
  /** When set, the account has 2FA and this is the code it accepts. */
  readonly otpCode?: string
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
  /** Set between a correct password and a correct one-time code. */
  readonly pendingUsername: string | null
  verifyFailures: number
  /** An anonymous visitor's own trolley. Logged-in visitors use their account's. */
  readonly trolley: Trolley
}

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

export class AccountStore {
  private readonly accounts = new Map<string, AccountState>()
  private readonly visitors = new Map<string, Visitor>()
  /** Device token to the username it was remembered for. */
  private readonly devices = new Map<string, string>()

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
  startVisitor(
    state: { readonly username?: string; readonly pendingUsername?: string } = {},
    replacing?: Visitor,
  ): Visitor {
    if (replacing !== undefined) this.visitors.delete(replacing.token)
    const visitor: Visitor = {
      token: newToken(),
      username: state.username ?? null,
      pendingUsername: state.pendingUsername ?? null,
      verifyFailures: 0,
      trolley: new Map(),
    }
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

  rememberDevice(username: string): string {
    const token = newToken()
    this.devices.set(token, username)
    return token
  }

  deviceRemembered(deviceToken: string | undefined, username: string): boolean {
    return deviceToken !== undefined && this.devices.get(deviceToken) === username
  }

  /** Logs every visitor out, as if the site expired all sessions. Remembered devices survive. */
  expireSessions(): void {
    this.visitors.clear()
  }
}
