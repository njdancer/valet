// Runs urlRegex conditions in a worker thread under a deadline. core's screen refuses only the
// exponential shapes; a polynomial one such as `\d*\d*\d*!` passes it and can take minutes on a
// two-thousand-character query, and the main process is the trusted computing base, where a stuck
// regex would freeze every adapter and the MCP endpoint, and no flow deadline could preempt it.
// Past the deadline the worker is terminated, which V8 honours even mid-backtrack, and the
// condition fails as auth-step: invalid. The same approach as credentials' pattern-worker.ts.

import { Worker } from 'node:worker_threads'
import { ValetError } from '@valet/core'

/** Tests a screened pattern against a URL's path and query, off the main thread. */
export interface UrlPatternMatcher {
  /**
   * Whether `pattern` matches `text`. Rejects with ValetError('auth-step', 'invalid') when
   * the pattern fails or runs out of time, and 'auth-step: internal' when it can't run at all.
   */
  test(pattern: string, text: string): Promise<boolean>
  /** Stops the worker. Later tests reject. */
  close(): void
}

/** The part of a Worker this module uses. */
export interface WorkerLike {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: unknown): void
  terminate(): Promise<number>
  /** So a matcher nobody closed never keeps the process alive. */
  unref(): void
}

export type WorkerFactory = (source: string) => WorkerLike

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface WorkerUrlMatcherOptions {
  /** Covers the worker starting, on the first test, as well as matching. */
  readonly timeoutMs?: number
  readonly timers?: Timers
  readonly createWorker?: WorkerFactory
}

const DEFAULT_TIMEOUT_MS = 500

const nodeTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// Plain CommonJS so it runs with eval: true and needs no file on disk next to a bundle. It lives
// for the flow, so each pattern is compiled once; no flags, so no lastIndex carries between tests.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const compiled = new Map()
parentPort.on('message', (request) => {
  let result
  try {
    let regex = compiled.get(request.pattern)
    if (regex === undefined) {
      regex = new RegExp(request.pattern)
      compiled.set(request.pattern, regex)
    }
    result = regex.test(request.text)
  } catch {
    result = 'failed'
  }
  parentPort.postMessage(result)
})
`

export const nodeWorkerFactory: WorkerFactory = (source) =>
  new Worker(source, {
    eval: true,
    // Nothing the pattern needs; and a pattern that allocates wildly dies instead of the app.
    env: {},
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 1 },
  })

/**
 * One worker for the life of a flow, started on the first test, so a flow without urlRegex never
 * starts one. Tests run one at a time. A worker that times out, errors or exits is discarded, and
 * the next test starts a fresh one.
 */
export class WorkerUrlMatcher implements UrlPatternMatcher {
  readonly #timeoutMs: number
  readonly #timers: Timers
  readonly #createWorker: WorkerFactory
  #worker: WorkerLike | null = null
  /** The outstanding test's settle function, or null when none is outstanding. */
  #pending: ((answer: unknown) => void) | null = null
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(options: WorkerUrlMatcherOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#timers = options.timers ?? nodeTimers
    this.#createWorker = options.createWorker ?? nodeWorkerFactory
  }

  test(pattern: string, text: string): Promise<boolean> {
    const run = this.#tail.then(() => this.#run(pattern, text))
    this.#tail = run.catch(() => {})
    return run
  }

  close(): void {
    this.#closed = true
    this.#discard()
    this.#pending?.(null)
  }

  #run(pattern: string, text: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new ValetError('auth-step', 'internal'))
        return
      }
      let worker: WorkerLike
      try {
        worker = this.#worker ?? this.#start()
      } catch {
        reject(new ValetError('auth-step', 'internal'))
        return
      }
      const timer = this.#timers.setTimeout(() => {
        // Terminating is the only way to stop a regex mid-backtrack.
        this.#discard()
        settle(null)
      }, this.#timeoutMs)
      const settle = (answer: unknown): void => {
        if (this.#pending !== settle) return
        this.#pending = null
        this.#timers.clearTimeout(timer)
        if (typeof answer === 'boolean') resolve(answer)
        else reject(new ValetError('auth-step', 'invalid'))
      }
      this.#pending = settle
      worker.postMessage({ pattern, text })
    })
  }

  #start(): WorkerLike {
    const worker = this.#createWorker(WORKER_SOURCE)
    worker.unref()
    const lost = (): void => {
      if (this.#worker !== worker) return
      this.#worker = null
      this.#pending?.(null)
    }
    worker.on('message', (message) => {
      if (this.#worker === worker) this.#pending?.(message)
    })
    worker.on('error', lost)
    worker.on('exit', lost)
    this.#worker = worker
    return worker
  }

  #discard(): void {
    const worker = this.#worker
    this.#worker = null
    if (worker !== null) void worker.terminate().catch(() => {})
  }
}
