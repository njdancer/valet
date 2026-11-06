// What links the two origins during a login. www starts a login with an opaque `state` tied to the
// browser that asked; the auth origin, once the person has signed in, sends that browser back to
// www's callback with a one-time `code` bound to the same state. The callback only logs in when the
// state is pending for that very browser and the code was issued for that state, both unexpired.
// Both are spent by the first attempt, right or wrong, so neither can be replayed.

import { newToken } from './accounts'

/** How long a login may take from www's /auth/login to its callback. */
export const PENDING_LOGIN_TTL_MS = 10 * 60_000
/** How long the authorization code is good for, from the auth origin's redirect to the callback. */
export const CODE_TTL_MS = 60_000

interface PendingLogin {
  readonly visitorToken: string
  readonly path: string
  readonly expiresAt: number
}

interface IssuedCode {
  readonly state: string
  readonly username: string
  readonly expiresAt: number
}

export class LoginBroker {
  private readonly pending = new Map<string, PendingLogin>()
  private readonly codes = new Map<string, IssuedCode>()

  constructor(private readonly now: () => number) {}

  /** Starts a login for the www visitor holding `visitorToken`. Returns the state to send to Auth0. */
  begin(visitorToken: string, path: string): string {
    const state = newToken()
    this.pending.set(state, { visitorToken, path, expiresAt: this.now() + PENDING_LOGIN_TTL_MS })
    return state
  }

  /** Called by the auth origin once `username` has signed in for the login `state`. */
  issueCode(state: string, username: string): string {
    const code = newToken()
    this.codes.set(code, { state, username, expiresAt: this.now() + CODE_TTL_MS })
    return code
  }

  /**
   * Spends `state` and `code`, and returns who logged in and where to go next, or null unless the
   * state is pending for this visitor, the code was issued for that state, and neither has expired.
   */
  complete(state: string, code: string, visitorToken: string): { username: string; path: string } | null {
    const pending = this.pending.get(state)
    const issued = this.codes.get(code)
    this.pending.delete(state)
    this.codes.delete(code)
    const now = this.now()
    if (pending === undefined || issued === undefined) return null
    if (pending.visitorToken !== visitorToken || issued.state !== state) return null
    if (now >= pending.expiresAt || now >= issued.expiresAt) return null
    return { username: issued.username, path: pending.path }
  }
}
