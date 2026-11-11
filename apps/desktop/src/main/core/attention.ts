// Needs you (docs/ux/information-architecture.md, section 5): the order items are listed in, and the
// items nobody answered in time ("Missed: …"), which stay for 24 hours.
//
// Missed items live in missed.json, so a restart doesn't lose the record that a confirmation ran
// out while the person was away. A file that doesn't validate reads as none: they are a courtesy,
// and the audit log keeps what happened either way.

import { missedTitle } from '@valet/core'
import { z } from 'zod'
import { type AttentionItem, MISSED_KEEP_MS, type MissedItem, type MissedKind } from '../../shared/api'
import { JsonDocument } from './files'

/** When an item stops waiting (ms), or null for one with no deadline. */
export function attentionDeadline(item: AttentionItem): number | null {
  switch (item.kind) {
    case 'confirmation':
    case 'remote-consent':
      return Date.parse(item.expiresAt)
    case 'needs-user':
      return item.closesAt === null ? null : Date.parse(item.closesAt)
    case 'missed':
      return Date.parse(item.missedAt) + MISSED_KEEP_MS
    default:
      return null
  }
}

/** When an item was raised (ms), for the order of those with no deadline; unknown sorts last. */
function raisedAt(item: AttentionItem): number {
  switch (item.kind) {
    case 'confirmation':
    case 'remote-consent':
      return Date.parse(item.requestedAt)
    case 'needs-user':
    case 'repair':
    case 'missed':
      return Date.parse(item.at)
    default:
      return Number.POSITIVE_INFINITY
  }
}

/** Kinds that never wait on a clock and are equally old: listed in this order among themselves. */
const UNTIMED_ORDER: readonly AttentionItem['kind'][] = [
  'repair',
  'review',
  'setting-missing',
  'login-missing',
]

/**
 * Soonest deadline first; then items with no deadline, oldest first. A confirmation's two minutes
 * put it first in practice, as before; ties keep a confirmation ahead of anything else.
 */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  const rank = (item: AttentionItem): number => (item.kind === 'confirmation' ? 0 : 1)
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const da = attentionDeadline(a.item)
      const db = attentionDeadline(b.item)
      if (da !== null || db !== null) {
        if (da === null) return 1
        if (db === null) return -1
        if (da !== db) return da - db
        return rank(a.item) - rank(b.item) || a.index - b.index
      }
      const ra = raisedAt(a.item)
      const rb = raisedAt(b.item)
      if (ra !== rb) return ra < rb ? -1 : 1
      const ka = UNTIMED_ORDER.indexOf(a.item.kind)
      const kb = UNTIMED_ORDER.indexOf(b.item.kind)
      return ka - kb || a.index - b.index
    })
    .map(({ item }) => item)
}

const ISO = z.iso.datetime({ offset: true })
const missedSchema = z.array(
  z
    .object({
      kind: z.literal('missed'),
      id: z.string().max(80),
      of: z.enum(['confirmation', 'needs-user', 'remote-consent']),
      originalId: z.string().max(80),
      title: z.string().max(300),
      adapterId: z.string().max(64).nullable(),
      adapterName: z.string().max(200).nullable(),
      callId: z.string().max(64).nullable(),
      at: ISO,
      missedAt: ISO,
    })
    .strict(),
)

export interface MissedOptions {
  readonly path: string
  readonly now: () => number
  /** The list changed (an item was added, dismissed or expired). */
  readonly changed: () => void
}

/** What the original item was, to record it as missed. */
export interface MissedSource {
  readonly of: MissedKind
  /** The original item's id, so the missed one gets a stable id of its own. */
  readonly id: string
  /** The original item's title. */
  readonly title: string
  readonly adapterId: string | null
  readonly adapterName: string | null
  readonly callId: string | null
  readonly at: string
}

export class MissedItems {
  private items: MissedItem[] = []
  private saving: Promise<unknown> = Promise.resolve()
  private readonly document: JsonDocument<MissedItem[]>

  constructor(private readonly options: MissedOptions) {
    this.document = new JsonDocument<MissedItem[]>(options.path, missedSchema, () => [], true)
  }

  async load(): Promise<void> {
    this.items = await this.document.read()
    this.prune()
  }

  /** What is kept now, newest first. Expired ones go as they are read. */
  list(): MissedItem[] {
    if (this.prune()) this.save()
    return [...this.items]
  }

  add(source: MissedSource): MissedItem {
    const missedAt = this.options.now()
    const item: MissedItem = {
      kind: 'missed',
      id: `ms_${source.id}_${missedAt.toString(36)}`.slice(0, 64),
      of: source.of,
      originalId: source.id,
      title: missedTitle(source.title),
      adapterId: source.adapterId,
      adapterName: source.adapterName,
      callId: source.callId,
      at: source.at,
      missedAt: new Date(missedAt).toISOString(),
    }
    this.items = [item, ...this.items.filter((i) => i.id !== item.id)]
    this.save()
    this.options.changed()
    return item
  }

  /** False when no missed item has that id. */
  dismiss(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((i) => i.id !== id)
    if (this.items.length === before) return false
    this.save()
    this.options.changed()
    return true
  }

  /** The soonest a kept item expires (ms), for a timer; null when none is kept. */
  nextExpiry(): number | null {
    const times = this.items.map((i) => Date.parse(i.missedAt) + MISSED_KEEP_MS)
    return times.length === 0 ? null : Math.min(...times)
  }

  /** Drops what is past its 24 hours. True when any went. */
  prune(): boolean {
    const now = this.options.now()
    const kept = this.items.filter((i) => Date.parse(i.missedAt) + MISSED_KEEP_MS > now)
    if (kept.length === this.items.length) return false
    this.items = kept
    return true
  }

  /** Resolves once every save so far has reached the disk (or failed). */
  flushed(): Promise<void> {
    return this.saving.then(() => undefined)
  }

  private save(): void {
    const items = [...this.items]
    this.saving = this.document.update(() => items).catch(() => undefined)
  }
}
