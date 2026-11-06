// Audit events. The log is append-only and hash-chained; see packages/runtime for the writer.

import type { ErrorClass, NeedsUserReason, Stage } from './errors'

/** How a tool run or login ended. `blocked`: the site refused us. `declined`: the person said no. */
export type RunOutcome = 'ok' | 'needsUser' | 'failed' | 'blocked' | 'declined'

export type AuditEvent =
  | {
      readonly type: 'adapter-approved'
      readonly adapterId: string
      readonly adapterHash: string
      readonly version: string
      /** The hash this approval replaces, or null for a first install. */
      readonly previousHash: string | null
    }
  | {
      readonly type: 'adapter-rejected'
      readonly adapterId: string
      readonly adapterHash: string
      readonly version: string
    }
  | {
      readonly type: 'grant-made'
      readonly adapterId: string
      readonly adapterHash: string
      readonly secret: string
      readonly provider: string
      readonly origins: readonly string[]
    }
  | { readonly type: 'grant-revoked'; readonly adapterId: string; readonly secret: string }
  | {
      readonly type: 'tool-called'
      readonly adapterId: string
      readonly adapterHash: string
      readonly tool: string
      readonly client: string
      readonly callId: string
    }
  | {
      readonly type: 'tool-finished'
      readonly adapterId: string
      readonly callId: string
      readonly outcome: RunOutcome
      readonly needsUser?: NeedsUserReason
      readonly stage?: Stage
      readonly errorClass?: ErrorClass
      readonly durationMs: number
    }
  | { readonly type: 'login-started'; readonly adapterId: string; readonly callId: string | null }
  | {
      readonly type: 'login-finished'
      readonly adapterId: string
      readonly outcome: Exclude<RunOutcome, 'declined'>
      readonly needsUser?: NeedsUserReason
      readonly stage?: Stage
      readonly errorClass?: ErrorClass
    }
  | {
      readonly type: 'secret-used'
      readonly adapterId: string
      readonly adapterHash: string
      readonly secret: string
      readonly field: string
      readonly origin: string
      readonly callId: string | null
    }
  | {
      readonly type: 'request-blocked'
      readonly adapterId: string
      readonly method: string
      /** Origin and path only; query strings can carry data. */
      readonly target: string
      readonly reason: string
      /** Who asked: tool code through the capability API, or the site's own page scripts. */
      readonly initiator: 'tool' | 'page'
      readonly callId: string | null
    }
  | {
      readonly type: 'breaker-opened'
      /** The site host whose breaker opened; every adapter on that host waits. */
      readonly host: string
      readonly cause: 'blocked-by-site' | 'rate-limited'
      readonly retryAt: string
      readonly callId: string | null
    }
  | { readonly type: 'breaker-closed'; readonly host: string }
  | {
      readonly type: 'confirmation'
      readonly adapterId: string
      readonly tool: string
      readonly client: string
      readonly callId: string
      readonly answer: 'approved' | 'declined' | 'timed-out'
    }

export interface AuditRecord {
  readonly seq: number
  readonly at: string
  readonly event: AuditEvent
  readonly prev: string
  readonly hash: string
}

export interface AuditSink {
  append(event: AuditEvent): Promise<AuditRecord>
}
