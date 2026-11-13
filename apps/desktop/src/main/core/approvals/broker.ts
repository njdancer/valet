// The approval broker (docs/approval-broker.md): the one way anything widens in Valet.
//
// - The Mac builds every request from its own knowledge; the tier and the life come from core's
//   tables, never from the asker.
// - An approval is a signature by a paired, unrevoked device's approval key over the exact request
//   text, checked by core's verifyDecision. The Mac's own approvals are signed the same way, after
//   Touch ID. A click, an IPC message, an MCP call or a file can only ask, decline or withdraw.
// - Approving moves the request from pending to evidence in one anchored write, then acts. Every
//   widening record the app honours is backed by that evidence, checked again on every question.
// - Every refusal is audited and leaves the request pending: a forged or replayed signature can't
//   cancel a real request.

import { randomBytes } from 'node:crypto'
import {
  APPROVAL_LIMITS,
  APPROVAL_TTL_MS,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalSubject,
  type AuditSink,
  approvableOn,
  canonicalJson,
  consentCodeSchema,
  type DecisionRefusal,
  decisionPayload,
  type Evidence,
  type EvidenceCheck,
  isDisplayText,
  KIND_TIER,
  type MacToPhoneMessage,
  NEVER_STORED,
  parseRequestText,
  type Requester,
  requestIdSchema,
  type SerializedRequest,
  type SignedText,
  serializeRequest,
  signedTextSchema,
  verifyDecision,
  verifyEvidence,
} from '@valet/core'
import type { DeviceStore } from './devices'
import { emptyLedger, type TrustedLedger } from './ledger'
import { requestRef } from './prompts'
import type { MacSigner } from './signer'

/** Kinds an agent may ask for. Everything else is raised by the app or the person. */
export const AGENT_KINDS: readonly ApprovalKind[] = [
  'adapter-install',
  'secret-grant',
  'tool-enable',
  'setting',
  'authoring-session',
  'private-network',
]
/** Kinds only the person may ask for, at the Mac. */
const PERSON_ONLY: readonly ApprovalKind[] = ['resume', 'device-pair']
/** Kinds the app raises itself. */
const APP_ONLY: readonly ApprovalKind[] = ['irreversible-call', 'remote-client']

/**
 * Requests an agent may make in a day, whatever becomes of them, so withdrawing and asking again
 * can't push cards to the phone without end (approval-cards.md section 8).
 */
export const ASKS_PER_CLIENT_PER_DAY = APPROVAL_LIMITS.perClientPerDay
/** Wrong consent codes, across all pending consents, before every one of them is withdrawn. */
export const CONSENT_CODE_STRIKES = 3
const DAY_MS = 24 * 3600_000
/**
 * How long after a device signed its decision the Mac still takes it (A's "Not confirmed yet"
 * window), and how far ahead of the Mac's clock a decision may be dated. The device's own time is
 * used only to refuse, never to accept: a relay holding an approval back for hours can't use it.
 */
export const DECISION_DELIVERY_MS = 5 * 60_000
export const DECISION_CLOCK_SKEW_MS = 2 * 60_000

type Body<T> = T extends unknown ? Omit<T, 'seq'> : never
/** A message for one phone, before the channel numbers and seals it. */
export type MacToPhoneBody = Body<MacToPhoneMessage>

/** Workstreams G and H: seal and deliver to one phone, waking it with a content-free push. */
export interface PhoneOutbox {
  send(deviceId: string, message: MacToPhoneBody): void
}

export interface KindHandler<K extends ApprovalKind> {
  /** Is the request's subject still true now? A stale request is withdrawn, never applied. */
  precheck?(subject: ApprovalSubject<K>): boolean | Promise<boolean>
  /** Act on an approval. `evidence` is null for kinds never stored. */
  apply?(subject: ApprovalSubject<K>, evidence: Evidence | null): Promise<void>
  /** Whether a new approval replaces an older one's evidence (one approved hash per adapter). */
  supersedes?(next: ApprovalSubject<K>, older: ApprovalSubject<K>): boolean
}
export type KindHandlers = { readonly [K in ApprovalKind]?: KindHandler<K> }

export type AnswerSource = { readonly via: 'mac' } | { readonly via: 'phone'; readonly deviceId: string }

export type Outcome = 'approved' | 'declined' | 'expired' | 'withdrawn'

export interface Closed {
  readonly requestId: string
  readonly ref: string
  readonly kind: ApprovalKind
  readonly requester: Requester
  readonly outcome: Outcome
  readonly at: string
  /** The device that approved or declined; null if it expired or was withdrawn. */
  readonly deviceId: string | null
  /** Why it was withdrawn: by the asker, replaced, stale, lockdown, client revoked. */
  readonly reason?: WithdrawReason
  /** A decline's note, for the asking agent only. */
  readonly note?: string
}

/** What the Mac adds to a request besides its subject. All of it is signed with the request. */
export interface RequestExtras {
  readonly agentNote?: string | null
  readonly context?: ApprovalRequest['context']
  readonly display?: ApprovalRequest['display']
  /**
   * A remote client's consent only: the code the browser that started the flow shows. Kept beside
   * the pending request, in memory, never in the request itself: the person must type it.
   */
  readonly consentCode?: string
  /**
   * The asker's own waiting request this one replaces (a draft submitted again). It is withdrawn,
   * as replaced, only once this one is made, and doesn't count against the asker's limits; refused,
   * the earlier one stays as it was. Another asker's request, or one no longer waiting, is ignored.
   */
  readonly replaces?: string
  /**
   * An app-raised request made because of an agent's call (an irreversible call's confirmation):
   * that agent's client id. Kept beside the request, in memory. While the agent is cooling down
   * the request is refused, and declining it counts as declining the agent, so an agent can't
   * keep raising cards the person keeps saying no to.
   */
  readonly onBehalfOf?: string
}

/** What the person entered on the Mac's card, signed into the decision. */
export interface DecisionExtras {
  readonly choice?: string
  readonly typedCode?: string
}

export interface DeclineExtras {
  readonly note?: string
  /** "Decline and stop asking": the agent's requests are refused for the cooldown at once. */
  readonly stopAsking?: boolean
}

export type WithdrawReason =
  | 'asker'
  | 'replaced'
  | 'stale'
  | 'lockdown'
  | 'client-revoked'
  | 'wrong-codes'
  | 'restarted'

export type RequestRefusal =
  | 'locked-down'
  | 'not-allowed'
  | 'too-many-waiting'
  | 'too-many-total'
  | 'cooling-down'
  | 'daily-limit'
  | 'too-many-consents'
  | 'unavailable'

export type RequestResult =
  | {
      readonly ok: true
      readonly requestId: string
      readonly ref: string
      readonly expiresAt: string
      /** True if an identical request from the same asker was already waiting. */
      readonly reused: boolean
    }
  | { readonly ok: false; readonly reason: RequestRefusal; readonly until?: string }

export type AnswerRefusal = DecisionRefusal | 'wrong-device' | 'stale' | 'unavailable' | 'locked-down'
export type AnswerResult = { readonly ok: true } | { readonly ok: false; readonly reason: AnswerRefusal }
export type MacApproveResult =
  | AnswerResult
  | { readonly ok: false; readonly reason: 'cancelled' | 'busy' | 'not-pending' }

export interface Timers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface BrokerOptions {
  readonly ledger: TrustedLedger
  readonly devices: DeviceStore
  readonly signer: MacSigner
  readonly audit: AuditSink
  readonly handlers: KindHandlers
  readonly outbox?: PhoneOutbox
  readonly now?: () => number
  readonly newId?: () => string
  readonly timers?: Timers
  /** Something the Mac's window shows changed. */
  readonly onChange?: () => void
}

/** Outcomes kept for askers to read back. */
const CLOSED_KEPT = 200
/** setTimeout's ceiling. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** Declines older than this can't matter to the cooldown. */
const DECLINES_KEPT_MS = APPROVAL_LIMITS.declineWindowMs + APPROVAL_LIMITS.cooldownMs

const realTimers: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class ApprovalBroker {
  /** Requests waiting, by id: the ledger's, and irreversible calls, which live in memory only. */
  private readonly pending = new Map<string, SerializedRequest>()
  private readonly closed: Closed[] = []
  private readonly waiters = new Map<string, ((closed: Closed) => void)[]>()
  /** Each pending consent's code, never written anywhere: a restart withdraws the consent. */
  private readonly consentCodes = new Map<string, string>()
  /** The agent an app-raised request was made for (`RequestExtras.onBehalfOf`). */
  private readonly onBehalfOf = new Map<string, string>()
  private wrongCodes = 0
  /** Stored evidence checks, by signature; cleared when the devices or revocations change. */
  private readonly evidenceChecks = new Map<string, EvidenceCheck>()
  private evidenceDevices: unknown = null
  private evidenceRevocations: unknown = null
  /** Evidence already audited as refused this run, so a bad record is reported once. */
  private readonly refusedReported = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()
  private prompting = false
  private timer: unknown = null
  private readonly now: () => number
  private readonly newId: () => string
  private readonly timers: Timers

  private constructor(private readonly options: BrokerOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => randomBytes(16).toString('base64url'))
    this.timers = options.timers ?? realTimers
  }

  /** Opens the broker over a loaded ledger: drops pending entries that don't parse, expires old ones. */
  static async open(options: BrokerOptions): Promise<ApprovalBroker> {
    const broker = new ApprovalBroker(options)
    await broker.load()
    return broker
  }

  get macId(): string {
    return this.options.devices.macId
  }

  /** Why the ledger couldn't be trusted at launch, or null. */
  get tampered(): string | null {
    return this.options.ledger.tampered
  }

  isLockedDown(): boolean {
    return this.options.ledger.data.safety.lockdown
  }

  isRemotePaused(): boolean {
    return this.options.ledger.data.safety.pausedRemote
  }

  /** Every request waiting, oldest first, as the Mac serialised it. */
  list(): SerializedRequest[] {
    return [...this.pending.values()].sort((a, b) =>
      a.request.createdAt < b.request.createdAt ? -1 : a.request.createdAt > b.request.createdAt ? 1 : 0,
    )
  }

  get(requestId: string): SerializedRequest | null {
    return this.pending.get(requestId) ?? null
  }

  /**
   * How a request stands, for its asker only: waiting, how it ended, or null if this asker never
   * made it (or it ended too long ago to remember).
   */
  status(requestId: string, asker: Requester): { readonly state: 'pending' } | Closed | null {
    const pending = this.pending.get(requestId)
    if (pending !== undefined)
      return sameAsker(pending.request.requester, asker) ? { state: 'pending' } : null
    const closed = this.closed.find((c) => c.requestId === requestId)
    return closed !== undefined && sameAsker(closed.requester, asker) ? closed : null
  }

  /** Requests that ended and are still remembered, newest first. */
  ended(): readonly Closed[] {
    return [...this.closed]
  }

  /** Resolves when the request closes; at once if it already has. */
  wait(requestId: string): Promise<Closed | null> {
    const closed = this.closed.find((c) => c.requestId === requestId)
    if (closed !== undefined) return Promise.resolve(closed)
    if (!this.pending.has(requestId)) return Promise.resolve(null)
    return new Promise((resolve) => {
      const list = this.waiters.get(requestId) ?? []
      list.push(resolve)
      this.waiters.set(requestId, list)
    })
  }

  /** Asks the person. The Mac builds `subject`; nothing here is taken from the asker but its note. */
  request<K extends ApprovalKind>(
    kind: K,
    subject: ApprovalSubject<K>,
    requester: Requester,
    extras: RequestExtras | string | null = null,
  ): Promise<RequestResult> {
    const {
      agentNote = null,
      context,
      display,
      consentCode,
      replaces,
      onBehalfOf,
    } = typeof extras === 'string' || extras === null ? { agentNote: extras } : extras
    return this.exclusive(async () => {
      const earlier = replaces === undefined ? undefined : this.pending.get(replaces)
      const replacing =
        earlier !== undefined && sameAsker(earlier.request.requester, requester) ? earlier : undefined
      const refusal = this.refusal(kind, subject, requester, replacing?.request.id)
      if (refusal !== null) return refusal
      const forAgent = requester.kind === 'app' ? onBehalfOf : undefined
      if (forAgent !== undefined) {
        const until = cooldownUntil(this.options.ledger.data.declines, forAgent, this.now())
        if (until !== null) return { ok: false, reason: 'cooling-down', until: new Date(until).toISOString() }
      }
      if (kind === 'remote-client') {
        if (consentCode === undefined || !consentCodeSchema.safeParse(consentCode).success) {
          return { ok: false, reason: 'not-allowed' }
        }
        const waiting = this.list().filter((p) => p.request.kind === 'remote-client').length
        if (waiting >= APPROVAL_LIMITS.consentPending) return { ok: false, reason: 'too-many-consents' }
      }

      const existing = this.list().find(
        (p) =>
          p.request.kind === kind &&
          sameAsker(p.request.requester, requester) &&
          canonicalJson(p.request.subject) === canonicalJson(subject),
      )
      if (existing !== undefined && kind !== 'remote-client') {
        if (replacing !== undefined && replacing.request.id !== existing.request.id)
          await this.close(replacing, 'withdrawn', null, 'replaced')
        return {
          ok: true,
          requestId: existing.request.id,
          ref: requestRef(existing),
          expiresAt: existing.request.expiresAt,
          reused: true,
        }
      }

      const now = this.now()
      const serialized = serializeRequest({
        v: 1,
        id: this.newId(),
        macId: this.macId,
        kind,
        tier: KIND_TIER[kind],
        requester,
        agentNote: requester.kind === 'agent' ? agentNote : null,
        subject,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + APPROVAL_TTL_MS[kind]).toISOString(),
        ...(context === undefined ? {} : { context }),
        ...(display === undefined ? {} : { display }),
      } as ApprovalRequest)
      const id = serialized.request.id

      // Audited first: a request that can't be audited isn't made.
      await this.options.audit.append({
        type: 'approval-requested',
        requestId: id,
        kind,
        digest: serialized.digest,
        clientId: requester.kind === 'agent' ? requester.clientId : null,
      })
      if (!NEVER_STORED.includes(kind) || requester.kind === 'agent') {
        try {
          await this.options.ledger.commit((draft) => {
            if (!NEVER_STORED.includes(kind)) draft.pending.push({ requestText: serialized.text })
            if (requester.kind === 'agent') {
              draft.asks = draft.asks.filter((a) => Date.parse(a.at) > now - DAY_MS)
              draft.asks.push({ clientId: requester.clientId, at: new Date(now).toISOString() })
            }
          })
        } catch {
          return { ok: false, reason: 'unavailable' }
        }
      }
      this.pending.set(id, serialized)
      if (kind === 'remote-client' && consentCode !== undefined) this.consentCodes.set(id, consentCode)
      if (forAgent !== undefined) this.onBehalfOf.set(id, forAgent)
      if (replacing !== undefined) await this.close(replacing, 'withdrawn', null, 'replaced')
      if (approvableOn(kind, subject).includes('phone')) {
        for (const phone of this.options.devices.activePhones()) {
          this.options.outbox?.send(phone.deviceId, {
            type: 'approval-request',
            requestText: serialized.text,
          })
        }
      }
      this.changed()
      return {
        ok: true,
        requestId: id,
        ref: requestRef(serialized),
        expiresAt: serialized.request.expiresAt,
        reused: false,
      }
    })
  }

  /**
   * The Mac window's Approve. Signs the decision with the Mac's approval key, which shows the OS's
   * Touch ID prompt: without the person's finger (or password) nothing is signed. One prompt at a
   * time. The renderer sends only the request id and never sees the signature.
   */
  async approveOnMac(requestId: string, extras: DecisionExtras = {}): Promise<MacApproveResult> {
    if (this.prompting) return { ok: false, reason: 'busy' }
    const request = this.pending.get(requestId)
    if (request === undefined) return { ok: false, reason: 'not-pending' }
    this.prompting = true
    let signature: string | null
    const payload = decisionPayload({
      v: 1,
      decision: 'approve',
      macId: this.macId,
      requestId,
      requestDigest: request.digest,
      deviceId: this.macId,
      decidedAt: new Date(this.now()).toISOString(),
      ...(extras.choice === undefined ? {} : { choice: extras.choice }),
      ...(extras.typedCode === undefined ? {} : { typedCode: normaliseCode(extras.typedCode) }),
    })
    try {
      signature = await this.options.signer.signDecision(request, payload)
    } catch {
      signature = null
    } finally {
      this.prompting = false
    }
    if (signature === null) return { ok: false, reason: 'cancelled' }
    return this.answer({ payload, signature }, { via: 'mac' })
  }

  /** A signed approval, from the Mac's own signer or a phone. */
  answer(signed: SignedText, from: AnswerSource): Promise<AnswerResult> {
    return this.exclusive(async () => {
      const requestId = payloadRequestId(signed)
      const request = requestId === null ? undefined : this.pending.get(requestId)
      if (requestId === null || request === undefined || !signedTextSchema.safeParse(signed).success) {
        return this.refuse(requestId, from, requestId === null ? 'malformed' : 'not-pending')
      }
      const check = verifyDecision(signed, request, {
        macId: this.macId,
        devices: this.options.devices,
        mode: 'live',
        isPending: (id) => this.pending.has(id),
        consentCode: (id) => this.consentCodes.get(id) ?? null,
        now: new Date(this.now()),
      })
      if (!check.ok) {
        const refused = await this.refuse(requestId, from, check.reason)
        if (check.reason === 'wrong-code' && ++this.wrongCodes >= CONSENT_CODE_STRIKES) {
          // Three wrong codes: someone may be guessing. Every waiting consent goes (relay.md).
          this.wrongCodes = 0
          for (const consent of this.list().filter((p) => p.request.kind === 'remote-client')) {
            await this.close(consent, 'withdrawn', null, 'wrong-codes')
          }
        }
        return refused
      }
      const expected = from.via === 'mac' ? this.macId : from.deviceId
      if (check.decision.deviceId !== expected) return this.refuse(requestId, from, 'wrong-device')
      const kind = request.request.kind
      // Stricter than approvableOn: undoing a lockdown is the person at the Mac, since lockdown is
      // what they reach for when a phone is lost (approval-cards.md section 12).
      if (kind === 'resume' && check.role !== 'mac')
        return this.refuse(requestId, from, 'not-allowed-on-device')
      if (this.isLockedDown() && kind !== 'resume') return this.refuse(requestId, from, 'locked-down')
      const decidedAt = Date.parse(check.decision.decidedAt)
      const now = this.now()
      if (now - decidedAt > DECISION_DELIVERY_MS || decidedAt - now > DECISION_CLOCK_SKEW_MS) {
        return this.refuse(requestId, from, 'expired')
      }

      const handler = this.handler(request.request.kind)
      let fresh: boolean
      try {
        fresh = (await handler?.precheck?.(request.request.subject)) ?? true
      } catch {
        fresh = false
      }
      if (!fresh) {
        await this.close(request, 'withdrawn', null, 'stale')
        return { ok: false, reason: 'stale' }
      }

      // Audited before it takes effect, so the log never under-reports an approval.
      await this.options.audit.append({
        type: 'approval-answered',
        requestId,
        answer: 'approved',
        deviceId: check.decision.deviceId,
      })
      const stored = !NEVER_STORED.includes(kind)
      const evidence: Evidence | null = stored
        ? { requestText: request.text, decision: signed, receivedAt: new Date(this.now()).toISOString() }
        : null
      if (stored && evidence !== null) {
        try {
          await this.options.ledger.commit((draft) => {
            draft.pending = draft.pending.filter((p) => p.requestText !== request.text)
            const supersedes = handler?.supersedes
            if (supersedes !== undefined) {
              draft.evidence = draft.evidence.filter((e) => {
                const older = parseRequestText(e.requestText)
                return !(
                  older !== null &&
                  older.request.kind === kind &&
                  supersedes(request.request.subject as never, older.request.subject as never)
                )
              })
            }
            draft.evidence.push(evidence)
          })
        } catch {
          // Nothing was approved: the request stays pending, and the person can approve again.
          return { ok: false, reason: 'unavailable' }
        }
      }
      this.finish(request, 'approved', check.decision.deviceId)
      if (kind === 'resume') await this.resume(request.request.subject as ApprovalSubject<'resume'>)
      try {
        await handler?.apply?.(request.request.subject as never, evidence)
      } catch {
        // The person did approve: the evidence stands, and applying can be retried without asking.
      }
      return { ok: true }
    })
  }

  /** A decline from the Mac window, or from a paired, unrevoked phone. Needs no signature. */
  decline(requestId: string, from: AnswerSource, extras: DeclineExtras = {}): Promise<boolean> {
    return this.exclusive(async () => {
      const request = this.pending.get(requestId)
      if (request === undefined) return false
      if (from.via === 'phone' && !this.options.devices.isActivePhone(from.deviceId)) return false
      const deviceId = from.via === 'mac' ? this.macId : from.deviceId
      const requester = request.request.requester
      const agent = requester.kind === 'agent' ? requester.clientId : this.onBehalfOf.get(requestId)
      const note =
        extras.note !== undefined && isDisplayText(extras.note) ? extras.note.slice(0, 280) : undefined
      await this.close(
        request,
        'declined',
        deviceId,
        undefined,
        (draft) => {
          if (agent === undefined) return
          // A decline with a note is the person explaining, not refusing to be asked (A section 8),
          // unless they also said to stop asking, which starts the cooldown at once.
          if (note !== undefined && extras.stopAsking !== true) return
          const keepAfter = this.now() - DECLINES_KEPT_MS
          const at = new Date(this.now()).toISOString()
          draft.declines = draft.declines.filter((d) => Date.parse(d.at) > keepAfter)
          const count = extras.stopAsking === true ? APPROVAL_LIMITS.declinesBeforeCooldown : 1
          for (let n = 0; n < count; n++) draft.declines.push({ clientId: agent, at })
        },
        note,
      )
      return true
    })
  }

  /** The asker takes its own request back. Nobody can withdraw another's. */
  withdraw(requestId: string, asker: Requester): Promise<boolean> {
    return this.exclusive(async () => {
      const request = this.pending.get(requestId)
      if (request === undefined || !sameAsker(request.request.requester, asker)) return false
      await this.close(request, 'withdrawn', null, 'asker')
      return true
    })
  }

  /** Withdraws every request an agent made, when the person revokes it. */
  withdrawClient(clientId: string): Promise<number> {
    return this.withdrawWhere(
      (r) => r.requester.kind === 'agent' && r.requester.clientId === clientId,
      'client-revoked',
    )
  }

  /** A newer draft replaces older install requests for the same adapter from the same asker. */
  withdrawReplaced(adapterId: string, asker: Requester, keep: string): Promise<number> {
    return this.withdrawWhere(
      (r) =>
        r.id !== keep &&
        r.kind === 'adapter-install' &&
        r.subject.adapterId === adapterId &&
        sameAsker(r.requester, asker),
      'replaced',
    )
  }

  private withdrawWhere(
    match: (request: ApprovalRequest) => boolean,
    reason: WithdrawReason,
  ): Promise<number> {
    return this.exclusive(async () => {
      let count = 0
      for (const request of this.list()) {
        if (!match(request.request)) continue
        await this.close(request, 'withdrawn', null, reason)
        count++
      }
      return count
    })
  }

  /**
   * Lock down (J7): every waiting request is withdrawn and new ones are refused until a `resume`
   * approval. Takes effect even if the ledger can't be written.
   */
  lockdown(): Promise<void> {
    return this.exclusive(async () => {
      for (const request of this.list()) await this.close(request, 'withdrawn', null, 'lockdown')
      await this.options.ledger
        .commit(
          (draft) => {
            draft.pending = []
            draft.safety.lockdown = true
            // Lockdown revokes every remote client and ends authoring sessions (B); resuming
            // brings none of them back.
            draft.evidence = draft.evidence.filter((e) => {
              const kind = parseRequestText(e.requestText)?.request.kind
              return kind !== 'remote-client' && kind !== 'authoring-session'
            })
          },
          { tightening: true },
        )
        .catch(() => undefined)
      this.changed()
    })
  }

  /** Pause remote access (a phone command or the tray). Undone by a `resume` approval. */
  pauseRemote(): Promise<void> {
    return this.exclusive(async () => {
      await this.options.ledger
        .commit(
          (draft) => {
            draft.safety.pausedRemote = true
          },
          { tightening: true },
        )
        .catch(() => undefined)
      this.changed()
    })
  }

  /** Expires every request past its time. Runs on a timer, and at open. */
  expireDue(): Promise<void> {
    return this.exclusive(async () => {
      const now = this.now()
      for (const request of this.list()) {
        if (now >= Date.parse(request.request.expiresAt)) await this.close(request, 'expired', null)
      }
    })
  }

  /**
   * The newest stored evidence of `kind` that is valid now and whose subject `matches` the record
   * in hand, or null. Every gate that honours a widening record asks this.
   */
  honoured<K extends ApprovalKind>(
    kind: K,
    matches: (subject: ApprovalSubject<K>, request: Extract<ApprovalRequest, { kind: K }>) => boolean,
  ): Evidence | null {
    const data = this.options.ledger.data
    if (this.evidenceDevices !== data.devices || this.evidenceRevocations !== data.revocations) {
      this.evidenceChecks.clear()
      this.evidenceDevices = data.devices
      this.evidenceRevocations = data.revocations
    }
    for (let i = data.evidence.length - 1; i >= 0; i--) {
      const evidence = data.evidence[i] as Evidence
      const request = parseRequestText(evidence.requestText)
      if (request === null || request.request.kind !== kind) continue
      if (!matches(request.request.subject as ApprovalSubject<K>, request.request as never)) continue
      const key = evidence.decision.signature
      let check = this.evidenceChecks.get(key)
      if (check === undefined) {
        check = verifyEvidence(evidence, kind, () => true, {
          macId: this.macId,
          devices: this.options.devices,
          now: new Date(this.now()),
        })
        this.evidenceChecks.set(key, check)
      }
      if (check.ok) return evidence
      if (!this.refusedReported.has(key)) {
        this.refusedReported.add(key)
        void this.options.audit
          .append({ type: 'store-refused', store: 'trusted', reason: 'evidence', records: 1 })
          .catch(() => undefined)
      }
    }
    return null
  }

  /** Removes evidence (revoking a grant, turning a tool off). Only tightens; needs no signature. */
  revoke<K extends ApprovalKind>(
    kind: K,
    matches: (subject: ApprovalSubject<K>) => boolean,
  ): Promise<number> {
    return this.exclusive(async () => {
      let removed = 0
      await this.options.ledger.commit(
        (draft) => {
          draft.evidence = draft.evidence.filter((e) => {
            const request = parseRequestText(e.requestText)
            const hit =
              request !== null &&
              request.request.kind === kind &&
              matches(request.request.subject as ApprovalSubject<K>)
            if (hit) removed++
            return !hit
          })
        },
        { tightening: true },
      )
      return removed
    })
  }

  /** Stops the expiry timer, e.g. on quit. */
  stop(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
  }

  // Internals.

  private async load(): Promise<void> {
    const ledger = this.options.ledger
    if (ledger.tampered !== null) {
      await this.options.audit
        .append({ type: 'store-refused', store: 'trusted', reason: 'anchor-mismatch', records: 0 })
        .catch(() => undefined)
    }
    const kept: string[] = []
    for (const entry of ledger.data.pending) {
      const request = parseRequestText(entry.requestText)
      if (
        request === null ||
        request.request.macId !== this.macId ||
        NEVER_STORED.includes(request.request.kind)
      )
        continue
      if (this.pending.has(request.request.id)) continue
      if (request.request.kind === 'remote-client') {
        // Its code was kept in memory only, so nobody can answer it now.
        await this.options.audit
          .append({
            type: 'approval-answered',
            requestId: request.request.id,
            answer: 'withdrawn',
            deviceId: null,
            reason: 'restarted',
          })
          .catch(() => undefined)
        continue
      }
      this.pending.set(request.request.id, request)
      kept.push(entry.requestText)
    }
    if (kept.length !== ledger.data.pending.length) {
      await ledger
        .commit(
          (draft) => {
            draft.pending = draft.pending.filter((p) => kept.includes(p.requestText))
          },
          { tightening: true },
        )
        .catch(() => undefined)
    }
    await this.expireDue()
  }

  private refusal(
    kind: ApprovalKind,
    subject: ApprovalSubject,
    requester: Requester,
    replacing?: string,
  ): RequestResult | null {
    const refuse = (reason: RequestRefusal, until?: number): RequestResult =>
      until === undefined
        ? { ok: false, reason }
        : { ok: false, reason, until: new Date(until).toISOString() }
    if (requester.kind === 'agent' && !AGENT_KINDS.includes(kind)) return refuse('not-allowed')
    if (requester.kind !== 'person' && PERSON_ONLY.includes(kind)) return refuse('not-allowed')
    if (requester.kind !== 'app' && APP_ONLY.includes(kind)) return refuse('not-allowed')
    // An agent may ask to turn a tool on remotely only for itself (approval-cards.md section 3).
    if (requester.kind === 'agent' && kind === 'tool-enable') {
      const tool = subject as ApprovalSubject<'tool-enable'>
      if (tool.scope === 'remote' ? tool.clientId !== requester.clientId : tool.clientId !== null) {
        return refuse('not-allowed')
      }
    }
    if (this.isLockedDown() && kind !== 'resume') return refuse('locked-down')
    if (requester.kind !== 'agent') return null

    const now = this.now()
    const until = cooldownUntil(this.options.ledger.data.declines, requester.clientId, now)
    if (until !== null) return refuse('cooling-down', until)
    const fromAgents = this.list().filter(
      (p) => p.request.requester.kind === 'agent' && p.request.id !== replacing,
    )
    const sameSubject = (p: SerializedRequest) =>
      p.request.kind === kind &&
      sameAsker(p.request.requester, requester) &&
      canonicalJson(p.request.subject) === canonicalJson(subject)
    // A repeat of a waiting request is answered with that request, whatever the counts.
    if (fromAgents.some(sameSubject)) return null
    const asked = this.options.ledger.data.asks.filter(
      (a) => a.clientId === requester.clientId && Date.parse(a.at) > now - DAY_MS,
    )
    if (asked.length >= ASKS_PER_CLIENT_PER_DAY) {
      return refuse('daily-limit', Math.min(...asked.map((a) => Date.parse(a.at))) + DAY_MS)
    }
    const mine = fromAgents.filter((p) => sameAsker(p.request.requester, requester))
    if (mine.length >= APPROVAL_LIMITS.pendingPerClient) return refuse('too-many-waiting')
    if (fromAgents.length >= APPROVAL_LIMITS.pendingTotal) return refuse('too-many-total')
    return null
  }

  private async refuse(
    requestId: string | null,
    from: AnswerSource,
    reason: AnswerRefusal,
  ): Promise<AnswerResult> {
    await this.options.audit
      .append({
        type: 'approval-answered',
        requestId: requestId ?? 'unknown',
        answer: 'refused',
        deviceId: from.via === 'mac' ? this.macId : safeDeviceId(from.deviceId),
        reason,
      })
      .catch(() => undefined)
    return { ok: false, reason }
  }

  /** Ends a request that wasn't approved: out of the ledger, audited, cards closed. */
  private async close(
    request: SerializedRequest,
    outcome: Exclude<Outcome, 'approved'>,
    deviceId: string | null,
    reason?: WithdrawReason,
    also?: (draft: import('./ledger').LedgerData) => void,
    note?: string,
  ): Promise<void> {
    await this.options.audit
      .append({
        type: 'approval-answered',
        requestId: request.request.id,
        answer: outcome,
        deviceId,
        ...(reason === undefined ? {} : { reason }),
      })
      .catch(() => undefined)
    if (!NEVER_STORED.includes(request.request.kind) || also !== undefined) {
      // Only tightens: a request that can't be answered any more. Holds in memory if the write fails.
      await this.options.ledger
        .commit(
          (draft) => {
            draft.pending = draft.pending.filter((p) => p.requestText !== request.text)
            also?.(draft)
          },
          { tightening: true },
        )
        .catch(() => undefined)
    }
    this.finish(request, outcome, deviceId, reason, note)
  }

  private finish(
    request: SerializedRequest,
    outcome: Outcome,
    deviceId: string | null,
    reason?: WithdrawReason,
    note?: string,
  ): void {
    const id = request.request.id
    this.pending.delete(id)
    this.consentCodes.delete(id)
    this.onBehalfOf.delete(id)
    const closed: Closed = {
      requestId: id,
      ref: requestRef(request),
      kind: request.request.kind,
      requester: request.request.requester,
      outcome,
      at: new Date(this.now()).toISOString(),
      deviceId,
      ...(reason === undefined ? {} : { reason }),
      ...(note === undefined ? {} : { note }),
    }
    this.closed.unshift(closed)
    this.closed.length = Math.min(this.closed.length, CLOSED_KEPT)
    for (const phone of this.options.devices.activePhones()) {
      this.options.outbox?.send(phone.deviceId, { type: 'approval-closed', requestId: id, outcome })
    }
    for (const resolve of this.waiters.get(id) ?? []) resolve(closed)
    this.waiters.delete(id)
    this.changed()
  }

  /** The built-in effect of a `resume` approval. After tampering, it starts a fresh ledger. */
  private async resume(subject: ApprovalSubject<'resume'>): Promise<void> {
    const ledger = this.options.ledger
    const safety =
      subject.from === 'lockdown'
        ? { ...ledger.data.safety, lockdown: false }
        : { ...ledger.data.safety, pausedRemote: false }
    if (ledger.tampered === 'unreadable') {
      // The file may be fine and the Keychain only busy: never overwrite it. The resume holds for
      // this run; the next launch reads the file again.
      await ledger.commit((draft) => {
        draft.safety = safety
      })
      return
    }
    if (ledger.tampered !== null) {
      // Everything in memory since launch was made live by this process; nothing from the file is.
      // The legacy record is never made again over a reset: what approvals.json and the store
      // hold after a tamper is not what the person approved (docs/approval-broker.md#migration).
      const legacy = ledger.data.legacy ?? {
        at: new Date(this.now()).toISOString(),
        installs: [],
        grants: [],
      }
      await ledger.reset({ ...emptyLedger(), ...ledger.data, safety, legacy }).catch(() => undefined)
      return
    }
    await ledger
      .commit((draft) => {
        draft.safety = safety
      })
      .catch(() => undefined)
  }

  private handler<K extends ApprovalKind>(kind: K): KindHandler<K> | undefined {
    const builtIn: KindHandlers = {
      resume: {
        precheck: (s) => (s.from === 'lockdown' ? this.isLockedDown() : this.isRemotePaused()),
        supersedes: () => true,
      },
    }
    return (this.options.handlers[kind] ?? builtIn[kind]) as KindHandler<K> | undefined
  }

  private changed(): void {
    this.schedule()
    try {
      this.options.onChange?.()
    } catch {
      // The window's refresh never decides anything.
    }
  }

  private schedule(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
    const next = Math.min(...[...this.pending.values()].map((p) => Date.parse(p.request.expiresAt)))
    if (!Number.isFinite(next)) return
    const wait = Math.min(Math.max(0, next - this.now()), MAX_TIMER_MS)
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      void this.expireDue()
    }, wait)
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const done = this.queue.then(run)
    this.queue = done.catch(() => undefined)
    return done
  }
}

/** A typed consent code as core checks it: upper case, with the hyphen in the middle. */
export function normaliseCode(typed: string): string {
  const letters = typed.toUpperCase().replace(/[^A-Z]/g, '')
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters
}

function sameAsker(a: Requester, b: Requester): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'agent' || a.clientId === (b as Extract<Requester, { kind: 'agent' }>).clientId
}

/** The request id a signed payload names, read only to find the request; null if it has none. */
function payloadRequestId(signed: SignedText): string | null {
  if (typeof signed?.payload !== 'string' || signed.payload.length > 64 * 1024) return null
  try {
    const id = (JSON.parse(signed.payload) as { requestId?: unknown } | null)?.requestId
    return requestIdSchema.safeParse(id).success ? (id as string) : null
  } catch {
    return null
  }
}

function safeDeviceId(id: string): string | null {
  return /^[0-9a-f]{32}$/.test(id) ? id : null
}

/**
 * When a client's requests may resume after declines, or null if they may now: three declines
 * within the window refuse its requests until a cooldown after the last of them.
 */
export function cooldownUntil(
  declines: readonly { readonly clientId: string; readonly at: string }[],
  clientId: string,
  now: number,
): number | null {
  const times = declines
    .filter((d) => d.clientId === clientId)
    .map((d) => Date.parse(d.at))
    .sort((a, b) => a - b)
  const n = APPROVAL_LIMITS.declinesBeforeCooldown
  let until: number | null = null
  for (let i = n - 1; i < times.length; i++) {
    const last = times[i] as number
    if (last - (times[i - n + 1] as number) <= APPROVAL_LIMITS.declineWindowMs) {
      const end = last + APPROVAL_LIMITS.cooldownMs
      if (end > now && (until === null || end > until)) until = end
    }
  }
  return until
}
