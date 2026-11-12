// Audit events. The log is append-only and hash-chained; see packages/runtime for the writer.

import type { ErrorClass, NeedsUserReason, Stage } from './errors'
import type { SecretField } from './manifest'

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
  /** A version stored and made active (docs/adapter-packages.md). It starts unapproved. */
  | {
      readonly type: 'adapter-installed'
      readonly adapterId: string
      readonly adapterHash: string
      readonly version: string
      readonly source: 'builtin' | 'folder' | 'draft'
      /** The active hash it replaces, or null for a first install. */
      readonly previousHash: string | null
      /** What the hash doesn't cover: the app, the library prelude and the compiler. */
      readonly appVersion: string
      readonly preludeHash: string
      readonly compiler: string
    }
  /** The person rolled back to a stored version (it is approved by the same click). */
  | {
      readonly type: 'adapter-activated'
      readonly adapterId: string
      readonly adapterHash: string
      readonly version: string
      readonly previousHash: string | null
    }
  /** A stored version failed its checks at load and was not run. */
  | {
      readonly type: 'adapter-refused'
      readonly adapterId: string
      readonly adapterHash: string
      readonly reason: string
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
  /** A keychain-copy grant's fields copied (or re-synced) from 1Password into the Keychain (D6). */
  | {
      readonly type: 'grant-copied'
      readonly adapterId: string
      readonly secret: string
      readonly fields: readonly SecretField[]
    }
  | {
      readonly type: 'tool-called'
      readonly adapterId: string
      readonly adapterHash: string
      readonly tool: string
      /** The client's self-reported name from MCP initialize. A claim, not an identity. */
      readonly client: string
      /**
       * The client the call's credential names, `local:<id>` or `remote:<id>` (C12, D42). Absent in
       * records from before per-client tokens, and for calls that came with no credential.
       */
      readonly clientId?: string
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
      /** Which partition refused it: a login's (auth) or a tool run's (tool). */
      readonly partition: 'auth' | 'tool'
      readonly callId: string | null
    }
  | {
      /** Tool code used a sandbox exception (docs/sandbox.md): which capability, and how it ended. */
      readonly type: 'local-access'
      readonly adapterId: string
      readonly callId: string
      /** `files.read`, `fetch`, `service`, `run` and so on. */
      readonly capability: string
      /** Null when it was allowed and worked; else the error class it was refused or failed with. */
      readonly errorClass: ErrorClass | null
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
      /** A verified update finished downloading; it installs when the app next quits. */
      readonly type: 'update-downloaded'
      readonly from: string
      readonly to: string
    }
  | {
      /** The app started on a newer version than it last ran: an update was installed. */
      readonly type: 'update-installed'
      readonly from: string
      readonly to: string
    }
  | {
      /**
       * Remote access turned on, or paused with the tray's kill switch (relay.md). Pausing revokes
       * every remote access token; `revokedTokens` says how many there were.
       */
      readonly type: 'remote-state'
      readonly state: 'on' | 'paused'
      readonly revokedTokens: number
    }
  | {
      /** The person turned a tool on or off for remote clients. Off is the default. */
      readonly type: 'remote-tool'
      readonly adapterId: string
      readonly tool: string
      readonly enabled: boolean
      /** The tool's side effect when this was set; a later raise turns it off again. */
      readonly sideEffect: 'read' | 'write' | 'irreversible'
    }
  | {
      /**
       * The person chose (or cleared) one of an adapter's settings in the app (D69). Which setting,
       * never what was chosen: a choice's value and label come from the site.
       */
      readonly type: 'setting-changed'
      readonly adapterId: string
      readonly setting: string
      readonly cleared: boolean
    }
  | {
      /**
       * A remote client's consent request ended (relay.md, "Consent happens on the Mac"): approved
       * with the person's typed code, declined, expired unanswered, or cancelled by wrong codes.
       */
      readonly type: 'remote-consent'
      /** `remote:<registration id>`, as tool-called records the client. */
      readonly clientId: string
      /** The client's claimed identity: its redirect URI's host. */
      readonly clientHost: string
      /** The address the tunnel reported, or null. */
      readonly source: string | null
      /** The tools granted, as `<adapterId>.<tool>`; empty unless approved. */
      readonly tools: readonly string[]
      readonly answer: 'approved' | 'declined' | 'expired' | 'cancelled'
    }
  | {
      /** The person revoked one remote client (`remote:<id>`), or every one (null). */
      readonly type: 'remote-revoked'
      readonly clientId: string | null
      readonly clients: number
    }
  | {
      /**
       * A rotated-away refresh token, or a spent authorisation code, came back. The client's grant
       * and tokens were revoked: one of the client and a thief holds what the other has used.
       */
      readonly type: 'remote-token-reuse'
      /** `remote:<registration id>`. */
      readonly clientId: string
      readonly token: 'refresh' | 'code'
    }
  | {
      /**
       * The person locked Valet down, or unlocked it. Locking refuses every call (the endpoint stays
       * up to say so) and revokes every cloud agent; `revokedClients` is how many went. Unlocking
       * brings none of them back.
       */
      readonly type: 'lock-down'
      readonly locked: boolean
      readonly revokedClients: number
    }
  | {
      /**
       * The Mac asked the person to approve something (docs/agent-run-security.md). `digest` is the
       * request text's digest, which the answer and any stored evidence name.
       */
      readonly type: 'approval-requested'
      readonly requestId: string
      readonly kind: string
      readonly digest: string
      /** `local:<id>` or `remote:<id>` for an agent; null when the person or the app asked. */
      readonly clientId: string | null
    }
  | {
      /**
       * How an approval request ended. `deviceId` is the device whose signature approved, or that
       * declined; null if it expired or was withdrawn. A refused signature is audited too, with
       * `answer: 'refused'` and the reason, so a forged or replayed approval leaves a record.
       */
      readonly type: 'approval-answered'
      readonly requestId: string
      readonly answer: 'approved' | 'declined' | 'expired' | 'withdrawn' | 'refused'
      readonly deviceId: string | null
      readonly reason?: string
    }
  | {
      /**
       * An agent changed something through Valet's own tools, at the Notify-only tier: it only made
       * Valet stricter (docs/admin-tools.md, "Write tier"). Loosening changes are approval requests
       * and are audited as approval-requested and approval-answered instead.
       */
      readonly type: 'agent-change'
      /** `local:<id>`, as tool-called records the client. */
      readonly clientId: string
      readonly action: 'tool-off' | 'setting' | 'disconnect'
      /** What it was about: `<adapterId>.<tool>`, a Valet setting's name, or the client itself. */
      readonly target: string
      /** A setting's new value as Valet stores it; null for the others. */
      readonly value: string | null
    }
  | {
      /** An agent started a draft adapter (docs/authoring-tools.md). Notify tier. */
      readonly type: 'draft-created'
      readonly draftId: string
      readonly adapterId: string
      readonly clientId: string
    }
  | {
      /**
       * An agent submitted a draft for approval. The package hash fixes every file it held; edits
       * before it aren't audited one by one (B, 2026-11-12).
       */
      readonly type: 'draft-submitted'
      readonly draftId: string
      readonly adapterId: string
      readonly clientId: string
      readonly adapterHash: string
      readonly packageHash: string
      readonly requestId: string
    }
  | {
      readonly type: 'draft-deleted'
      readonly draftId: string
      readonly adapterId: string
      readonly clientId: string
    }
  | {
      /**
       * An agent ran one of a draft's read tools against the real site, signed out
       * (docs/authoring-tools.md#live-trials). Notify tier. The output itself isn't kept.
       */
      readonly type: 'draft-trial'
      readonly draftId: string
      readonly adapterId: string
      readonly clientId: string
      readonly tool: string
      readonly host: string
      readonly packageHash: string
      readonly outcome: 'output' | 'invalid-output' | 'timeout' | 'needs-user' | 'site-resting' | 'error'
    }
  | { readonly type: 'device-paired'; readonly deviceId: string; readonly platform: 'ios' | 'macos' }
  | { readonly type: 'device-revoked'; readonly deviceId: string; readonly by: string }
  | {
      /**
       * A trusted store's file didn't match its Keychain anchor, or a record's evidence failed, and
       * the store (or the record) was ignored.
       */
      readonly type: 'store-refused'
      readonly store: string
      readonly reason: 'anchor-mismatch' | 'evidence'
      readonly records: number
    }
  | {
      /** The person paused one site, or resumed it: its calls are refused without reaching it. */
      readonly type: 'site-paused'
      readonly adapterId: string
      readonly paused: boolean
    }
  | {
      /**
       * A call waited a second or more (D-pacing): for its turn behind the adapter's other calls
       * (`queue`, with how many were in front when it arrived), or for the site's next request slot
       * under its rate budget (`pace`). Recorded so the trace can say where the time went.
       */
      readonly type: 'call-waited'
      readonly adapterId: string
      readonly callId: string
      readonly reason: 'queue' | 'pace'
      readonly waitedMs: number
      readonly ahead?: number
    }
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
