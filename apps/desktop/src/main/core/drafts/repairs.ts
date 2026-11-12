// Repair tickets (docs/authoring-tools.md#repairs-pr-3): when an installed adapter's tool fails the
// same way twice in a row, in a way only a new version fixes, Valet opens a ticket an agent can
// read and fix. A ticket holds structured data only: ids, the hash, the tool, the stage and class.
// No page text, no exception messages, no values.
//
// Tickets are rebuilt from the audit log (tool-called and tool-finished), so they need no file of
// their own: the id is derived from the first failing call, and a later good call of the tool
// closes it.

import { createHash } from 'node:crypto'
import type { AuditEvent } from '@valet/core'

/** stage/class pairs only an adapter update fixes. `blocked-by-site` never is (D24): the breaker's. */
const REPAIRABLE: ReadonlySet<string> = new Set([
  'tool-output/invalid',
  'tool-output/site-changed',
  'tool-run/site-changed',
  'tool-run/element-missing',
  'tool-run/unexpected-shape',
  'request-surface/undeclared-request',
])

/** How many failures in a row open a ticket. */
const IN_A_ROW = 2
/** Closed tickets are kept this long, so an agent still sees how one ended. */
const KEEP_CLOSED_MS = 7 * 24 * 3600_000

export const REPAIR_ID = /^R-[A-Z2-7]{4}$/

export interface RepairTicket {
  readonly id: string
  readonly adapterId: string
  /** The version that failed. */
  readonly adapterHash: string
  readonly tool: string
  readonly stage: string
  readonly errorClass: string
  readonly openedAt: string
  readonly lastFailedAt: string
  /** The latest failing call, for the Mac's link to its trace. Never shown to an agent. */
  readonly lastCallId: string
  readonly failures: number
  /** Open until a later call of the tool ends well. */
  readonly state: 'open' | 'fixed'
  readonly fixedAt: string | null
}

interface Called {
  readonly adapterId: string
  readonly adapterHash: string
  readonly tool: string
}

interface Streak {
  readonly key: string
  readonly firstCallId: string
  readonly firstAt: string
  readonly adapterHash: string
  count: number
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** R- and four characters, from the first failing call's id. */
export function repairIdFor(callId: string): string {
  const digest = createHash('sha256').update(callId).digest()
  return `R-${[...digest.subarray(0, 4)].map((b) => BASE32[b % 32]).join('')}`
}

export class RepairTickets {
  private readonly calls = new Map<string, Called>()
  private readonly streaks = new Map<string, Streak>()
  private readonly tickets = new Map<string, RepairTicket>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Feeds one audit record. True when the tickets changed. */
  note(event: AuditEvent, at: string): boolean {
    if (event.type === 'tool-called') {
      this.calls.set(event.callId, {
        adapterId: event.adapterId,
        adapterHash: event.adapterHash,
        tool: event.tool,
      })
      // Calls that never finish (a crash) mustn't pile up.
      if (this.calls.size > 2000) this.calls.delete(this.calls.keys().next().value as string)
      return false
    }
    if (event.type !== 'tool-finished') return false
    const called = this.calls.get(event.callId)
    if (called === undefined) return false
    this.calls.delete(event.callId)
    const tool = `${called.adapterId}/${called.tool}`
    if (event.outcome === 'ok') {
      this.streaks.delete(tool)
      return this.closeFixed(called, at)
    }
    if (event.outcome !== 'failed' || event.stage === undefined || event.errorClass === undefined)
      return false
    const kind = `${event.stage}/${event.errorClass}`
    // The app's own refusals and passing trouble (rate limits, timeouts) say nothing about the code.
    if (!REPAIRABLE.has(kind)) return false
    const key = `${called.adapterHash}:${kind}`
    const streak = this.streaks.get(tool)
    if (streak === undefined || streak.key !== key) {
      this.streaks.set(tool, {
        key,
        firstCallId: event.callId,
        firstAt: at,
        adapterHash: called.adapterHash,
        count: 1,
      })
      return false
    }
    streak.count += 1
    if (streak.count < IN_A_ROW) return false
    const open = this.openFor(called.adapterId, called.tool, event.stage, event.errorClass)
    if (open !== undefined) {
      this.tickets.set(open.id, {
        ...open,
        lastFailedAt: at,
        lastCallId: event.callId,
        failures: open.failures + 1,
      })
      return true
    }
    const id = repairIdFor(streak.firstCallId)
    this.tickets.set(id, {
      id,
      adapterId: called.adapterId,
      adapterHash: called.adapterHash,
      tool: called.tool,
      stage: event.stage,
      errorClass: event.errorClass,
      openedAt: streak.firstAt,
      lastFailedAt: at,
      lastCallId: event.callId,
      failures: streak.count,
      state: 'open',
      fixedAt: null,
    })
    return true
  }

  /** Open tickets, and closed ones from the last week, newest first. */
  list(): RepairTicket[] {
    const cutoff = this.now() - KEEP_CLOSED_MS
    return [...this.tickets.values()]
      .filter((t) => t.state === 'open' || Date.parse(t.fixedAt ?? t.lastFailedAt) >= cutoff)
      .sort((a, b) => b.lastFailedAt.localeCompare(a.lastFailedAt))
  }

  get(id: string): RepairTicket | null {
    return this.tickets.get(id) ?? null
  }

  /** The adapter's open ticket, if any, for the Needs you item. */
  openForAdapter(adapterId: string): RepairTicket | null {
    return this.list().find((t) => t.adapterId === adapterId && t.state === 'open') ?? null
  }

  private openFor(
    adapterId: string,
    tool: string,
    stage: string,
    errorClass: string,
  ): RepairTicket | undefined {
    return [...this.tickets.values()].find(
      (t) =>
        t.state === 'open' &&
        t.adapterId === adapterId &&
        t.tool === tool &&
        t.stage === stage &&
        t.errorClass === errorClass,
    )
  }

  /**
   * A good call of the tool closes its tickets: a new version fixed it, or the site went back to
   * what the old one reads.
   */
  private closeFixed(called: Called, at: string): boolean {
    let changed = false
    for (const t of this.tickets.values()) {
      if (t.state !== 'open' || t.adapterId !== called.adapterId || t.tool !== called.tool) continue
      this.tickets.set(t.id, { ...t, state: 'fixed', fixedAt: at })
      changed = true
    }
    return changed
  }
}
