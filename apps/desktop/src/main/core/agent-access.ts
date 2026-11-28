// What each agent may use in the Mac's own apps (docs/access.md): Mail accounts, calendars and
// reminder lists, each at Read or Edit, and for Calendar and Reminders whether it may add and
// remove whole calendars or lists. One record per agent, local or cloud, by its credential's id
// (`local:<id>`, `remote:<id>`).
//
// The apps' own tools follow from it: an agent holds an app's reading tools while it may read
// anything there, and its changing tools while it may edit something. Every call checks the item
// it touches against the calling agent's own record, so an agent can't reach a calendar that is
// another agent's.
//
// Widening a record needs the person's signature (an `agent-access` approval); narrowing never
// does. agent-access.json is the cautious side when it doesn't validate: nobody has anything.

import { lstat } from 'node:fs/promises'
import { isDisplayText } from '@valet/core'
import { z } from 'zod'
import { JsonDocument } from './files'

/**
 * An account's, calendar's or list's name for the signed card: display text of at most 80 UTF-16
 * units, cut on a whole character. One that isn't (control or format characters) shows as
 * "Untitled".
 */
export function accessLabel(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  let out = ''
  for (const c of flat) {
    if (out.length + c.length > 80) break
    out += c
  }
  return out !== '' && isDisplayText(out) ? out : 'Untitled'
}

export const ACCESS_APPS = ['mail', 'calendar', 'reminders'] as const
export type AccessApp = (typeof ACCESS_APPS)[number]
export type AccessLevel = 'read' | 'edit'
/** The apps whose calendars or lists an agent may be let add and remove. */
export const FULL_ACCESS_APPS = ['calendar', 'reminders'] as const
export type FullAccessApp = (typeof FULL_ACCESS_APPS)[number]

/** The app whose own tools an adapter id names ('mail', 'calendar', 'reminders'), or null. */
export function accessAppOf(adapterId: string): AccessApp | null {
  return (ACCESS_APPS as readonly string[]).includes(adapterId) ? (adapterId as AccessApp) : null
}

export interface AppAccess {
  readonly items: Readonly<Record<string, AccessLevel>>
  readonly full: boolean
}

export type ClientAccess = Readonly<Partial<Record<AccessApp, AppAccess>>>

export const NO_APP_ACCESS: AppAccess = { items: {}, full: false }

/** Items one agent may have in one app: more than any Mac has, and what the file allows. */
export const MAX_ACCESS_ITEMS = 500

const RANK: Readonly<Record<AccessLevel | 'off', number>> = { off: 0, read: 1, edit: 2 }

const itemId = z.string().min(1).max(200)
const level = z.enum(['read', 'edit'])
const appAccess = z
  .object({
    items: z.record(itemId, level).refine((r) => Object.keys(r).length <= MAX_ACCESS_ITEMS, 'too many items'),
    full: z.boolean(),
  })
  .strict()
const clientId = z.string().regex(/^(?:local|remote):[A-Za-z0-9_-]{1,64}$/)

const documentSchema = z
  .object({
    v: z.literal(1),
    /** Whether the first run seeded records from the old per-app settings (see `seed`). */
    seeded: z.boolean(),
    clients: z.record(
      clientId,
      z
        .object({
          mail: appAccess.optional(),
          calendar: appAccess.optional(),
          reminders: appAccess.optional(),
        })
        .strict(),
    ),
  })
  .strict()

type AccessDocument = z.infer<typeof documentSchema>

const EMPTY: AccessDocument = { v: 1, seeded: false, clients: {} }

/** A Save's change to one app: each item's new level ('off' takes it away), and full access. */
export interface AppAccessChange {
  readonly items: Readonly<Record<string, AccessLevel | 'off'>>
  readonly full?: boolean
}

/** What a change adds: the items raised (to their new level), and whether full access goes on. */
export interface AccessWidening {
  readonly items: readonly { readonly id: string; readonly level: AccessLevel }[]
  readonly full: boolean
}

/** The record after a change; items not named keep their level. */
export function applyAccessChange(before: AppAccess, change: AppAccessChange): AppAccess {
  const items: Record<string, AccessLevel> = { ...before.items }
  for (const [id, next] of Object.entries(change.items)) {
    if (next === 'off') delete items[id]
    else items[id] = next
  }
  return { items, full: change.full ?? before.full }
}

/** What going from `before` to `after` adds, which is what needs the person's signature. */
export function accessWidening(before: AppAccess, after: AppAccess): AccessWidening {
  const items: { id: string; level: AccessLevel }[] = []
  for (const [id, next] of Object.entries(after.items)) {
    if (RANK[next] > RANK[before.items[id] ?? 'off']) items.push({ id, level: next })
  }
  return { items, full: after.full && !before.full }
}

/** The record with these raised (never lowered): what an approved widening applies. */
export function withWidening(before: AppAccess, widening: AccessWidening): AppAccess {
  const items: Record<string, AccessLevel> = { ...before.items }
  for (const { id, level } of widening.items) {
    if (RANK[level] > RANK[items[id] ?? 'off']) items[id] = level
  }
  return { items, full: before.full || widening.full }
}

/** The ids it may read (Read or Edit), and the ids it may change. */
export function readableIds(access: AppAccess): ReadonlySet<string> {
  return new Set(Object.keys(access.items))
}

export function editableIds(access: AppAccess): ReadonlySet<string> {
  return new Set(Object.entries(access.items).flatMap(([id, l]) => (l === 'edit' ? [id] : [])))
}

/** Whether the record lets it read anything, change anything, or add and remove whole lists. */
export function accessReach(access: AppAccess): { readonly read: boolean; readonly edit: boolean } {
  const levels = Object.values(access.items)
  return { read: levels.length > 0, edit: levels.includes('edit') }
}

export class AgentAccessStore {
  private readonly document: JsonDocument<AccessDocument>
  private current: AccessDocument = EMPTY

  constructor(private readonly path: string) {
    this.document = new JsonDocument(path, documentSchema, () => EMPTY, true)
  }

  /** Never throws: a file that can't be read is nobody having anything. */
  async load(): Promise<void> {
    try {
      this.current = await this.document.read()
    } catch {
      this.current = EMPTY
    }
    // Only `seed` writes a file, and always seeded: one read back unseeded didn't validate. The
    // seed must not run again from the old per-app picks (it could give back what the person took
    // away), so it counts as seeded, with nobody having anything.
    if (!this.current.seeded && (await exists(this.path)))
      await this.update(() => ({ ...EMPTY, seeded: true }))
  }

  /** False until `seed` ran once. */
  get seeded(): boolean {
    return this.current.seeded
  }

  clientIds(): readonly string[] {
    return Object.keys(this.current.clients)
  }

  get(clientId: string): ClientAccess {
    return this.current.clients[clientId] ?? {}
  }

  app(clientId: string, app: AccessApp): AppAccess {
    return this.current.clients[clientId]?.[app] ?? NO_APP_ACCESS
  }

  /** Every agent's level for each item of one app, for the app's own settings screen. */
  usage(app: AccessApp): ReadonlyMap<string, readonly { clientId: string; level: AccessLevel }[]> {
    const out = new Map<string, { clientId: string; level: AccessLevel }[]>()
    for (const [clientId, access] of Object.entries(this.current.clients)) {
      for (const [id, l] of Object.entries(access[app]?.items ?? {}))
        out.set(id, [...(out.get(id) ?? []), { clientId, level: l }])
    }
    return out
  }

  /** Sets one app's record for one agent. The caller has the signature for anything it widens. */
  async set(clientId: string, app: AccessApp, next: AppAccess): Promise<void> {
    await this.update((doc) => {
      const client = { ...(doc.clients[clientId] ?? {}) }
      if (Object.keys(next.items).length === 0 && !next.full) delete client[app]
      else client[app] = { items: { ...next.items }, full: next.full }
      const clients = { ...doc.clients }
      if (Object.keys(client).length === 0) delete clients[clientId]
      else clients[clientId] = client
      return { ...doc, clients }
    })
  }

  /**
   * Gives an agent Edit on a calendar or list it just created, read and written in one step: only
   * while its record, as saved at that moment, still has Full access. A Save that took Full away
   * (or narrowed anything) while the call ran is never undone by it. True when it was given.
   */
  async addCreated(clientId: string, app: AccessApp, id: string): Promise<boolean> {
    let given = false
    await this.update((doc) => {
      const current = doc.clients[clientId]?.[app]
      if (current === undefined || !current.full) return doc
      given = true
      const client = {
        ...doc.clients[clientId],
        [app]: { ...current, items: { ...current.items, [id]: 'edit' } },
      }
      return { ...doc, clients: { ...doc.clients, [clientId]: client } }
    })
    return given
  }

  /** Takes an item away from every agent (it is gone from the Mac, say). */
  async dropItem(app: AccessApp, id: string): Promise<void> {
    if (!Object.values(this.current.clients).some((c) => c[app]?.items[id] !== undefined)) return
    await this.update((doc) => {
      const clients: AccessDocument['clients'] = {}
      for (const [clientId, access] of Object.entries(doc.clients)) {
        const current = access[app]
        if (current === undefined || current.items[id] === undefined) {
          clients[clientId] = access
          continue
        }
        const items = { ...current.items }
        delete items[id]
        clients[clientId] = { ...access, [app]: { ...current, items } }
      }
      return { ...doc, clients }
    })
  }

  /** The agent is gone: nothing is kept for it. */
  async forget(clientId: string): Promise<void> {
    if (this.current.clients[clientId] === undefined) return
    // Never throws: it follows a revoke that has already happened, and a record a failed write
    // leaves is never reached (a revoked agent holds nothing).
    try {
      await this.update((doc) => {
        const clients = { ...doc.clients }
        delete clients[clientId]
        return { ...doc, clients }
      })
    } catch {
      // As above.
    }
  }

  /**
   * The first run after the change from per-app picks to per-agent records: each agent keeps
   * exactly what it could reach before, so nothing widens and nothing needs signing.
   */
  async seed(records: Readonly<Record<string, ClientAccess>>): Promise<void> {
    await this.update((doc) => {
      if (doc.seeded) return doc
      const clients = { ...doc.clients }
      for (const [clientId, access] of Object.entries(records)) {
        const kept = Object.fromEntries(
          Object.entries(access).filter(
            ([, a]) => a !== undefined && (Object.keys(a.items).length > 0 || a.full),
          ),
        )
        if (Object.keys(kept).length > 0) clients[clientId] = { ...kept, ...(clients[clientId] ?? {}) }
      }
      return { v: 1, seeded: true, clients }
    })
  }

  private async update(change: (doc: AccessDocument) => AccessDocument): Promise<void> {
    this.current = await this.document.update(change)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}
