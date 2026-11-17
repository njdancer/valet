// The runtime's ConfirmationPrompt, answered in the app's own floating panel and never by an MCP
// client. Everything on the panel but the adapter's note is the runtime's own knowledge.
//
// Each confirmation is also a signed request of the approval broker (an `irreversible-call`, never
// remembered), so a click alone never approves anything (docs/approval-broker.md#approving-at-the-mac):
// - Approve is accepted only from the confirmation window opened for this very request, and all it
//   does is raise the OS's Touch ID prompt; the approval counts once the Mac's approval key signed
//   it, which needs the person's finger. A paired phone may approve it the same way.
// - Decline is accepted from any app window, and needs nothing: it only tightens. It is the
//   person's decline of the signed request too, so it counts against the agent that made the call.
// - Unanswered, it declines itself at expiry, and its request is withdrawn. A call that ends first
//   (the agent cancelled, went away or was revoked; the app quit) withdraws it as cancelled, never
//   as the person's decline.

import { type AdapterManifest, unlockedBy } from '@valet/core'
import type { ConfirmationAnswer, ConfirmationPrompt, ConfirmationRequest, MailPreview } from '@valet/runtime'
import type { ConfirmationItem, PreviewPart } from '../../shared/api'
import { shownTransport } from './clients'
import type { AppWindow } from './ipc'
import { previewParts } from './run-memory'

export interface ConfirmationAdapter {
  readonly manifest: AdapterManifest
  readonly hash: string
  readonly approvedAt: string | null
}

export interface Timers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** The approval broker's side of a confirmation (service.ts wires it). */
export interface ConfirmationSigning {
  /** Raises the signed request; its id and ref, or null if it can't be made (the call is declined). */
  open(item: ConfirmationItem): Promise<{ readonly requestId: string; readonly ref: string } | null>
  /** Shows the Touch ID prompt for it. 'approved' once the decision is signed and applied. */
  approve(requestId: string): Promise<'approved' | 'cancelled' | 'refused'>
  /** The person declined it on the panel: a decline of the signed request, from this Mac. */
  decline(requestId: string): void
  /** Withdraws it: nobody answered in time, or the call ended first (`why` says which). */
  withdraw(requestId: string, why: ConfirmationEnd): void
}

/** Why a confirmation ended without the person's answer. */
export type ConfirmationEnd =
  /** Its time ran out, or the app is quitting. */
  | 'unanswered'
  /** The call was cancelled: the agent cancelled it or went away. */
  | 'call-cancelled'
  /** The person revoked the agent that made the call. */
  | 'client-revoked'

export interface ConfirmationBrokerOptions {
  readonly signing: ConfirmationSigning
  readonly adapter: (adapterId: string) => ConfirmationAdapter | null
  /** The client's input as it sent it. */
  readonly call: (callId: string) => { readonly input: readonly PreviewPart[] } | null
  readonly show: (id: string) => void
  readonly close: (id: string) => void
  readonly onChange: () => void
  /**
   * A request ran out with nobody answering (its time passed, or the runtime's deadline did): it
   * becomes a missed item. Not called for a decline, a cancelled call or the app quitting.
   */
  readonly onMissed?: (item: ConfirmationItem) => void
  readonly now: () => number
  readonly timeoutMs: number
  readonly timers: Timers
  readonly newId: () => string
}

interface Pending {
  item: ConfirmationItem
  readonly resolve: (answer: ConfirmationAnswer, why?: ConfirmationEnd | 'person') => void
  /** The broker's request, once made. Approve is refused until then. */
  requestId: string | null
  /** How it ended, once it did: what the panel is told after a Touch ID prompt. */
  answer: ConfirmationAnswer | null
  readonly timer: unknown
  /** Ends it as cancelled, for the reason given: the call it belongs to is over. */
  readonly cancel: (why: Exclude<ConfirmationEnd, 'unanswered'>) => void
}

/** How close to its expiry an abort counts as the request running out. */
const MISSED_SLACK_MS = 1_000

export class ConfirmationRefused extends Error {
  constructor() {
    super('confirmation refused')
    this.name = 'ConfirmationRefused'
  }
}

export class ConfirmationBroker implements ConfirmationPrompt {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly options: ConfirmationBrokerOptions) {}

  ask(request: ConfirmationRequest, signal: AbortSignal): Promise<ConfirmationAnswer> {
    const adapter = this.options.adapter(request.adapterId)
    if (adapter === null || signal.aborted) return Promise.resolve('declined')
    const declaration = adapter.manifest.tools.find((t) => t.name === request.tool)
    if (declaration === undefined) return Promise.resolve('declined')
    const id = this.options.newId()
    const now = this.options.now()
    const call = this.options.call(request.callId)
    const irreversible = request.kind === 'irreversible-tool'
    const item: ConfirmationItem = {
      kind: 'confirmation',
      id,
      adapterId: adapter.manifest.id,
      adapterName: adapter.manifest.name,
      adapterVersion: adapter.manifest.version,
      adapterHash: adapter.hash,
      approvedAt: adapter.approvedAt,
      tool: declaration.name,
      toolTitle: declaration.title,
      sideEffect: declaration.sideEffect,
      trigger: request.kind,
      client: request.client,
      // The transport the runtime was given with the call (mcp-server's label), not the adapter's.
      clientTransport: shownTransport(request.transport),
      callId: request.callId,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.options.timeoutMs).toISOString(),
      requestCeiling: adapter.manifest.limits.requestsPerRun,
      // Only the runtime's own confirmation before an irreversible tool unlocks anything, and only
      // the declarations that tool names (C15).
      unlocks: irreversible ? unlockedBy(adapter.manifest.requests, declaration.unlocks) : [],
      requests:
        request.kind === 'tool-request'
          ? request.requests.map(({ method, path, purpose }) => ({ method, path, purpose }))
          : [],
      // A send shows the message itself, as Valet will build it, in full.
      input:
        request.kind === 'irreversible-tool'
          ? previewParts(request.input ?? {}).parts
          : request.kind === 'mail-send'
            ? [{ kind: 'text', text: mailPreviewText(request.mail) }]
            : (call?.input ?? []),
      adapterNote: request.kind === 'tool-request' ? request.note : null,
      ref: null,
    }
    return new Promise<ConfirmationAnswer>((resolve) => {
      /** How the signed request is to be closed, once the confirmation is settled. */
      let ended: { readonly answer: ConfirmationAnswer; readonly why: ConfirmationEnd | 'person' } | null =
        null
      const close = (requestId: string) => {
        if (ended === null || ended.answer === 'approved') return
        if (ended.why === 'person') this.options.signing.decline(requestId)
        else this.options.signing.withdraw(requestId, ended.why)
      }
      const settle = (answer: ConfirmationAnswer, why: ConfirmationEnd | 'person' = 'unanswered') => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        entry.answer = answer
        ended = { answer, why }
        this.options.timers.clearTimeout(entry.timer)
        if (entry.requestId !== null) close(entry.requestId)
        signal.removeEventListener('abort', onAbort)
        this.options.close(id)
        // The runtime's own deadline aborts the prompt at the same moment ours fires; a cancelled
        // call aborts it earlier, and nobody missed that.
        if (answer === 'timed-out' && this.options.now() >= Date.parse(item.expiresAt) - MISSED_SLACK_MS) {
          try {
            this.options.onMissed?.(item)
          } catch {
            // The answer stands whatever the record does.
          }
        }
        this.options.onChange()
        resolve(answer)
      }
      // The runtime aborts the prompt at its own deadline, the same moment as ours, or earlier when
      // the call ends (it records that as cancelled): the request is withdrawn as unanswered or as
      // cancelled to match.
      const onAbort = () =>
        settle(
          'timed-out',
          this.options.now() >= Date.parse(item.expiresAt) - MISSED_SLACK_MS
            ? 'unanswered'
            : 'call-cancelled',
        )
      const timer = this.options.timers.setTimeout(() => settle('timed-out'), this.options.timeoutMs)
      this.pending.set(id, {
        item,
        resolve: settle,
        requestId: null,
        answer: null,
        timer,
        cancel: (why) => settle('cancelled', why),
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.options.onChange()
      this.options.show(id)
      this.options.signing.open(item).then(
        (opened) => {
          const entry = this.pending.get(id)
          if (opened === null) return settle('declined')
          // Settled while the request was being made: close it the same way.
          if (entry === undefined) return close(opened.requestId)
          entry.requestId = opened.requestId
          entry.item = { ...entry.item, ref: opened.ref }
          this.options.onChange()
        },
        () => settle('declined'),
      )
    })
  }

  list(): ConfirmationItem[] {
    return [...this.pending.values()].map((p) => p.item)
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  /** Whether this confirmation still waits, with its signed request made: an approval may apply. */
  waiting(id: string): boolean {
    return (this.pending.get(id)?.requestId ?? null) !== null
  }

  /**
   * A signed approval of this confirmation's own request was applied: the call goes ahead. False if
   * it no longer waits (it timed out between the check and now).
   */
  approvedById(id: string): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined || entry.requestId === null) return false
    entry.resolve('approved')
    return true
  }

  /**
   * The panel's answer. A decline settles it at once. An approve only raises the Touch ID prompt,
   * and only from the panel opened for this request; it resolves once the person answered that:
   * true if approved, false if they cancelled the prompt.
   * Throws ConfirmationRefused for anything but a valid answer to a pending request.
   */
  async answer(id: string, approved: boolean, from: AppWindow): Promise<boolean> {
    const entry = this.pending.get(id)
    if (entry === undefined) throw new ConfirmationRefused()
    if (this.options.now() >= Date.parse(entry.item.expiresAt)) {
      entry.resolve('timed-out')
      throw new ConfirmationRefused()
    }
    if (!approved) {
      entry.resolve('declined', 'person')
      return true
    }
    // With two pending, panel A must not approve B, which the person never saw.
    if (from.role !== 'confirmation' || from.shows !== id) throw new ConfirmationRefused()
    if (entry.requestId === null) throw new ConfirmationRefused()
    const outcome = await this.options.signing.approve(entry.requestId)
    if (outcome === 'refused') throw new ConfirmationRefused()
    if (outcome === 'cancelled') return false
    // Signed, but it may have run out while the prompt was open: then the call was not approved.
    if (entry.answer !== 'approved') throw new ConfirmationRefused()
    return true
  }

  /**
   * Declines everything still waiting, e.g. on quit or lock down. Nobody answered them, so their
   * requests are withdrawn rather than declined: no agent is counted as declined for it.
   */
  declineAll(): void {
    for (const entry of [...this.pending.values()]) entry.resolve('declined')
  }

  /**
   * Ends, as cancelled, every confirmation waiting for one of the calls `match` picks: the person
   * revoked the agent that made them. Its request is withdrawn for that reason, the panel closes,
   * and the call ends at once rather than when its session does. Returns how many there were.
   */
  cancelWhere(
    match: (item: ConfirmationItem) => boolean,
    why: Exclude<ConfirmationEnd, 'unanswered'>,
  ): number {
    let count = 0
    for (const entry of [...this.pending.values()]) {
      if (!match(entry.item)) continue
      entry.cancel(why)
      count++
    }
    return count
  }
}

/** A send as the confirmation shows it: the envelope, one recipient per line, then the text. */
export function mailPreviewText(mail: MailPreview): string {
  const host = mail.endpoint.slice(0, mail.endpoint.lastIndexOf(':'))
  return [
    `From: your account at ${host}`,
    // One recipient per line, each in full: the signed preview the phone shows cuts long lines, and
    // must never cut an address (red team I). Bcc's note is a line of its own for the same reason.
    ...mail.to.map((a) => `To: ${a}`),
    ...mail.cc.map((a) => `Cc: ${a}`),
    ...(mail.bcc.length > 0 ? ['Bcc is not shown to the other recipients:'] : []),
    ...mail.bcc.map((a) => `Bcc: ${a}`),
    `Subject: ${mail.subject === '' ? '(no subject)' : mail.subject}`,
    ...(mail.inReplyTo === null ? [] : [`In reply to: ${mail.inReplyTo}`]),
    ...(mail.references.length > 0 ? [`References: ${mail.references.join(' ')}`] : []),
    '',
    mail.text,
  ].join('\n')
}
