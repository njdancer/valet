// The driver's refusals that happen outside the runtime's own runs, written to the audit log as
// request-blocked: every login page's (partition 'auth'), and the tool partition's between runs
// (partition 'tool', callId null). Inside a run the runtime audits the tool partition's refusals
// itself, through beginRun's reporter.
//
// A report is untrusted: a hostname or path can carry a session value or a secret, put there by
// adapter code or the site. So each target goes through the runtime's own redaction for targets
// (sensitiveMatcher, case-insensitive for session values) against the tool partition's session
// values and the secrets logins registered, and is replaced whole with "[redacted]" on a match. If
// the session values can't be read, the target is withheld rather than written unchecked.

import type {
  AdapterManifest,
  AuditSink,
  AuthPageOptions,
  BlockedRequest,
  SecretValue,
} from '@siteadapter/core'
import { REDACTED, SecretRedactionSet, sensitiveMatcher } from '@siteadapter/runtime'

/** The secret sets kept per adapter: the latest successful login's, and any login still going. */
const MAX_SETS_PER_ADAPTER = 4

/**
 * Clones of the secrets each login registered for redaction, kept per adapter like the runtime
 * keeps its own: a successful login's set replaces the earlier ones; a login that fails before it
 * filled anything is forgotten. A login handed to the person keeps its set beside the earlier one,
 * since what was typed may still come back.
 */
export class LoginSecrets {
  private readonly sets = new Map<string, SecretRedactionSet[]>()

  /** A set for one login. Its secrets count at once; finish() decides whether they stay. */
  begin(adapterId: string): LoginSecretsRun {
    const set = new SecretRedactionSet()
    const sets = this.list(adapterId)
    sets.push(set)
    while (sets.length > MAX_SETS_PER_ADAPTER) sets.shift()?.dispose()
    return {
      register: (secret) => set.register(secret),
      finish: (outcome) => {
        const current = this.list(adapterId)
        if (!current.includes(set)) return
        if (outcome === 'ok') {
          for (const other of current.splice(0)) if (other !== set) other.dispose()
          current.push(set)
        } else if (outcome === 'failed' && set.size === 0) {
          current.splice(current.indexOf(set), 1)
          set.dispose()
        }
      },
    }
  }

  /** True when `text` contains a secret any kept login registered. */
  occursIn(adapterId: string, text: string): boolean {
    return this.list(adapterId).some((set) => set.occursIn(text))
  }

  dispose(): void {
    for (const sets of this.sets.values()) for (const set of sets.splice(0)) set.dispose()
  }

  private list(adapterId: string): SecretRedactionSet[] {
    let sets = this.sets.get(adapterId)
    if (sets === undefined) {
      sets = []
      this.sets.set(adapterId, sets)
    }
    return sets
  }
}

export interface LoginSecretsRun {
  /** Keeps a clone; the caller still owns, and disposes, `secret`. */
  register(secret: SecretValue): void
  /** 'needs-user': handed to the person, so what was typed stays too. */
  finish(outcome: 'ok' | 'needs-user' | 'failed'): void
}

/** How many tool-partition refusals between runs are written per adapter in each window. */
export const BETWEEN_RUNS_CAP = 50
export const BETWEEN_RUNS_WINDOW_MS = 10 * 60_000

export interface BlockedAuditOptions {
  readonly audit: AuditSink
  readonly secrets: LoginSecrets
  /** The adapter's manifest and the tool partition's session values (driver.sessionSecrets). */
  readonly adapter: (adapterId: string) => {
    readonly manifest: AdapterManifest
    readonly sessionValues: () => Promise<readonly string[]>
  } | null
  readonly now: () => number
  readonly diagnostics?: (diagnostic: { readonly type: string; readonly adapterId: string }) => void
}

export class BlockedAudit {
  /** Per adapter: the writes so far, so they land in the order they were reported. */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly windows = new Map<string, { start: number; count: number; capped: boolean }>()

  constructor(private readonly options: BlockedAuditOptions) {}

  /**
   * openAuthPage's options for one login page: each refusal is audited with partition 'auth' and
   * the call that asked for the login (null for a window the person opened).
   */
  authPage(adapterId: string, callId: string | null): AuthPageOptions {
    return {
      onBlocked: (blocked) => this.write(adapterId, blocked, 'auth', callId),
      onReportsDropped: () => this.options.diagnostics?.({ type: 'auth-reports-dropped', adapterId }),
    }
  }

  /** DriverOptions.onAuthBlocked: refusals no open login page took (a storage-handoff page's, say). */
  authPartition(adapterId: string): (blocked: BlockedRequest) => void {
    return (blocked) => this.write(adapterId, blocked, 'auth', null)
  }

  /** DriverOptions.onBlocked: the tool partition's refusals between runs, capped per window. */
  betweenRuns(adapterId: string): (blocked: BlockedRequest) => void {
    return (blocked) => {
      const now = this.options.now()
      let window = this.windows.get(adapterId)
      if (window === undefined || now - window.start >= BETWEEN_RUNS_WINDOW_MS) {
        window = { start: now, count: 0, capped: false }
        this.windows.set(adapterId, window)
      }
      if (window.count >= BETWEEN_RUNS_CAP) {
        if (!window.capped) {
          window.capped = true
          this.options.diagnostics?.({ type: 'request-blocked-capped', adapterId })
        }
        return
      }
      window.count++
      this.write(adapterId, blocked, 'tool', null)
    }
  }

  /** Resolves once every write reported so far has landed (or failed). */
  async settled(): Promise<void> {
    await Promise.all([...this.queues.values()])
  }

  private write(
    adapterId: string,
    blocked: BlockedRequest,
    partition: 'auth' | 'tool',
    callId: string | null,
  ): void {
    const previous = this.queues.get(adapterId) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        const adapter = this.options.adapter(adapterId)
        if (adapter === null) return
        await this.options.audit.append({
          type: 'request-blocked',
          adapterId,
          method: printable(blocked.method, 16),
          target: await this.redactTarget(adapterId, adapter.sessionValues, blocked.target),
          reason: printable(blocked.reason, 64),
          initiator: blocked.initiator === 'tool' ? 'tool' : 'page',
          partition,
          callId,
        })
      })
      .catch(() => this.options.diagnostics?.({ type: 'audit-write-failed', adapterId }))
    this.queues.set(adapterId, next)
  }

  private async redactTarget(
    adapterId: string,
    sessionValues: () => Promise<readonly string[]>,
    target: unknown,
  ): Promise<string> {
    if (typeof target !== 'string') return REDACTED
    let values: readonly string[]
    try {
      values = await sessionValues()
    } catch {
      return REDACTED
    }
    // The runtime's matcher for targets: session values case-insensitively (URL parsing lower-cases
    // hostnames), the login secrets exactly.
    const sessionMatch = sensitiveMatcher(values, NO_SECRETS, { ignoreCase: true })
    return sessionMatch(target) || this.options.secrets.occursIn(adapterId, target) ? REDACTED : target
  }
}

/** A set nothing is ever registered in: sensitiveMatcher's secrets, when only values are matched. */
const NO_SECRETS = new SecretRedactionSet()

/** A short code from the driver, made printable and bounded (it is the driver's, but still a report). */
function printable(text: unknown, max: number): string {
  if (typeof text !== 'string') return '(invalid)'
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, '')
  return clean.length === 0 ? '(invalid)' : clean.slice(0, max)
}
