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

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as nodeFs from 'node:fs/promises'
import { dirname } from 'node:path'
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

/** The file operations the store uses, injected so tests can fail them. */
export type GrantFs = Pick<typeof nodeFs, 'lstat' | 'mkdir' | 'open' | 'rename' | 'unlink'>

export interface FileGrantStoreOptions {
  readonly path: string
  readonly fs?: GrantFs
}

const PROVIDERS: readonly ProviderKind[] = [
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
// Never follow a planted symlink, and never block on a planted FIFO.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export class FileGrantStore implements GrantStore {
  readonly #path: string
  readonly #fs: GrantFs
  // Serialises read-modify-write so concurrent puts in this process never lose one another.
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: FileGrantStoreOptions) {
    this.#path = options.path
    this.#fs = options.fs ?? nodeFs
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
    return this.#exclusive(async () => {
      const others = (await this.#read()).filter((g) => !sameSlot(g, stored))
      await this.#write([...others, stored])
    })
  }

  revoke(adapterId: string, secret: string): Promise<void> {
    return this.#exclusive(async () => {
      const grants = await this.#read()
      const kept = grants.filter((g) => !(g.adapterId === adapterId && g.secret === secret))
      if (kept.length !== grants.length) await this.#write(kept)
    })
  }

  /** Revokes the messages grants for one sender, whatever the hash; revoke() revokes every sender. */
  revokeMessages(adapterId: string, sender: string): Promise<void> {
    return this.#exclusive(async () => {
      const grants = await this.#read()
      const kept = grants.filter(
        (g) =>
          !(g.adapterId === adapterId && g.secret === MESSAGES_SECRET && sameOtpSender(g.itemRef, sender)),
      )
      if (kept.length !== grants.length) await this.#write(kept)
    })
  }

  #exclusive(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(work, work)
    this.#queue = run.catch(() => {})
    return run
  }

  async #read(): Promise<Grant[]> {
    let raw: string
    try {
      if (!(await this.#checkDirectory())) return []
      // A grant decides where a password may be typed, so refuse a file someone else could have
      // written or redirected. The checks and the read go through one handle, so the file can't be
      // swapped between them.
      const handle = await this.#fs.open(this.#path, READ_FLAGS)
      try {
        const info = await handle.stat()
        if (!info.isFile() || !safeOwnership(info)) throw new ValetError('config', 'insecure-file')
        raw = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof ValetError) throw error
      if (errorCode(error) === 'ENOENT') return []
      // What O_NOFOLLOW reports for a symlink.
      if (errorCode(error) === 'ELOOP') throw new ValetError('config', 'insecure-file')
      throw new ValetError('config', 'unavailable')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ValetError('config', 'invalid')
    }
    return parseGrantFile(parsed)
  }

  async #write(grants: readonly Grant[]): Promise<void> {
    const directory = dirname(this.#path)
    const temp = `${this.#path}.${randomUUID()}.tmp`
    const body = `${JSON.stringify({ version: 1, grants }, null, 2)}\n`
    try {
      await this.#fs.mkdir(directory, { recursive: true, mode: 0o700 })
    } catch {
      throw new ValetError('config', 'unavailable')
    }
    // mkdir's mode only applies to a directory it creates; an existing one is checked as on read.
    await this.#checkDirectory()
    try {
      const handle = await this.#fs.open(temp, 'wx', 0o600)
      try {
        // The umask can only remove bits; chmod makes the mode exact either way.
        await handle.chmod(0o600)
        await handle.writeFile(body, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#fs.rename(temp, this.#path)
    } catch {
      await this.#fs.unlink(temp).catch(() => {})
      throw new ValetError('config', 'unavailable')
    }
    await this.#syncDirectory(directory)
  }

  /**
   * Refuses a directory that another user could write to: whoever can write there can replace the
   * grant file with their own. Returns false when the directory doesn't exist yet.
   */
  async #checkDirectory(): Promise<boolean> {
    let info: Awaited<ReturnType<GrantFs['lstat']>>
    try {
      info = await this.#fs.lstat(dirname(this.#path))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw new ValetError('config', 'unavailable')
    }
    if (!info.isDirectory() || !safeOwnership(info)) throw new ValetError('config', 'insecure-file')
    return true
  }

  /** Makes the rename durable. Best effort: not every platform can fsync a directory. */
  async #syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await this.#fs.open(directory, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch {
      // The data is already in place; only crash durability of the rename is at stake.
    }
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** Owned by this user, and writable by no one else. */
function safeOwnership(info: { mode: number; uid: number }): boolean {
  return (info.mode & 0o022) === 0 && (process.getuid === undefined || info.uid === process.getuid())
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}
