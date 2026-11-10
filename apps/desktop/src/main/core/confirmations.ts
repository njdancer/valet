// The runtime's ConfirmationPrompt, answered in the app's own floating panel and never by an MCP
// client. Everything on the panel but the adapter's note is the runtime's own knowledge.
//
// An approval counts only when:
// - it comes from the confirmation window opened for this very request, not another confirmation
//   panel (decline is accepted from any app window);
// - the window has been shown, and CONFIRM_ARM_MS have passed since it was last shown or focused,
//   so a click already on its way in another app can't land on Approve;
// - the request is still pending and hasn't expired. Unanswered, it declines itself at expiry.

import type { AdapterManifest } from '@valet/core'
import type { ConfirmationAnswer, ConfirmationPrompt, ConfirmationRequest } from '@valet/runtime'
import { CONFIRM_ARM_MS, type ConfirmationItem, type PreviewPart } from '../../shared/api'
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

export interface ConfirmationBrokerOptions {
  readonly adapter: (adapterId: string) => ConfirmationAdapter | null
  /** The client's input as it sent it. */
  readonly call: (callId: string) => { readonly input: readonly PreviewPart[] } | null
  readonly show: (id: string) => void
  readonly close: (id: string) => void
  readonly onChange: () => void
  readonly now: () => number
  readonly timeoutMs: number
  readonly timers: Timers
  readonly newId: () => string
}

interface Pending {
  readonly item: ConfirmationItem
  readonly resolve: (answer: ConfirmationAnswer) => void
  armedAt: number | null
  readonly timer: unknown
}

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
      // Only the runtime's own confirmation before an irreversible tool unlocks anything.
      unlocks: irreversible ? adapter.manifest.requests.filter((r) => r.purpose === 'irreversible') : [],
      requests: irreversible
        ? []
        : request.requests.map(({ method, path, purpose }) => ({ method, path, purpose })),
      input: irreversible ? previewParts(request.input ?? {}).parts : (call?.input ?? []),
      adapterNote: irreversible ? null : request.note,
    }
    return new Promise<ConfirmationAnswer>((resolve) => {
      const settle = (answer: ConfirmationAnswer) => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        this.options.timers.clearTimeout(entry.timer)
        signal.removeEventListener('abort', onAbort)
        this.options.close(id)
        this.options.onChange()
        resolve(answer)
      }
      const onAbort = () => settle('timed-out')
      const timer = this.options.timers.setTimeout(() => settle('timed-out'), this.options.timeoutMs)
      this.pending.set(id, { item, resolve: settle, armedAt: null, timer })
      signal.addEventListener('abort', onAbort, { once: true })
      this.options.onChange()
      this.options.show(id)
    })
  }

  list(): ConfirmationItem[] {
    return [...this.pending.values()].map((p) => p.item)
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  /** The confirmation window was shown or regained focus: approvals wait CONFIRM_ARM_MS again. */
  armed(id: string): void {
    const entry = this.pending.get(id)
    if (entry !== undefined) entry.armedAt = this.options.now()
  }

  /** Throws ConfirmationRefused for anything but a valid answer to a pending request. */
  answer(id: string, approved: boolean, from: AppWindow): void {
    const entry = this.pending.get(id)
    if (entry === undefined) throw new ConfirmationRefused()
    const now = this.options.now()
    if (now >= Date.parse(entry.item.expiresAt)) {
      entry.resolve('timed-out')
      throw new ConfirmationRefused()
    }
    if (approved) {
      // With two pending, panel A must not approve B, which the person never saw armed.
      if (from.role !== 'confirmation' || from.shows !== id) throw new ConfirmationRefused()
      if (entry.armedAt === null || now - entry.armedAt < CONFIRM_ARM_MS) throw new ConfirmationRefused()
    }
    entry.resolve(approved ? 'approved' : 'declined')
  }

  /** Declines everything still waiting, e.g. on quit. */
  declineAll(): void {
    for (const entry of [...this.pending.values()]) entry.resolve('declined')
  }
}
