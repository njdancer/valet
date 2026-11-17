// Credential grants on disk (B's contract, docs/adapter-kinds.md#f2-secrets-version-2): one JSON
// file beside the secret grants, with the same rules. A grant binds one credential of one exact
// adapter hash to an item and to the targets the person allowed, so a changed adapter never
// inherits one except through an approved update that doesn't widen it.
//
// A grant's slot is (adapter, hash, credential): putting a grant replaces the one in its slot. The
// store checks each grant is well formed on its own; checking it against the manifest (the
// declaration still names this kind and custody, and every target is still declared) is the
// gate's job when it hands the credential out (packages/runtime credential-gate.ts).

import {
  CREDENTIAL_KINDS,
  type CredentialGrant,
  type CredentialGrantStore,
  CUSTODIES,
  isCredentialHost,
  isEndpoint,
  type ProviderKind,
  ValetError,
} from '@valet/core'
import { parseItemRef } from './item-ref'
import { type GrantFs, hasExactKeys, isPlainObject, SecureJsonFile } from './secure-json-file'
import { isValetKeyRef } from './valet-key'

export interface FileCredentialGrantStoreOptions {
  readonly path: string
  readonly fs?: GrantFs
}

/** Messages is only ever a browser login's one-time codes, never a credential. */
const PROVIDERS: readonly ProviderKind[] = [
  'keychain-copy',
  'onepassword-desktop',
  'onepassword-service-account',
  'onepassword-cli',
  'valet-key',
  'fake',
]
const GRANT_KEYS = [
  'adapterId',
  'adapterHash',
  'credential',
  'kind',
  'custody',
  'provider',
  'itemRef',
  'targets',
  'grantedAt',
]
const ADAPTER_ID = /^[a-z][a-z0-9-]{1,63}$/
const CREDENTIAL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_TARGETS = 20

export class FileCredentialGrantStore implements CredentialGrantStore {
  readonly #file: SecureJsonFile

  constructor(options: FileCredentialGrantStoreOptions) {
    this.#file = new SecureJsonFile(options.path, options.fs)
  }

  async find(adapterId: string, adapterHash: string, credential: string): Promise<CredentialGrant | null> {
    const grants = await this.#read()
    return (
      grants.find(
        (g) => g.adapterId === adapterId && g.adapterHash === adapterHash && g.credential === credential,
      ) ?? null
    )
  }

  async list(): Promise<readonly CredentialGrant[]> {
    return this.#read()
  }

  put(grant: CredentialGrant): Promise<void> {
    if (!isValidCredentialGrant(grant)) return Promise.reject(new ValetError('grant', 'invalid'))
    const stored = copyGrant(grant)
    return this.#file.exclusive(async () => {
      const others = (await this.#read()).filter((g) => !sameSlot(g, stored))
      await this.#file.write({ version: 1, grants: [...others, stored] })
    })
  }

  /** Revokes the credential's grants for every hash of the adapter. */
  revoke(adapterId: string, credential: string): Promise<void> {
    return this.#file.exclusive(async () => {
      const grants = await this.#read()
      const kept = grants.filter((g) => !(g.adapterId === adapterId && g.credential === credential))
      if (kept.length !== grants.length) await this.#file.write({ version: 1, grants: kept })
    })
  }

  async #read(): Promise<CredentialGrant[]> {
    const parsed = await this.#file.read()
    return parsed === undefined ? [] : parseFile(parsed)
  }
}

/** The file's contents, all or nothing: one bad grant and none are used. */
function parseFile(value: unknown): CredentialGrant[] {
  if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'grants'])) {
    throw new ValetError('config', 'invalid')
  }
  const { version, grants: candidates } = value
  if (version !== 1 || !Array.isArray(candidates)) throw new ValetError('config', 'invalid')
  const grants: CredentialGrant[] = []
  for (const candidate of candidates as unknown[]) {
    if (!isValidCredentialGrant(candidate)) throw new ValetError('config', 'invalid')
    if (grants.some((g) => sameSlot(g, candidate))) throw new ValetError('config', 'invalid')
    grants.push(copyGrant(candidate))
  }
  return grants
}

/** True for a credential grant with exactly the expected fields, each well formed. */
export function isValidCredentialGrant(value: unknown): value is CredentialGrant {
  if (!isPlainObject(value) || !hasExactKeys(value, GRANT_KEYS)) return false
  const { adapterId, adapterHash, credential, kind, custody, provider, itemRef, targets, grantedAt } = value
  return (
    typeof adapterId === 'string' &&
    ADAPTER_ID.test(adapterId) &&
    typeof adapterHash === 'string' &&
    SHA256_HEX.test(adapterHash) &&
    typeof credential === 'string' &&
    CREDENTIAL_NAME.test(credential) &&
    typeof kind === 'string' &&
    (CREDENTIAL_KINDS as readonly string[]).includes(kind) &&
    typeof custody === 'string' &&
    (CUSTODIES as readonly string[]).includes(custody) &&
    typeof provider === 'string' &&
    (PROVIDERS as readonly string[]).includes(provider) &&
    typeof itemRef === 'string' &&
    itemRef.length > 0 &&
    itemRef.length <= 512 &&
    !CONTROL.test(itemRef) &&
    itemRefSuits(provider as ProviderKind, kind, itemRef) &&
    Array.isArray(targets) &&
    targets.length > 0 &&
    targets.length <= MAX_TARGETS &&
    new Set(targets).size === targets.length &&
    targets.every((t) => typeof t === 'string' && (isEndpoint(t) || isCredentialHost(t))) &&
    typeof grantedAt === 'string' &&
    ISO_INSTANT.test(grantedAt) &&
    !Number.isNaN(Date.parse(grantedAt))
  )
}

/**
 * A Valet-made key is only ever an SSH key, and an SSH key from 1Password or a copy names exactly
 * op://<vault>/<item>, as every vault grant does.
 */
function itemRefSuits(provider: ProviderKind, kind: string, itemRef: string): boolean {
  if (provider === 'valet-key') return kind === 'ssh-key' && isValetKeyRef(itemRef)
  if (isValetKeyRef(itemRef)) return false
  if (provider === 'fake') return true
  return parseItemRef(itemRef) !== null
}

function copyGrant(grant: CredentialGrant): CredentialGrant {
  return Object.freeze({ ...grant, targets: Object.freeze([...grant.targets]) })
}

function sameSlot(a: CredentialGrant, b: CredentialGrant): boolean {
  return a.adapterId === b.adapterId && a.adapterHash === b.adapterHash && a.credential === b.credential
}
