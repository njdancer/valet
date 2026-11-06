// A durable marker that a login is in progress, from the earlier app. It is written and fsynced before
// the auth action starts and cleared only once the outcome is classified, so a crash or hang
// mid-login stops further attempts (and lockouts) until the person clears it. The file's existence
// is the state; anything we can't read counts as set.

import { open, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { SiteAdapterError } from '@siteadapter/core'
import { ADAPTER_ID } from './approvals'
import type { Clock } from './clock'
import { isErrno, syncDirectory, writeFileSynced } from './files'

export interface LoginMarkerStore {
  isSet(adapterId: string): Promise<boolean>
  set(adapterId: string, callId: string | null): Promise<void>
  clear(adapterId: string): Promise<void>
}

export class LoginAttemptMarker implements LoginMarkerStore {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock,
  ) {}

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
    if (!ADAPTER_ID.test(adapterId)) throw new SiteAdapterError('manifest', 'invalid')
    return join(this.dir, `${adapterId}.login-attempt`)
  }
}
