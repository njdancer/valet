// A grant request from the renderer, checked against the manifest the person approved before
// anything is stored. The renderer only offers what it should; this is where it is enforced:
//
// - the exact hash installed now (a grant reaches another hash only through an approved update that
//   doesn't widen it: carriesOver, below);
// - a provider that is available in this launch (the fake only in demo mode);
// - a secret the manifest requests (never the reserved Messages name for a vault item), or for
//   Messages a sender the manifest declares, character for character;
// - origins that are a non-empty subset of what the manifest asks for: the secret's origins, or for
//   Messages the navigation origins;
// - an item the provider lists right now, by its opaque id; the stored reference is built here.

import {
  type AdapterManifest,
  type Grant,
  isBareOrigin,
  MESSAGES_SECRET,
  messagesSourcesIn,
  type ProviderKind,
  ValetError,
} from '@valet/core'
import type { GrantInfo, GrantRequest, VaultItem } from '../../shared/api'
import { VAULT } from './constants'
import { permissionDiff } from './permission-diff'

export interface GrantCheck {
  readonly manifest: AdapterManifest
  /** The hash installed and registered now. */
  readonly installedHash: string
  readonly available: ReadonlySet<ProviderKind>
  /** The provider's items right now. Only called for vault providers. */
  readonly vaultItems: (provider: ProviderKind) => Promise<readonly VaultItem[]>
  readonly now: () => Date
}

export interface CheckedGrant {
  readonly grant: Grant
  /** What the grant sheet will show for it later: an item title or the sender. */
  readonly title: string
}

const VAULT_ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/

export async function checkGrantRequest(request: GrantRequest, check: GrantCheck): Promise<CheckedGrant> {
  const { manifest } = check
  if (request.adapterId !== manifest.id || request.adapterHash !== check.installedHash) {
    throw new ValetError('grant', 'invalid')
  }
  if (!check.available.has(request.provider)) throw new ValetError('grant', 'unavailable')

  let requested: readonly string[]
  let itemRef: string
  let title: string
  if (request.provider === 'messages') {
    if (request.secret !== MESSAGES_SECRET) throw new ValetError('grant', 'invalid')
    const declared = messagesSourcesIn(manifest.auth.steps).some((s) => s.sender === request.itemRef)
    if (!declared) throw new ValetError('grant', 'not-granted')
    requested = manifest.navigation
    itemRef = request.itemRef
    title = request.itemRef
  } else {
    if (request.secret === MESSAGES_SECRET || !Object.hasOwn(manifest.secrets, request.secret)) {
      throw new ValetError('grant', 'not-granted')
    }
    requested = manifest.secrets[request.secret]?.origins ?? []
    if (!VAULT_ITEM_ID.test(request.itemRef)) throw new ValetError('grant', 'invalid')
    const item = (await check.vaultItems(request.provider)).find((i) => i.id === request.itemRef)
    if (item === undefined) throw new ValetError('grant', 'not-found')
    itemRef = itemRefFor(request.provider, item.id)
    title = item.title
  }

  const origins = [...new Set(request.origins)]
  if (
    origins.length === 0 ||
    origins.length !== request.origins.length ||
    !origins.every((o) => isBareOrigin(o) && requested.includes(o))
  ) {
    throw new ValetError('grant', 'origin-mismatch')
  }
  // In the manifest's order, so the stored grant reads like the request it narrows.
  const ordered = requested.filter((o) => origins.includes(o))

  return {
    grant: {
      adapterId: manifest.id,
      adapterHash: check.installedHash,
      secret: request.secret,
      provider: request.provider,
      itemRef,
      origins: ordered,
      grantedAt: check.now().toISOString(),
    },
    title,
  }
}

// A Keychain copy's item comes from any of the person's vaults: the grant sheet knows it as
// `<vault id>-<item id>` (credentials.ts's desktopItems), and both ids are letters and digits.
const COPY_ITEM_ID = /^([A-Za-z0-9]{1,31})-([A-Za-z0-9]{1,32})$/

/** The stored reference for a vault item: by id, so a renamed item can't redirect a grant (D43). */
export function itemRefFor(provider: ProviderKind, itemId: string): string {
  if (provider === 'fake') return itemId
  if (provider === 'keychain-copy') {
    const ids = COPY_ITEM_ID.exec(itemId)
    if (ids === null) throw new ValetError('grant', 'invalid')
    return `op://${ids[1]}/${ids[2]}`
  }
  return `op://${VAULT}/${itemId}`
}

/** The opaque id the renderer knows an item by: the reverse of itemRefFor. */
export function itemIdOf(grant: Grant): string {
  if (grant.provider === 'keychain-copy' && grant.itemRef.startsWith('op://')) {
    return grant.itemRef.slice('op://'.length).replace('/', '-')
  }
  const prefix = `op://${VAULT}/`
  if (grant.provider === 'onepassword-cli' || grant.provider === 'onepassword-service-account') {
    return grant.itemRef.startsWith(prefix) ? grant.itemRef.slice(prefix.length) : grant.itemRef
  }
  return grant.itemRef
}

export function grantInfo(
  grant: Grant,
  titles: Readonly<Record<string, string>>,
  lastUsedAt: string | null,
): GrantInfo {
  const itemId = itemIdOf(grant)
  return {
    adapterId: grant.adapterId,
    adapterHash: grant.adapterHash,
    secret: grant.secret,
    provider: grant.provider,
    itemId,
    itemTitle:
      grant.provider === 'messages'
        ? grant.itemRef
        : Object.hasOwn(titles, grant.itemRef)
          ? (titles[grant.itemRef] as string)
          : '(item)',
    origins: [...grant.origins],
    grantedAt: grant.grantedAt,
    lastUsedAt,
  }
}

/**
 * Whether `grant`, made for the version with manifest `before`, can be kept by the update to
 * `after` without asking again (D47, docs/approval-broker.md#grants-across-an-update): the update
 * doesn't widen what the grant covers. The secret is still requested, for the same or fewer fields
 * and origins, and every origin the grant names is still among them; it is typed into no new field
 * or selector; the login loads no new frame origin. For a Messages grant, its sender is still read
 * with the same pattern and age, and the navigation origins it may be typed into don't grow.
 * Anything else is a widening, and the person grants again.
 */
export function carriesOver(grant: Grant, before: AdapterManifest, after: AdapterManifest): boolean {
  if (grant.adapterId !== before.id || grant.adapterId !== after.id) return false
  const diff = permissionDiff(before, after)
  if (diff.frameOrigins.added.length > 0) return false
  const within = (next: readonly string[], prev: readonly string[]) => next.every((o) => prev.includes(o))
  if (grant.provider === 'messages' || grant.secret === MESSAGES_SECRET) {
    if (grant.provider !== 'messages' || grant.secret !== MESSAGES_SECRET) return false
    const source = (m: AdapterManifest) =>
      messagesSourcesIn(m.auth.steps).filter((s) => s.sender === grant.itemRef)
    const was = source(before)
    const now = source(after)
    if (was.length === 0 || now.length === 0) return false
    // Every way the new version reads this sender's codes is one the approved version had.
    const same = (a: { pattern: string; maxAgeSeconds: number }, b: typeof a) =>
      a.pattern === b.pattern && a.maxAgeSeconds === b.maxAgeSeconds
    if (!now.every((n) => was.some((w) => same(n, w)))) return false
    if (!within(after.navigation, before.navigation)) return false
    return grant.origins.length > 0 && within(grant.origins, after.navigation)
  }
  const was = before.secrets[grant.secret]
  const now = after.secrets[grant.secret]
  if (!Object.hasOwn(before.secrets, grant.secret) || !Object.hasOwn(after.secrets, grant.secret))
    return false
  if (was === undefined || now === undefined) return false
  if (!within(now.fields, was.fields) || !within(now.origins, was.origins)) return false
  if (grant.origins.length === 0 || !within(grant.origins, now.origins)) return false
  return !diff.secretFills.added.some((f) => f.secret === grant.secret)
}
