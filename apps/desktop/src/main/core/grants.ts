// A grant request from the renderer, checked against the manifest the person approved before
// anything is stored. The renderer only offers what it should; this is where it is enforced:
//
// - the exact hash installed now (a grant never carries to another hash);
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
  SiteAdapterError,
} from '@siteadapter/core'
import type { GrantInfo, GrantRequest, VaultItem } from '../../shared/api'
import { VAULT } from './constants'

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
    throw new SiteAdapterError('grant', 'invalid')
  }
  if (!check.available.has(request.provider)) throw new SiteAdapterError('grant', 'unavailable')

  let requested: readonly string[]
  let itemRef: string
  let title: string
  if (request.provider === 'messages') {
    if (request.secret !== MESSAGES_SECRET) throw new SiteAdapterError('grant', 'invalid')
    const declared = messagesSourcesIn(manifest.auth.steps).some((s) => s.sender === request.itemRef)
    if (!declared) throw new SiteAdapterError('grant', 'not-granted')
    requested = manifest.navigation
    itemRef = request.itemRef
    title = request.itemRef
  } else {
    if (request.secret === MESSAGES_SECRET || !Object.hasOwn(manifest.secrets, request.secret)) {
      throw new SiteAdapterError('grant', 'not-granted')
    }
    requested = manifest.secrets[request.secret]?.origins ?? []
    if (!VAULT_ITEM_ID.test(request.itemRef)) throw new SiteAdapterError('grant', 'invalid')
    const item = (await check.vaultItems(request.provider)).find((i) => i.id === request.itemRef)
    if (item === undefined) throw new SiteAdapterError('grant', 'not-found')
    itemRef = itemRefFor(request.provider, item.id)
    title = item.title
  }

  const origins = [...new Set(request.origins)]
  if (
    origins.length === 0 ||
    origins.length !== request.origins.length ||
    !origins.every((o) => isBareOrigin(o) && requested.includes(o))
  ) {
    throw new SiteAdapterError('grant', 'origin-mismatch')
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

/** The stored reference for a vault item: by id, so a renamed item can't redirect a grant (D43). */
export function itemRefFor(provider: ProviderKind, itemId: string): string {
  return provider === 'fake' ? itemId : `op://${VAULT}/${itemId}`
}

/** The opaque id the renderer knows an item by: the reverse of itemRefFor. */
export function itemIdOf(grant: Grant): string {
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
