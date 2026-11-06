// Time is injected so that rate budgets, cooldowns and timeouts are deterministic in tests.

import { SiteAdapterError } from '@siteadapter/core'

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
}

/** Resolves after `ms`, or rejects with SiteAdapterError('tool-run', 'aborted') when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export const systemClock: Clock = { now: () => Date.now() }

export const systemSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SiteAdapterError('tool-run', 'aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new SiteAdapterError('tool-run', 'aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
