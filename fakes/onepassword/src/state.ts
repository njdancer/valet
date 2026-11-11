// The fake 1Password's state: one account, its vaults and items, the service accounts that can read
// some of those vaults, and the desktop app's side of things: whether it is locked, whether
// "Integrate with other apps" is on, the approvals it has given and the prompts waiting on the
// person. The SDK (sdk.ts), the CLI (cli.ts) and the app's windows (app-server.ts) all work on one
// FakeOnePassword, so what the person does in the fake's window is what the SDK sees.
//
// Everything here is test data. Nothing reaches a real 1Password.

import { EventEmitter } from 'node:events'
import { totp } from './totp'

export interface FakeAccount {
  /** The name the app shows at the top of its sidebar, which DesktopAuth may be given. */
  readonly name: string
  /** The account's UUID, which DesktopAuth may be given instead. */
  readonly uuid: string
  readonly email: string
  /** What unlocks the fake app. A test value. */
  readonly unlockPassword: string
}

export interface FakeVault {
  readonly id: string
  readonly title: string
}

export interface FakeItemInit {
  readonly id: string
  readonly vaultId: string
  readonly title: string
  readonly username?: string
  readonly password?: string
  /** A base32 TOTP secret: the item then has a one-time password field. */
  readonly totpSecret?: string
  readonly websites?: readonly string[]
  readonly archived?: boolean
  readonly updatedAt?: string
}

export interface FakeItem {
  readonly id: string
  readonly vaultId: string
  title: string
  username: string | undefined
  password: string | undefined
  totpSecret: string | undefined
  readonly websites: readonly string[]
  archived: boolean
  readonly createdAt: Date
  updatedAt: Date
}

export interface FakeServiceAccount {
  /** The token, as 1Password shows it once: `ops_` and then base64. */
  readonly token: string
  /** The vaults (by id) it was given read access to. */
  readonly vaultIds: readonly string[]
  /** Set when the token was revoked: it is then refused. */
  revoked?: boolean
}

/** Who is asking the person, and for what. */
export type PromptKind = 'sdk' | 'cli'

export interface Prompt {
  readonly id: string
  readonly kind: PromptKind
  /** The integration that asked: the SDK's integrationName, or `op` for the CLI. */
  readonly integration: string
  readonly integrationVersion: string
  readonly account: string
  readonly requestedAt: number
  state: 'pending' | 'allowed' | 'denied'
}

/** One call Valet made, for tests: never a field value. */
export interface FakeCall {
  readonly via: 'sdk' | 'cli'
  readonly auth: 'service-account' | 'desktop'
  readonly op: 'createClient' | 'secrets.resolve' | 'vaults.list' | 'items.list' | 'read' | 'item list'
  readonly target?: string
}

export interface FakeOnePasswordOptions {
  readonly account: FakeAccount
  readonly vaults: readonly FakeVault[]
  readonly items: readonly FakeItemInit[]
  readonly serviceAccounts?: readonly FakeServiceAccount[]
  /** The app starts locked unless this is false. */
  readonly locked?: boolean
  /** "Integrate with other apps" in the app's Developer settings. On unless this is false. */
  readonly integrationEnabled?: boolean
  /** Every prompt is allowed at once (unlocking first), for tests that don't drive the window. */
  readonly autoApprove?: boolean
  /** An approval lapses after this many idle minutes, as 1Password's does. */
  readonly idleMinutes?: number
  /** Requests a service account may make in a day before it is rate limited (1Password: 1,000). */
  readonly serviceAccountDailyLimit?: number
  readonly now?: () => number
}

/** The SDK's DesktopSessionExpiredError, by class name: what Valet's classifier looks at. */
export class DesktopSessionExpiredError extends Error {}
export class AuthExpiredError extends Error {}
export class RateLimitExceededError extends Error {}

export interface FakeEvents {
  prompt: [Prompt]
  settled: [Prompt]
  change: []
}

const DAY_MS = 24 * 60 * 60_000

export class FakeOnePassword extends EventEmitter<FakeEvents> {
  readonly account: FakeAccount
  readonly vaults: readonly FakeVault[]
  readonly items: FakeItem[]
  readonly serviceAccounts: FakeServiceAccount[]
  readonly calls: FakeCall[] = []
  readonly prompts: Prompt[] = []
  readonly now: () => number
  locked: boolean
  integrationEnabled: boolean
  autoApprove: boolean
  readonly idleMs: number
  readonly #dailyLimit: number
  // Desktop approvals by `<integration>`, with when each was last used.
  readonly #sessions = new Map<string, number>()
  readonly #waiting = new Map<string, (allowed: boolean) => void>()
  readonly #serviceAccountUse = new Map<string, number[]>()
  #nextPrompt = 1

  constructor(options: FakeOnePasswordOptions) {
    super()
    this.account = options.account
    this.vaults = options.vaults
    this.now = options.now ?? Date.now
    this.items = options.items.map((item) => {
      const at = new Date(item.updatedAt ?? this.now())
      return {
        id: item.id,
        vaultId: item.vaultId,
        title: item.title,
        username: item.username,
        password: item.password,
        totpSecret: item.totpSecret,
        websites: item.websites ?? [],
        archived: item.archived === true,
        createdAt: at,
        updatedAt: at,
      }
    })
    this.serviceAccounts = [...(options.serviceAccounts ?? [])]
    this.locked = options.locked !== false
    this.integrationEnabled = options.integrationEnabled !== false
    this.autoApprove = options.autoApprove === true
    this.idleMs = (options.idleMinutes ?? 10) * 60_000
    this.#dailyLimit = options.serviceAccountDailyLimit ?? 1000
  }

  // ── The person, in the app ──────────────────────────────────────────────────────────────────

  /** Unlocks with the account's password. False, and still locked, for anything else. */
  unlock(password: string): boolean {
    if (password !== this.account.unlockPassword) return false
    this.locked = false
    this.emit('change')
    return true
  }

  /** Locks the app, which ends every approval it gave (as 1Password's lock does). */
  lock(): void {
    this.locked = true
    this.#sessions.clear()
    this.emit('change')
  }

  setIntegration(enabled: boolean): void {
    this.integrationEnabled = enabled
    if (!enabled) this.#sessions.clear()
    this.emit('change')
  }

  /** Allows a pending prompt. Refused (false) while the app is locked. */
  allow(id: string): boolean {
    if (this.locked) return false
    return this.#settle(id, true)
  }

  deny(id: string): boolean {
    return this.#settle(id, false)
  }

  pending(): Prompt[] {
    return this.prompts.filter((p) => p.state === 'pending')
  }

  /** Changes an item, as the person editing it in the app would: its updatedAt moves on. */
  updateItem(
    id: string,
    change: Partial<Pick<FakeItem, 'title' | 'username' | 'password' | 'archived'>>,
  ): void {
    const item = this.items.find((i) => i.id === id)
    if (item === undefined) throw new Error(`no item ${id}`)
    Object.assign(item, change)
    // At least a millisecond later, so the change shows even within one tick.
    item.updatedAt = new Date(Math.max(this.now(), item.updatedAt.getTime() + 1))
    this.emit('change')
  }

  // ── Integrations ────────────────────────────────────────────────────────────────────────────

  /**
   * What DesktopAuth (and op's app integration) does on first use: the app must be running with
   * the integration on, the account must be signed in, and the person must allow the integration,
   * unlocking first if the app is locked. An approval that is up is reused without asking.
   */
  async authorizeDesktop(
    accountName: string,
    integration: string,
    integrationVersion: string,
    kind: PromptKind,
  ): Promise<void> {
    if (!this.integrationEnabled) throw new Error('the desktop app integration is not enabled')
    if (accountName !== this.account.name && accountName !== this.account.uuid) {
      throw new Error(`no account matching "${accountName}" is signed in to the desktop app`)
    }
    if (this.#sessionLive(integration)) {
      this.#sessions.set(integration, this.now())
      return
    }
    const prompt: Prompt = {
      id: `prompt-${this.#nextPrompt++}`,
      kind,
      integration,
      integrationVersion,
      account: this.account.name,
      requestedAt: this.now(),
      state: 'pending',
    }
    this.prompts.push(prompt)
    const allowed = new Promise<boolean>((resolve) => this.#waiting.set(prompt.id, resolve))
    this.emit('prompt', prompt)
    this.emit('change')
    if (this.autoApprove) {
      this.locked = false
      this.allow(prompt.id)
    }
    if (!(await allowed)) throw new Error('authorization denied by user')
    this.#sessions.set(integration, this.now())
  }

  /** Every call on an approved client: a lapsed or locked approval is DesktopSessionExpiredError. */
  useDesktop(integration: string): void {
    if (!this.#sessionLive(integration)) {
      this.#sessions.delete(integration)
      throw new DesktopSessionExpiredError('desktop session expired')
    }
    this.#sessions.set(integration, this.now())
  }

  /** Whether an approval for `integration` is up. */
  approved(integration: string): boolean {
    return this.#sessionLive(integration)
  }

  /** The service account a token belongs to; throws the SDK's messages for a bad or revoked one. */
  serviceAccount(token: string): FakeServiceAccount {
    if (!token.startsWith('ops_')) {
      throw new Error(
        'invalid service account token, please make sure you provide a valid service account token as parameter',
      )
    }
    const account = this.serviceAccounts.find((s) => s.token === token)
    if (account === undefined) throw new Error('service account deserialization failed')
    if (account.revoked === true) throw new AuthExpiredError('authentication has expired')
    return account
  }

  /** Counts one service-account request against its daily limit. */
  meterServiceAccount(token: string): void {
    this.serviceAccount(token)
    const since = this.now() - DAY_MS
    const used = (this.#serviceAccountUse.get(token) ?? []).filter((at) => at > since)
    if (used.length >= this.#dailyLimit) {
      throw new RateLimitExceededError('rate limit exceeded: too many requests from this service account')
    }
    used.push(this.now())
    this.#serviceAccountUse.set(token, used)
  }

  /** Vaults a caller can see: a service account's own, or every vault for the desktop app. */
  visibleVaults(vaultIds: readonly string[] | 'all'): FakeVault[] {
    return vaultIds === 'all' ? [...this.vaults] : this.vaults.filter((v) => vaultIds.includes(v.id))
  }

  /** A one-time password field's current code. */
  code(item: FakeItem): string | undefined {
    return item.totpSecret === undefined ? undefined : totp(item.totpSecret, this.now())
  }

  record(call: FakeCall): void {
    this.calls.push(call)
  }

  #sessionLive(integration: string): boolean {
    const last = this.#sessions.get(integration)
    return !this.locked && this.integrationEnabled && last !== undefined && this.now() - last <= this.idleMs
  }

  #settle(id: string, allowed: boolean): boolean {
    const prompt = this.prompts.find((p) => p.id === id)
    const resolve = this.#waiting.get(id)
    if (prompt === undefined || resolve === undefined || prompt.state !== 'pending') return false
    prompt.state = allowed ? 'allowed' : 'denied'
    this.#waiting.delete(id)
    resolve(allowed)
    this.emit('settled', prompt)
    this.emit('change')
    return true
  }
}
