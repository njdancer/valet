// Step timeouts. Every primitive runs under one, measured in Node: a page's own timers die with it
// when it navigates.

import { ValetError } from '@valet/core'
import type { Timers } from './platform'

/**
 * Runs `work` and rejects with timeout/timed-out after `ms`. The signal tells long-running work
 * (typing, mostly) to stop sending input once the step has been given up on.
 */
export function withTimeout<T>(
  timers: Timers,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const handle = timers.setTimeout(() => {
      controller.abort()
      reject(new ValetError('timeout', 'timed-out'))
    }, ms)
    Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        (value) => {
          timers.clearTimeout(handle)
          resolve(value)
        },
        (error: unknown) => {
          timers.clearTimeout(handle)
          reject(error)
        },
      )
  })
}
