// Credential grants in the app (secrets v2, docs/adapter-kinds.md#f2-secrets-version-2): the
// person grants one of an adapter version's declared credentials an item from a provider, signed
// with Touch ID or on the phone as a `credential-grant`; each call's CredentialGate then finds the
// grant through sourceFor, which hands out only a grant whose signature still counts.
//
// A grant counts when:
// - signed `credential-grant` evidence names exactly it (version, credential, provider, item,
//   targets within those signed); or
// - an approved update kept it (carry): the update's signed install said it inherits the session,
//   the old version's grant was signed, and the new declaration widens nothing
//   (credentialCarriesOver). The ledger records the carry; it counts while that install's
//   evidence does.
//
// Nothing here ever reads a secret's value except resolve, which only a CredentialGate calls.

import {
  type AdapterManifest,
  type ApprovalKind,
  type ApprovalSubject,
  type AuditEvent,
  type CredentialDeclaration,
  type CredentialGrant,
  type CredentialGrantStore,
  type CredentialProvider,
  credentialsOf,
  credentialTargets,
  describeCredentialUse,
  type ItemField,
  isDisplayText,
  type ProviderKind,
  type SecretValue,
  ValetError,
} from '@valet/core'
import { CredentialResolver, isValetKeyRef, type ValetKeyInfo, type ValetKeys } from '@valet/credentials'
import { itemFingerprint } from './approvals/subjects'
import { credentialCarriesOver, itemRefFor } from './grants'

/** Providers a credential grant may name. Messages codes are not a credential. */
export const CREDENTIAL_PROVIDERS = [
  'keychain-copy',
  'onepassword-service-account',
  'onepassword-desktop',
  'valet-key',
] as const
export type CredentialProviderKind = (typeof CREDENTIAL_PROVIDERS)[number]

/** A carry the ledger records: which grant an approved update kept, and for which install. */
export interface CarriedCredential {
  readonly adapterId: string
  readonly fromHash: string
  readonly toHash: string
  readonly credential: string
  readonly provider: CredentialProviderKind
  readonly itemFingerprint: string
  readonly targets: readonly string[]
  readonly at: string
}

export interface CredentialGrantRequest {
  readonly adapterId: string
  /** The exact version the person is granting for. A grant never names another. */
  readonly adapterHash: string
  readonly credential: string
  readonly provider: CredentialProviderKind
  /** The vault item's id as the provider listed it, or a Valet-made key's reference. */
  readonly itemId: string
  /** Within the declaration's; all of them when left out. */
  readonly targets?: readonly string[]
}

export interface CredentialGrantInfo {
  readonly adapterId: string
  readonly adapterHash: string
  readonly credential: string
  readonly kind: CredentialGrant['kind']
  readonly custody: CredentialGrant['custody']
  readonly provider: CredentialProviderKind
  readonly itemTitle: string
  readonly targets: readonly string[]
  readonly grantedAt: string
  /** A Valet-made key's public half, for the server's authorized_keys. */
  readonly publicKey: string | null
  readonly fingerprint: string | null
  /** False when the grant's signature no longer counts (the version changed, or it was revoked). */
  readonly signed: boolean
}

export interface CredentialKeeperDeps {
  readonly store: CredentialGrantStore
  /** The installed version of an adapter, or null. */
  readonly adapter: (
    adapterId: string,
  ) => { readonly hash: string; readonly manifest: AdapterManifest } | null
  /** Asks the person at the Mac (Touch ID), as approveHere does. True once signed. */
  readonly approve: (subject: ApprovalSubject<'credential-grant'>) => Promise<boolean>
  /** Signed evidence that still counts (ApprovalBroker.honoured), or null without a broker. */
  readonly honoured: <K extends ApprovalKind>(
    kind: K,
    matches: (subject: ApprovalSubject<K>) => boolean,
  ) => unknown | null
  /** Takes signed evidence away (ApprovalBroker.revoke). */
  readonly revokeEvidence: (
    matches: (subject: ApprovalSubject<'credential-grant'>) => boolean,
  ) => Promise<void>
  /** The ledger's carries, or null when it can't be trusted (tampered, or none). */
  readonly carried: () => readonly CarriedCredential[] | null
  /** Records one adapter's carries, replacing older ones for that adapter. */
  readonly recordCarried: (adapterId: string, records: readonly CarriedCredential[]) => Promise<void>
  /** Takes carries away (a revoke, an uninstall). Only tightens. */
  readonly dropCarried: (matches: (record: CarriedCredential) => boolean) => Promise<void>
  /** The providers this launch has (Credentials.providers()). */
  readonly providers: () => Partial<Record<ProviderKind, CredentialProvider>>
  /** Valet-made SSH keys, or null in a build without a Keychain. */
  readonly keys: ValetKeys | null
  /** Providers this launch can use now. */
  readonly available: () => Promise<ReadonlySet<ProviderKind>>
  /** Items the person may pick, title only (Credentials.vaultItems). */
  readonly vaultItems: (
    provider: ProviderKind,
  ) => Promise<readonly { readonly id: string; readonly title: string }[]>
  /** Copies fields of an item into the Keychain, with the person approving in 1Password. */
  readonly copyItem: (itemRef: string, fields: readonly ItemField[]) => Promise<void>
  readonly audit: { append(event: AuditEvent): Promise<unknown> }
  readonly now: () => number
}

const TITLE_MAX = 120
const VAULT_ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/

export class CredentialKeeper {
  readonly #deps: CredentialKeeperDeps
  /** Titles of items granted in this launch, by item reference: shown, never trusted. */
  readonly #titles = new Map<string, string>()

  constructor(deps: CredentialKeeperDeps) {
    this.#deps = deps
  }

  /**
   * What one registered version's calls find their credentials through: only grants for exactly
   * `adapterHash` whose signature counts. The gate checks the grant against the manifest again.
   */
  sourceFor(
    adapterId: string,
    adapterHash: string,
  ): {
    findGrant(credential: string): Promise<CredentialGrant | null>
    resolve(grant: CredentialGrant, field: ItemField): Promise<SecretValue>
  } {
    return {
      findGrant: async (credential) => {
        const grant = await this.#deps.store.find(adapterId, adapterHash, credential)
        return grant !== null && this.counts(grant) ? grant : null
      },
      resolve: (grant, field) => this.#resolver().resolve(grant, field),
    }
  }

  /** Whether `grant`'s signature counts now: its own evidence, or a carry by an approved update. */
  counts(grant: CredentialGrant): boolean {
    return this.#signed(grant) || this.#carried(grant)
  }

  async list(): Promise<readonly CredentialGrantInfo[]> {
    const grants = await this.#deps.store.list()
    const out: CredentialGrantInfo[] = []
    for (const grant of grants) {
      const key = grant.provider === 'valet-key' ? await this.#keyInfo(grant.itemRef) : null
      out.push({
        adapterId: grant.adapterId,
        adapterHash: grant.adapterHash,
        credential: grant.credential,
        kind: grant.kind,
        custody: grant.custody,
        provider: grant.provider as CredentialProviderKind,
        itemTitle:
          key !== null ? `Valet-made key ${key.fingerprint}` : (this.#titles.get(grant.itemRef) ?? 'Item'),
        targets: [...grant.targets],
        grantedAt: grant.grantedAt,
        publicKey: key?.publicKey ?? null,
        fingerprint: key?.fingerprint ?? null,
        signed: this.counts(grant),
      })
    }
    return out
  }

  /**
   * Grants an installed version's declared credential the item, once the person signs it. The item
   * must be one the provider lists (or a Valet-made key), so a window can't name any reference.
   */
  async make(request: CredentialGrantRequest): Promise<CredentialGrantInfo> {
    const adapter = this.#deps.adapter(request.adapterId)
    if (adapter === null) throw new ValetError('grant', 'not-found')
    if (adapter.hash !== request.adapterHash) throw new ValetError('grant', 'invalid')
    const credentials = credentialsOf(adapter.manifest)
    if (!Object.hasOwn(credentials, request.credential)) throw new ValetError('grant', 'invalid')
    const declaration = credentials[request.credential] as CredentialDeclaration
    if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(request.provider))
      throw new ValetError('grant', 'invalid')
    // A Valet-made key is an SSH key, and only Valet makes one: never for a password or token.
    if (request.provider === 'valet-key') {
      // A Valet-made key stays with Valet: never entrusted to adapter code, and only for the
      // adapter and credential it was made for (its label says which).
      if (!isValetKeyRef(request.itemId) || declaration.kind !== 'ssh-key' || declaration.custody !== 'kept')
        throw new ValetError('grant', 'invalid')
      const key = await this.#keyInfo(request.itemId)
      if (key === null) throw new ValetError('grant', 'not-found')
      if (!key.publicKey.endsWith(` ${keyLabel(request.adapterId, request.credential)}`))
        throw new ValetError('grant', 'invalid')
    } else {
      if (!VAULT_ITEM_ID.test(request.itemId)) throw new ValetError('grant', 'invalid')
      if (!(await this.#deps.available()).has(request.provider)) throw new ValetError('grant', 'unavailable')
    }
    const declared = credentialTargets(declaration)
    const targets = [...new Set(request.targets ?? declared)]
    if (targets.length === 0 || !targets.every((t) => declared.includes(t)))
      throw new ValetError('grant', 'invalid')
    const title = await this.#itemTitle(request.provider, request.itemId)
    const itemRef =
      request.provider === 'valet-key' ? request.itemId : itemRefFor(request.provider, request.itemId)
    const grant: CredentialGrant = {
      adapterId: request.adapterId,
      adapterHash: adapter.hash,
      credential: request.credential,
      kind: declaration.kind,
      custody: declaration.custody,
      provider: request.provider,
      itemRef,
      targets,
      grantedAt: new Date(this.#deps.now()).toISOString(),
    }
    const signed = await this.#deps.approve(subjectFor(grant, declaration, title))
    if (!signed) throw new ValetError('grant', 'not-granted')
    // D6: a Keychain copy is made now, with the person approving in 1Password.
    if (grant.provider === 'keychain-copy') {
      const fields: ItemField[] =
        declaration.kind === 'password'
          ? ['username', 'password']
          : declaration.kind === 'token'
            ? ['token']
            : ['username', 'ssh-key']
      await this.#deps.copyItem(grant.itemRef, fields)
    }
    // Audited first: a grant that can't be recorded isn't made.
    await this.#deps.audit.append({
      type: 'credential-granted',
      adapterId: grant.adapterId,
      adapterHash: grant.adapterHash,
      credential: grant.credential,
      custody: grant.custody,
      provider: grant.provider,
      targets: [...grant.targets],
    })
    const before = await this.#deps.store.list()
    await this.#deps.store.put(grant)
    this.#titles.set(grant.itemRef, title)
    // A Valet-made key this grant replaced is no longer named: its private half goes.
    await this.#forgetUnusedKeys(before)
    const info = (await this.list()).find(
      (g) =>
        g.adapterId === grant.adapterId &&
        g.adapterHash === grant.adapterHash &&
        g.credential === grant.credential,
    )
    if (info === undefined) throw new ValetError('grant', 'unavailable')
    return info
  }

  /** Takes a credential's grants and their evidence away, for every version. Only tightens. */
  async revoke(adapterId: string, credential: string): Promise<void> {
    const before = await this.#deps.store.list()
    await this.#deps.revokeEvidence((s) => s.adapterId === adapterId && s.credential === credential)
    // A carry record would otherwise make an old copy count again under a later install.
    await this.#deps.dropCarried((c) => c.adapterId === adapterId && c.credential === credential)
    await this.#deps.store.revoke(adapterId, credential)
    await this.#deps.audit.append({ type: 'credential-revoked', adapterId, credential })
    await this.#forgetUnusedKeys(before)
  }

  /** Every grant of an adapter, for an uninstall. */
  async revokeAdapter(adapterId: string): Promise<void> {
    const names = new Set(
      (await this.#deps.store.list()).filter((g) => g.adapterId === adapterId).map((g) => g.credential),
    )
    for (const credential of names) await this.revoke(adapterId, credential)
  }

  /**
   * Makes a Valet SSH key for an installed version's declared ssh-key credential. The key does
   * nothing until a grant names it; the person adds its public half to the server.
   */
  async generateKey(adapterId: string, credential: string): Promise<ValetKeyInfo> {
    const keys = this.#deps.keys
    if (keys === null) throw new ValetError('credential', 'unavailable')
    const adapter = this.#deps.adapter(adapterId)
    if (adapter === null) throw new ValetError('grant', 'not-found')
    const credentials = credentialsOf(adapter.manifest)
    if (!Object.hasOwn(credentials, credential) || credentials[credential]?.kind !== 'ssh-key')
      throw new ValetError('grant', 'invalid')
    const info = await keys.generate(keyLabel(adapterId, credential))
    try {
      await this.#deps.audit.append({
        type: 'key-generated',
        adapterId,
        credential,
        fingerprint: info.fingerprint,
      })
    } catch (error) {
      await keys.forget(info.itemRef).catch(() => undefined)
      throw error
    }
    return info
  }

  /**
   * After a signed update that inherits the session, keeps each of the replaced version's
   * credential grants the update doesn't widen, for the new hash. Best effort: one not kept is
   * only granted again.
   */
  async carry(
    adapterId: string,
    toHash: string,
    previous: { hash: string; manifest: AdapterManifest },
  ): Promise<void> {
    const adapter = this.#deps.adapter(adapterId)
    if (adapter === null || adapter.hash !== toHash || this.#deps.carried() === null) return
    const install = this.#deps.honoured(
      'adapter-install',
      (s) =>
        s.adapterId === adapterId &&
        s.adapterHash === toHash &&
        s.previousHash === previous.hash &&
        s.inheritsSession &&
        s.source !== 'rollback',
    )
    if (install === null) return
    const all = await this.#deps.store.list()
    const kept = all.filter(
      (g) =>
        g.adapterId === adapterId &&
        g.adapterHash === previous.hash &&
        this.counts(g) &&
        credentialCarriesOver(g, previous.manifest, adapter.manifest) &&
        !all.some(
          (n) => n.adapterId === adapterId && n.adapterHash === toHash && n.credential === g.credential,
        ),
    )
    if (kept.length === 0) return
    const at = new Date(this.#deps.now()).toISOString()
    await this.#deps.recordCarried(
      adapterId,
      kept.map((g) => ({
        adapterId,
        fromHash: previous.hash,
        toHash,
        credential: g.credential,
        provider: g.provider as CredentialProviderKind,
        itemFingerprint: itemFingerprint(g.itemRef),
        targets: [...g.targets],
        at,
      })),
    )
    for (const g of kept) {
      // A revoke while this ran takes the old grant and its evidence: it is not carried then.
      if ((await this.#deps.store.find(adapterId, previous.hash, g.credential)) === null || !this.#signed(g))
        continue
      try {
        await this.#deps.audit.append({
          type: 'credential-granted',
          adapterId,
          adapterHash: toHash,
          credential: g.credential,
          custody: g.custody,
          provider: g.provider,
          targets: [...g.targets],
          carriedFrom: previous.hash,
        })
        await this.#deps.store.put({ ...g, targets: [...g.targets], adapterHash: toHash, grantedAt: at })
      } catch {
        // Not kept: the person grants it again.
      }
    }
  }

  #signed(grant: CredentialGrant): boolean {
    const fingerprint = itemFingerprint(grant.itemRef)
    return (
      this.#deps.honoured(
        'credential-grant',
        (s) =>
          s.adapterId === grant.adapterId &&
          s.adapterHash === grant.adapterHash &&
          s.credential === grant.credential &&
          s.kind === grant.kind &&
          s.custody === grant.custody &&
          s.provider === grant.provider &&
          s.itemFingerprint === fingerprint &&
          grant.targets.every((t) => s.targets.includes(t)),
      ) !== null
    )
  }

  #carried(grant: CredentialGrant): boolean {
    const fingerprint = itemFingerprint(grant.itemRef)
    const records = (this.#deps.carried() ?? []).filter(
      (c) =>
        c.adapterId === grant.adapterId &&
        c.toHash === grant.adapterHash &&
        c.credential === grant.credential &&
        c.provider === grant.provider &&
        c.itemFingerprint === fingerprint &&
        grant.targets.every((t) => c.targets.includes(t)),
    )
    return records.some(
      (c) =>
        this.#deps.honoured(
          'adapter-install',
          (s) =>
            s.adapterId === c.adapterId &&
            s.adapterHash === c.toHash &&
            s.previousHash === c.fromHash &&
            s.inheritsSession &&
            // A rollback never carries (carry refuses it), so its evidence never makes a carry count.
            s.source !== 'rollback',
        ) !== null,
    )
  }

  #resolver(): CredentialResolver {
    const providers = Object.values(this.#deps.providers()).filter(
      (p): p is CredentialProvider => p !== undefined && p.kind !== 'messages' && p.kind !== 'valet-key',
    )
    return new CredentialResolver(this.#deps.keys === null ? providers : [...providers, this.#deps.keys])
  }

  async #itemTitle(provider: CredentialProviderKind, itemId: string): Promise<string> {
    if (provider === 'valet-key') {
      const key = await this.#keyInfo(itemId)
      if (key === null) throw new ValetError('grant', 'not-found')
      // The SSH fingerprint, as the server's authorized_keys shows it: tells keys apart on the card.
      return `Valet-made key ${key.fingerprint}`
    }
    const item = (await this.#deps.vaultItems(provider)).find((i) => i.id === itemId)
    if (item === undefined) throw new ValetError('grant', 'not-found')
    return printable(item.title)
  }

  async #keyInfo(itemRef: string): Promise<ValetKeyInfo | null> {
    if (this.#deps.keys === null || !isValetKeyRef(itemRef)) return null
    return this.#deps.keys.info(itemRef).catch(() => null)
  }

  /** A Valet-made key no grant names any more is forgotten: its private half leaves the Keychain. */
  async #forgetUnusedKeys(before: readonly CredentialGrant[]): Promise<void> {
    const keys = this.#deps.keys
    if (keys === null) return
    const after = await this.#deps.store.list()
    for (const grant of before)
      if (grant.provider === 'valet-key' && !after.some((g) => g.itemRef === grant.itemRef))
        await keys.forget(grant.itemRef).catch(() => undefined)
  }
}

/**
 * The label a Valet-made key carries in its public half: which adapter and credential it was made
 * for. Adapter ids have no dot and credential names no hyphen, so the label is never ambiguous; one
 * too long for the key's 100 characters is a hash of the two.
 */
export function keyLabel(adapterId: string, credential: string): string {
  const label = `valet.${adapterId}.${credential.replaceAll('_', '-')}`
  return label.length <= 100
    ? label
    : `valet.${createHash('sha256').update(`${adapterId}/${credential}`).digest('hex').slice(0, 40)}`
}

/** The card for `grant`: the Mac's own sentence for the declaration, narrowed to the grant's targets. */
export function subjectFor(
  grant: CredentialGrant,
  declaration: CredentialDeclaration,
  title: string,
): ApprovalSubject<'credential-grant'> {
  return {
    adapterId: grant.adapterId,
    adapterHash: grant.adapterHash,
    credential: grant.credential,
    kind: grant.kind,
    custody: grant.custody,
    provider: grant.provider as CredentialProviderKind,
    itemTitle: title,
    itemFingerprint: itemFingerprint(grant.itemRef),
    targets: [...grant.targets],
    description: describeCredentialUse(grant.credential, narrowed(declaration, grant.targets)),
  }
}

function narrowed(declaration: CredentialDeclaration, targets: readonly string[]): CredentialDeclaration {
  const { use } = declaration
  if ('header' in use) return { ...declaration, use: { ...use, hosts: [...targets] } }
  if ('entrusted' in use)
    return { ...declaration, use: { entrusted: { ...use.entrusted, endpoints: [...targets] } } }
  return declaration
}

/**
 * Display text of at most 120 UTF-16 units, cut on a whole character: a title that isn't (control
 * or format characters, which could reorder or hide the card's words) is shown as "Untitled item".
 */
function printable(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  let out = ''
  for (const c of flat) {
    if (out.length + c.length > TITLE_MAX) break
    out += c
  }
  return out !== '' && isDisplayText(out) ? out : 'Untitled item'
}
