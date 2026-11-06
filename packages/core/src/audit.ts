// Audit events. The log is append-only and hash-chained; see packages/runtime for the writer.

import type { ErrorClass, Stage } from './errors'

export type AuditEvent =
  | { readonly type: 'adapter-approved'; readonly adapterId: string; readonly adapterHash: string }
  | {
      readonly type: 'grant-made'
      readonly adapterId: string
      readonly secret: string
      readonly provider: string
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
      readonly callId: string
      readonly outcome: 'ok' | 'needsUser' | 'failed'
      readonly stage?: Stage
      readonly errorClass?: ErrorClass
      readonly durationMs: number
    }
  | { readonly type: 'login-started'; readonly adapterId: string; readonly callId: string | null }
  | {
      readonly type: 'login-finished'
      readonly adapterId: string
      readonly outcome: 'ok' | 'needsUser' | 'failed'
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
      readonly callId: string | null
    }
  | {
      readonly type: 'confirmation'
      readonly adapterId: string
      readonly tool: string
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
