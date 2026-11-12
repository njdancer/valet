// The runtime's ConfirmationPrompt, answered in the app's own floating panel and never by an MCP
// client. Everything on the panel but the adapter's note is the runtime's own knowledge.
//
// Each confirmation is also a signed request of the approval broker (an `irreversible-call`, never
// remembered), so a click alone never approves anything (docs/approval-broker.md#approving-at-the-mac):
// - Approve is accepted only from the confirmation window opened for this very request, and all it
//   does is raise the OS's Touch ID prompt; the approval counts once the Mac's approval key signed
//   it, which needs the person's finger. A paired phone may approve it the same way.
// - Decline is accepted from any app window, and needs nothing: it only tightens.
// - Unanswered, it declines itself at expiry, and its request is withdrawn.

import { type AdapterManifest, unlockedBy } from '@valet/core'
import type { ConfirmationAnswer, ConfirmationPrompt, ConfirmationRequest } from '@valet/runtime'
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
  /** Withdraws it: the confirmation was declined, timed out or cancelled. */
  withdraw(requestId: string): void
}

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
  readonly resolve: (answer: ConfirmationAnswer) => void
  /** The broker's request, once made. Approve is refused until then. */
  requestId: string | null
  readonly timer: unknown
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
      requests: irreversible
        ? []
        : request.requests.map(({ method, path, purpose }) => ({ method, path, purpose })),
      input: irreversible ? previewParts(request.input ?? {}).parts : (call?.input ?? []),
      adapterNote: irreversible ? null : request.note,
      ref: null,
    }
    return new Promise<ConfirmationAnswer>((resolve) => {
      const settle = (answer: ConfirmationAnswer) => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        this.options.timers.clearTimeout(entry.timer)
        if (entry.requestId !== null && answer !== 'approved') this.options.signing.withdraw(entry.requestId)
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
      const onAbort = () => settle('timed-out')
      const timer = this.options.timers.setTimeout(() => settle('timed-out'), this.options.timeoutMs)
      this.pending.set(id, { item, resolve: settle, requestId: null, timer })
      signal.addEventListener('abort', onAbort, { once: true })
      this.options.onChange()
      this.options.show(id)
      this.options.signing.open(item).then(
        (opened) => {
          const entry = this.pending.get(id)
          if (opened === null) return settle('declined')
          if (entry === undefined) return this.options.signing.withdraw(opened.requestId)
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

  /** Whether a confirmation for this call is waiting: an approval for it may still be applied. */
  hasCall(callId: string): boolean {
    return [...this.pending.values()].some((p) => p.item.callId === callId && p.requestId !== null)
  }

  /**
   * A signed approval of this call's confirmation was applied: the call goes ahead. A run asks one
   * confirmation at a time, so the call names it.
   */
  approvedCall(callId: string): boolean {
    const entry = [...this.pending.values()].find((p) => p.item.callId === callId && p.requestId !== null)
    if (entry === undefined) return false
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
      entry.resolve('declined')
      return true
    }
    // With two pending, panel A must not approve B, which the person never saw.
    if (from.role !== 'confirmation' || from.shows !== id) throw new ConfirmationRefused()
    if (entry.requestId === null) throw new ConfirmationRefused()
    const outcome = await this.options.signing.approve(entry.requestId)
    if (outcome === 'refused') throw new ConfirmationRefused()
    return outcome === 'approved'
  }

  /** Declines everything still waiting, e.g. on quit. */
  declineAll(): void {
    for (const entry of [...this.pending.values()]) entry.resolve('declined')
  }
}
