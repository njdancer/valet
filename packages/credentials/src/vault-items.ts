// What the grant picker may learn about a vault: each item's id and title, nothing else. Both
// 1Password providers list through here, so the same rules apply whichever one the person uses.

import { isItemName } from './item-ref'

/** One item in a vault, as the grant picker shows it. Never a field value. */
export interface VaultItemSummary {
  /** 1Password's opaque item id, which a grant's `op://<vault>/<id>` reference names. */
  readonly id: string
  /** The item's title, with control and format characters removed, at most 200 characters. */
  readonly title: string
}

/** A provider that can list a vault. Both 1Password providers implement it. */
export interface VaultItemLister {
  /**
   * The vault's active items, by vault name or id. Rejects with CredentialError: `not-found` for a
   * vault name that isn't a valid name or matches no vault (or more than one), `locked` when 1Password
   * waits for the person, `unavailable` otherwise.
   */
  listItems(vault: string): Promise<readonly VaultItemSummary[]>
}

// 1Password item ids are 26 lowercase base-32 characters today. Allow some room, but nothing that
// could add a path segment or a query to op://<vault>/<id>.
const ITEM_ID = /^[a-z0-9]{1,64}$/i
const MAX_TITLE = 200
// Enough for any real vault; more is not what we asked for.
export const MAX_VAULT_ITEMS = 10_000

/** True when `vault` is a name or id a reference may use. */
export function isVaultName(vault: string): boolean {
  return isItemName(vault)
}

/**
 * Keeps only `id` and `title` of each entry, drops entries without a usable id or a string title,
 * and strips control and format characters (bidi overrides among them) from titles.
 */
export function summariseItems(entries: unknown): VaultItemSummary[] {
  if (!Array.isArray(entries)) return []
  const items: VaultItemSummary[] = []
  for (const entry of entries as unknown[]) {
    if (items.length >= MAX_VAULT_ITEMS) break
    const summary = summarise(entry)
    if (summary !== null) items.push(summary)
  }
  return items
}

function summarise(entry: unknown): VaultItemSummary | null {
  if (entry === null || typeof entry !== 'object') return null
  let id: unknown
  let title: unknown
  try {
    ;({ id, title } = entry as { id?: unknown; title?: unknown })
  } catch {
    // A getter that throws is not an item.
    return null
  }
  if (typeof id !== 'string' || !ITEM_ID.test(id) || typeof title !== 'string') return null
  // By code point, so a title cut at the limit never ends in half a surrogate pair.
  return { id, title: [...title.replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, MAX_TITLE).join('') }
}

/** Parses `op item list --format json`, or returns null for output that isn't a JSON array. */
export function parseOpItemList(stdout: string): VaultItemSummary[] | null {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return null
  }
  return Array.isArray(value) ? summariseItems(value) : null
}
