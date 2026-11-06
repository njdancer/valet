// Keeps the app's own work on an adapter's browser sessions out of the way of its tool calls.
//
// The runtime holds a lock per adapter for each call, and keeps it (and the driver's run) until the
// work the call started settles, but that lock is private to ToolHost. The login window the person
// opens from the control panel, and the hand-off when they say they're signed in, run outside any
// call: without this gate, a hand-off could copy cookies and storage into the tool partition, and
// open its page there, in the middle of another call's run, under that run's policy and ceiling.
//
// So every call the endpoint makes enters the gate first, every driver the runtime gets is tracked
// (beginRun to endRun), and the app's work runs `exclusive`: new calls wait from the moment it
// asks, and it starts only once no call is in flight and no run is open on the driver. Exclusive
// work runs one at a time per adapter, and gives up after `waitMs` if the adapter never goes idle.

import {
  type AuthPage,
  type BlockedRequest,
  type SessionDriver,
  SiteAdapterError,
  type ToolPage,
  type ToolRunPolicy,
} from '@siteadapter/core'
import type { Timers } from './confirmations'

interface GateState {
  /** Calls between enter() and their leave(). */
  calls: number
  /** A run is open on the tracked driver (beginRun returned, endRun not yet called). */
  inRun: boolean
  /** Exclusive tasks waiting or running: while any is, new calls wait. */
  holders: number
  /** The last exclusive task's end, which the next one waits for. */
  tail: Promise<void>
  readonly waiters: Set<() => void>
}

export class AdapterGate {
  private readonly states = new Map<string, GateState>()

  constructor(private readonly timers: Timers) {}

  /** The driver to give the runtime: the same driver, with its runs visible to the gate. */
  track(adapterId: string, driver: SessionDriver): SessionDriver {
    const state = this.state(adapterId)
    return new TrackedDriver(driver, (inRun) => {
      state.inRun = inRun
      this.notify(state)
    })
  }

  /** A tool call is about to run: waits while exclusive work holds the adapter. Call leave() after. */
  async enter(adapterId: string): Promise<() => void> {
    const state = this.state(adapterId)
    while (state.holders > 0) await this.changed(state)
    state.calls++
    let left = false
    return () => {
      if (left) return
      left = true
      state.calls--
      this.notify(state)
    }
  }

  /** Whether a call is in flight or a run open on the adapter, for tests and diagnostics. */
  busy(adapterId: string): boolean {
    const state = this.states.get(adapterId)
    return state !== undefined && (state.calls > 0 || state.inRun)
  }

  /**
   * Runs `task` with the adapter to itself. Rejects with login: timed-out, without running it, if
   * calls or a run are still going after `waitMs`.
   */
  async exclusive<T>(adapterId: string, waitMs: number, task: () => Promise<T>): Promise<T> {
    const state = this.state(adapterId)
    state.holders++
    const previous = state.tail
    let finished: () => void = () => {}
    state.tail = previous.then(
      () =>
        new Promise<void>((resolve) => {
          finished = resolve
        }),
    )
    try {
      await previous
      await this.idle(state, waitMs)
      return await task()
    } finally {
      finished()
      state.holders--
      this.notify(state)
    }
  }

  private idle(state: GateState, waitMs: number): Promise<void> {
    const quiet = () => state.calls === 0 && !state.inRun
    if (quiet()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!quiet()) {
          state.waiters.add(check)
          return
        }
        this.timers.clearTimeout(timer)
        resolve()
      }
      const timer = this.timers.setTimeout(() => {
        state.waiters.delete(check)
        reject(new SiteAdapterError('login', 'timed-out'))
      }, waitMs)
      state.waiters.add(check)
    })
  }

  private changed(state: GateState): Promise<void> {
    return new Promise<void>((resolve) => state.waiters.add(resolve))
  }

  private notify(state: GateState): void {
    const waiters = [...state.waiters]
    state.waiters.clear()
    for (const waiter of waiters) waiter()
  }

  private state(adapterId: string): GateState {
    let state = this.states.get(adapterId)
    if (state === undefined) {
      state = { calls: 0, inRun: false, holders: 0, tail: Promise.resolve(), waiters: new Set() }
      this.states.set(adapterId, state)
    }
    return state
  }
}

/** Every method passes straight through; beginRun and endRun also tell the gate. */
class TrackedDriver implements SessionDriver {
  constructor(
    private readonly inner: SessionDriver,
    private readonly running: (inRun: boolean) => void,
  ) {}

  openAuthPage(): Promise<AuthPage> {
    return this.inner.openAuthPage()
  }

  toolPage(): Promise<ToolPage> {
    return this.inner.toolPage()
  }

  handoff(
    cookieDomains: readonly string[],
    storage: readonly { readonly origin: string; readonly keys: readonly string[] }[],
  ): Promise<void> {
    return this.inner.handoff(cookieDomains, storage)
  }

  sessionSecrets(
    cookieDomains: readonly string[],
    storage: readonly { readonly origin: string; readonly keys: readonly string[] }[],
  ): Promise<readonly string[]> {
    return this.inner.sessionSecrets(cookieDomains, storage)
  }

  cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]> {
    return this.inner.cookieNames(cookieDomains)
  }

  beginRun(policy: ToolRunPolicy, onBlocked: (request: BlockedRequest) => void): void {
    this.inner.beginRun(policy, onBlocked)
    this.running(true)
  }

  unlockIrreversible(): void {
    this.inner.unlockIrreversible()
  }

  endRun(): void {
    try {
      this.inner.endRun()
    } finally {
      this.running(false)
    }
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}
