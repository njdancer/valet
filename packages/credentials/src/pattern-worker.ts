// Runs an adapter's OTP pattern in a worker thread under a deadline. A backtracking regex can take
// exponential time on ordinary text, and the main process is the trusted computing base, so the
// pattern never runs on its event loop: past the deadline the worker is terminated, which V8 honours
// even mid-backtrack, and the step fails as invalid.

import { Worker } from 'node:worker_threads'
import { CredentialError, ValetError } from '@valet/core'
import { nodeTimers, type Timers } from './process'

/** Applies a pattern to each text in turn. */
export interface PatternMatcher {
  /**
   * For each text, its first capture group (or whole match), or null when it doesn't match.
   * Rejects with ValetError('otp', 'invalid') when the pattern fails or runs out of time.
   */
  captures(pattern: string, texts: readonly string[]): Promise<(string | null)[]>
}

/** The part of a Worker this module uses. */
export interface WorkerLike {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

export type WorkerFactory = (source: string, data: WorkerInput) => WorkerLike

export interface WorkerInput {
  readonly pattern: string
  readonly texts: readonly string[]
}

export interface WorkerPatternMatcherOptions {
  /** Covers the worker starting as well as matching; a worker starts in well under 50 ms. */
  readonly timeoutMs?: number
  readonly timers?: Timers
  readonly createWorker?: WorkerFactory
}

const DEFAULT_TIMEOUT_MS = 500

// Plain CommonJS so it runs with eval: true and needs no file on disk next to a bundle.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
let result
try {
  const pattern = new RegExp(workerData.pattern)
  result = workerData.texts.map((text) => {
    const match = pattern.exec(text)
    return match === null ? null : (match[1] ?? match[0])
  })
} catch {
  result = 'failed'
}
parentPort.postMessage(result)
`

export const nodeWorkerFactory: WorkerFactory = (source, data) =>
  new Worker(source, {
    eval: true,
    workerData: data,
    // Nothing the pattern needs; and a pattern that allocates wildly dies instead of the app.
    env: {},
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 1 },
  })

export class WorkerPatternMatcher implements PatternMatcher {
  readonly #timeoutMs: number
  readonly #timers: Timers
  readonly #createWorker: WorkerFactory

  constructor(options: WorkerPatternMatcherOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#timers = options.timers ?? nodeTimers
    this.#createWorker = options.createWorker ?? nodeWorkerFactory
  }

  captures(pattern: string, texts: readonly string[]): Promise<(string | null)[]> {
    return new Promise((resolve, reject) => {
      let worker: WorkerLike
      try {
        worker = this.#createWorker(WORKER_SOURCE, { pattern, texts: [...texts] })
      } catch {
        reject(new CredentialError('unavailable'))
        return
      }
      let settled = false
      const finish = (outcome: (string | null)[] | null): void => {
        if (settled) return
        settled = true
        this.#timers.clearTimeout(timer)
        void worker.terminate().catch(() => {})
        if (outcome === null) reject(new ValetError('otp', 'invalid'))
        else resolve(outcome)
      }
      const timer = this.#timers.setTimeout(() => finish(null), this.#timeoutMs)
      worker.on('message', (message) => finish(isCaptures(message, texts.length) ? message : null))
      worker.on('error', () => finish(null))
      worker.on('exit', () => finish(null))
    })
  }
}

function isCaptures(message: unknown, length: number): message is (string | null)[] {
  return (
    Array.isArray(message) &&
    message.length === length &&
    message.every((item) => item === null || typeof item === 'string')
  )
}
