// Grants on disk: one JSON file, validated on every read, replaced atomically on every write and
// readable only by its owner. A grant binds a secret to one exact adapter hash, so a changed adapter
// never inherits one.
//
// A grant's slot is (adapter, hash, secret), and putting a grant replaces the one in its slot. Every
// Messages grant has the secret 'messages', but a flow may read codes from more than one sender, so
// for those the slot also includes the sender: granting a second sender adds a grant beside the
// first instead of replacing it. Core's find() has no sender to ask with, so it returns one of them;
// findMessages() asks for the one sender a manifest's OTP source names.
//
// The store checks that each grant is well formed on its own. Checking it against the manifest is
// the runtime's job, at the moment it uses a grant: that grant.origins is a subset of the origins
// the manifest's secret request names (for a messages grant, of the origins its OTP step may type
// into), and that a messages grant's itemRef is the same sender the manifest's OTP source names
// (sameOtpSender). The store can't do either: it never sees a manifest.

import {
  type Grant,
  type GrantStore,
  isBareOrigin,
  MESSAGES_SECRET,
  type ProviderKind,
  ValetError,
} from '@valet/core'
import { parseItemRef } from './item-ref'
import { parseOtpSender, sameOtpSender } from './otp-sender'
import { type GrantFs, hasExactKeys, isPlainObject, SecureJsonFile } from './secure-json-file'

export type { GrantFs } from './secure-json-file'

export interface FileGrantStoreOptions {
  readonly path: string
  readonly fs?: GrantFs
}

const PROVIDERS: readonly ProviderKind[] = [
  'keychain-copy',
  'onepassword-desktop',
  'onepassword-service-account',
  'onepassword-cli',
  'messages',
  'fake',
]
const GRANT_KEYS = ['adapterId', 'adapterHash', 'secret', 'provider', 'itemRef', 'origins', 'grantedAt']
// The same shapes the manifest schema accepts for adapter ids and secret names.
const ADAPTER_ID = /^[a-z][a-z0-9-]{1,63}$/
const SECRET_NAME = /^[a-z][a-z0-9_]{0,63}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/

export class FileGrantStore implements GrantStore {
  readonly #file: SecureJsonFile

  constructor(options: FileGrantStoreOptions) {
    this.#file = new SecureJsonFile(options.path, options.fs)
  }

  async find(adapterId: string, adapterHash: string, secret: string): Promise<Grant | null> {
    const grants = await this.#read()
    return (
      grants.find((g) => g.adapterId === adapterId && g.adapterHash === adapterHash && g.secret === secret) ??
      null
    )
  }

  /**
   * The messages grant for this adapter and hash whose sender is `sender`, however either is
   * written ("+61 400 000 000" and "+61400000000"), or null. Unlike find(), it can't hand back the
   * grant for a different sender of the same flow.
   */
  async findMessages(adapterId: string, adapterHash: string, sender: string): Promise<Grant | null> {
    const grants = await this.#read()
    return (
      grants.find(
        (g) =>
          g.adapterId === adapterId &&
          g.adapterHash === adapterHash &&
          g.secret === MESSAGES_SECRET &&
          g.provider === 'messages' &&
          sameOtpSender(g.itemRef, sender),
      ) ?? null
    )
  }

  async list(): Promise<readonly Grant[]> {
    return this.#read()
  }

  put(grant: Grant): Promise<void> {
    if (!isValidGrant(grant)) return Promise.reject(new ValetError('grant', 'invalid'))
    const stored = copyGrant(grant)
    return this.#file.exclusive(async () => {
      const others = (await this.#read()).filter((g) => !sameSlot(g, stored))
      await this.#write([...others, stored])
    })
  }

  revoke(adapterId: string, secret: string): Promise<void> {
    return this.#file.exclusive(async () => {
      const grants = await this.#read()
      const kept = grants.filter((g) => !(g.adapterId === adapterId && g.secret === secret))
      if (kept.length !== grants.length) await this.#write(kept)
    })
  }

  /** Revokes the messages grants for one sender, whatever the hash; revoke() revokes every sender. */
  revokeMessages(adapterId: string, sender: string): Promise<void> {
    return this.#file.exclusive(async () => {
      const grants = await this.#read()
      const kept = grants.filter(
        (g) =>
          !(g.adapterId === adapterId && g.secret === MESSAGES_SECRET && sameOtpSender(g.itemRef, sender)),
      )
      if (kept.length !== grants.length) await this.#write(kept)
    })
  }

  async #read(): Promise<Grant[]> {
    const parsed = await this.#file.read()
    return parsed === undefined ? [] : parseGrantFile(parsed)
  }

  async #write(grants: readonly Grant[]): Promise<void> {
    await this.#file.write({ version: 1, grants })
  }
}

/** The file's contents, all or nothing: one bad grant and none are used. */
function parseGrantFile(value: unknown): Grant[] {
  if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'grants'])) {
    throw new ValetError('config', 'invalid')
  }
  const { version, grants: candidates } = value
  if (version !== 1 || !Array.isArray(candidates)) throw new ValetError('config', 'invalid')
  const grants: Grant[] = []
  for (const candidate of candidates as unknown[]) {
    if (!isValidGrant(candidate)) throw new ValetError('config', 'invalid')
    // Two grants in one slot means the file was edited by hand or by something else.
    if (grants.some((g) => sameSlot(g, candidate))) throw new ValetError('config', 'invalid')
    grants.push(copyGrant(candidate))
  }
  return grants
}

/** True for a grant with exactly the expected fields, each well formed. */
export function isValidGrant(value: unknown): value is Grant {
  if (!isPlainObject(value) || !hasExactKeys(value, GRANT_KEYS)) return false
  const { adapterId, adapterHash, secret, provider, itemRef, origins, grantedAt } = value
  return (
    typeof adapterId === 'string' &&
    ADAPTER_ID.test(adapterId) &&
    typeof adapterHash === 'string' &&
    SHA256_HEX.test(adapterHash) &&
    typeof secret === 'string' &&
    SECRET_NAME.test(secret) &&
    typeof provider === 'string' &&
    (PROVIDERS as readonly string[]).includes(provider) &&
    typeof itemRef === 'string' &&
    itemRef.length > 0 &&
    itemRef.length <= 512 &&
    !CONTROL.test(itemRef) &&
    itemRefSuits(provider as ProviderKind, secret, itemRef) &&
    Array.isArray(origins) &&
    origins.length > 0 &&
    // isBareOrigin refuses wildcards and IP literals: a secret is granted to a named site, not to
    // whatever answers at an address. A port is allowed; it is part of the origin the person sees.
    origins.every((origin) => typeof origin === 'string' && isBareOrigin(origin)) &&
    typeof grantedAt === 'string' &&
    ISO_INSTANT.test(grantedAt) &&
    !Number.isNaN(Date.parse(grantedAt))
  )
}

/**
 * A messages grant is the reserved secret, and its itemRef is a sender handle the reader accepts.
 * Every other grant names a real secret, and a 1Password grant names exactly op://<vault>/<item>,
 * so a reference the providers would refuse anyway is refused when the grant is made.
 */
function itemRefSuits(provider: ProviderKind, secret: string, itemRef: string): boolean {
  if (provider === 'messages') return secret === MESSAGES_SECRET && parseOtpSender(itemRef) !== null
  if (secret === MESSAGES_SECRET) return false
  if (provider === 'fake') return true
  return parseItemRef(itemRef) !== null
}

function copyGrant(grant: Grant): Grant {
  return Object.freeze({ ...grant, origins: Object.freeze([...grant.origins]) })
}

/**
 * Grants that stand for the same approval: the newer replaces the older. Messages grants are one
 * per sender, so two senders of one flow are two slots.
 */
function sameSlot(a: Grant, b: Grant): boolean {
  if (a.adapterId !== b.adapterId || a.adapterHash !== b.adapterHash || a.secret !== b.secret) return false
  // Both are messages grants here (the reserved secret is only valid with that provider), and both
  // passed isValidGrant, so both itemRefs parse as senders.
  return a.secret !== MESSAGES_SECRET || sameOtpSender(a.itemRef, b.itemRef)
}
