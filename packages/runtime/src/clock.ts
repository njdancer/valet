// Time is injected so that rate budgets, cooldowns and timeouts are deterministic in tests.

import { ValetError } from '@valet/core'

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
}

/** Resolves after `ms`, or rejects with ValetError('tool-run', 'aborted') when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export const systemClock: Clock = { now: () => Date.now() }

export const systemSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ValetError('tool-run', 'aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ValetError('tool-run', 'aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
