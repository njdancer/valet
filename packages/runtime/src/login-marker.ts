// A durable marker that a login is in progress, from the earlier app. It is written and fsynced before
// the auth action starts, so a crash or hang mid-login stops further attempts (and lockouts) until
// the person clears it. Once the outcome is classified it is cleared, or, if the login failed,
// replaced by a hold: automatic logins then wait for a backoff to pass, or for the person, because
// repeated blind attempts are how accounts get locked.
//
// The file's existence is the state. A file we can't read or parse counts as in progress.

import { open, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { NEEDS_USER_REASONS, type NeedsUserReason, ValetError } from '@valet/core'
import { ADAPTER_ID } from './approvals'
import type { Clock } from './clock'
import { isErrno, syncDirectory, writeFileAtomic, writeFileSynced } from './files'

export type LoginMarkerState =
  | { readonly kind: 'unset' }
  /** A login started and never reached a classified outcome. Only the person clears it. */
  | { readonly kind: 'in-progress' }
  /**
   * Logins in a row that failed, and when the next automatic one may start (ms since the epoch).
   * A null retryAt waits for the person. `reason` is the needsUser reason the login ended with, if
   * it ended with one, so callers keep seeing it while held.
   */
  | {
      readonly kind: 'held'
      readonly failures: number
      readonly retryAt: number | null
      readonly reason?: NeedsUserReason
    }

export interface LoginMarkerStore {
  read(adapterId: string): Promise<LoginMarkerState>
  /** Marks a login as in progress. */
  set(adapterId: string, callId: string | null): Promise<void>
  /** Replaces the marker with a hold after a classified failure. */
  hold(adapterId: string, failures: number, retryAt: number | null, reason?: NeedsUserReason): Promise<void>
  clear(adapterId: string): Promise<void>
}

const IN_PROGRESS: LoginMarkerState = { kind: 'in-progress' }

export class LoginAttemptMarker implements LoginMarkerStore {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock,
  ) {}

  async read(adapterId: string): Promise<LoginMarkerState> {
    let text: string
    try {
      const handle = await open(this.pathFor(adapterId), 'r')
      try {
        text = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      return isErrno(error, 'ENOENT') ? { kind: 'unset' } : IN_PROGRESS
    }
    return parseHold(text) ?? IN_PROGRESS
  }

  /** True when any marker or hold is present, or the state can't be read. */
  async isSet(adapterId: string): Promise<boolean> {
    try {
      await stat(this.pathFor(adapterId))
      return true
    } catch (error) {
      return !isErrno(error, 'ENOENT')
    }
  }

  async set(adapterId: string, callId: string | null): Promise<void> {
    const startedAt = new Date(this.clock.now()).toISOString()
    await writeFileSynced(this.pathFor(adapterId), `${JSON.stringify({ startedAt, callId })}\n`)
    await syncDirectory(this.dir)
  }

  async hold(
    adapterId: string,
    failures: number,
    retryAt: number | null,
    reason?: NeedsUserReason,
  ): Promise<void> {
    if (!Number.isSafeInteger(failures) || failures < 1) throw new ValetError('login', 'invalid')
    if (reason !== undefined && !NEEDS_USER_REASONS.includes(reason)) {
      throw new ValetError('login', 'invalid')
    }
    const heldAt = new Date(this.clock.now()).toISOString()
    // Atomic, so a crash mid-write leaves the in-progress marker rather than a torn hold.
    await writeFileAtomic(
      this.pathFor(adapterId),
      `${JSON.stringify({ state: 'held', heldAt, failures, retryAt, ...(reason === undefined ? {} : { reason }) })}\n`,
    )
  }

  async clear(adapterId: string): Promise<void> {
    try {
      await unlink(this.pathFor(adapterId))
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    await syncDirectory(this.dir)
  }

  /** When the marker was set, for showing the person; null when unset or unreadable. */
  async startedAt(adapterId: string): Promise<string | null> {
    try {
      const handle = await open(this.pathFor(adapterId), 'r')
      try {
        const parsed: unknown = JSON.parse(await handle.readFile('utf8'))
        const value = (parsed as { startedAt?: unknown } | null)?.startedAt
        return typeof value === 'string' ? value : null
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  private pathFor(adapterId: string): string {
    // Ids become file names; refuse anything that could walk out of the directory.
    if (!ADAPTER_ID.test(adapterId)) throw new ValetError('manifest', 'invalid')
    return join(this.dir, `${adapterId}.login-attempt`)
  }
}

function parseHold(text: string): LoginMarkerState | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const { state, failures, retryAt, reason } = value as Record<string, unknown>
  if (state !== 'held') return null
  if (typeof failures !== 'number' || !Number.isSafeInteger(failures) || failures < 1) return null
  if (retryAt !== null && (typeof retryAt !== 'number' || !Number.isFinite(retryAt))) return null
  if (reason === undefined) return { kind: 'held', failures, retryAt }
  const known = NEEDS_USER_REASONS.find((r) => r === reason)
  // A reason we don't know is a hand edit or a newer app: still held, by the person.
  if (known === undefined) return { kind: 'held', failures, retryAt: null }
  return { kind: 'held', failures, retryAt, reason: known }
}
