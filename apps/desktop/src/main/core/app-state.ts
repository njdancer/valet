// app-state.json: the kill switches the person sets that outlive a restart. Lock down (every call
// refused, IA section 2.10) and the sites they paused one by one. Valet's own Pause stays in memory,
// as it always has: a restart resumes it.
//
// Read once at start and held in memory, since the tool caller asks on every call. A file that is
// there but doesn't validate reads as locked down, so a damaged file never quietly lets calls
// through; the person unlocks, which writes a good one.

import { z } from 'zod'
import { readJsonFile, writeJsonFile } from './files'

const ADAPTER_ID = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)

const appStateSchema = z
  .object({
    lockedDown: z.boolean(),
    pausedSites: z.array(ADAPTER_ID).max(200),
  })
  .strict()

export type AppState = z.infer<typeof appStateSchema>

const DEFAULT_STATE: AppState = { lockedDown: false, pausedSites: [] }

export class AppStateStore {
  private state: AppState = DEFAULT_STATE
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.state = (await readJsonFile(this.path, appStateSchema)) ?? DEFAULT_STATE
    } catch {
      this.state = { lockedDown: true, pausedSites: [] }
    }
  }

  get lockedDown(): boolean {
    return this.state.lockedDown
  }

  sitePaused(adapterId: string): boolean {
    return this.state.pausedSites.includes(adapterId)
  }

  /** Changed in memory at once, so the next call sees it; the write follows. Rejects if it fails. */
  setLockedDown(locked: boolean): Promise<void> {
    return this.write({ ...this.state, lockedDown: locked })
  }

  setSitePaused(adapterId: string, paused: boolean): Promise<void> {
    const others = this.state.pausedSites.filter((id) => id !== adapterId)
    return this.write({ ...this.state, pausedSites: paused ? [...others, adapterId].sort() : others })
  }

  private write(next: AppState): Promise<void> {
    this.state = next
    const done = this.queue.then(() => writeJsonFile(this.path, next))
    this.queue = done.catch(() => undefined)
    return done
  }
}
