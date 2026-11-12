// Tool code in QuickJS (quickjs-ng, compiled to WebAssembly): the inner layer of the sandbox
// (docs/sandbox.md#inside-quickjs). The same prelude, tool script and bootstrap as the `vm` worker
// run in a fresh QuickJS runtime per run, so a tool behaves the same in both. QuickJS has no host
// globals at all: no require, process, fetch, timers, WebAssembly or module loader. The only host
// function inside is `send`, which takes a string; what it's given leaves as JSON text.
//
// No Node and no Electron imports: the sandbox renderer's preload runs this file, and so do tests
// in plain Node.

import { BOOTSTRAP, PRELUDE } from '@valet/runtime/bootstrap'
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from 'quickjs-emscripten-core'

export interface QuickJSLimits {
  /** The runtime's heap, in bytes. */
  readonly memoryBytes: number
  /** QuickJS's own stack limit, in bytes. */
  readonly stackBytes: number
  /** The longest one synchronous slice (a message and the jobs it queues) may run, in ms. */
  readonly sliceMs: number
}

export const DEFAULT_LIMITS: QuickJSLimits = {
  memoryBytes: 128 * 1024 * 1024,
  // QuickJS's limit must trip before the WebAssembly host's own stack does (about 1 MB in total).
  stackBytes: 256 * 1024,
  sliceMs: 5_000,
}

/**
 * Globals quickjs-ng adds beyond the language that tool code has no use for, then string
 * compilation, closed the way the vm worker's `codeGeneration: { strings: false }` closes it: eval
 * and every function constructor throw EvalError. Compiling more QuickJS code would reach nothing
 * more, but a tool (or a zod version) that works here must work in the vm worker and in tests too.
 */
const QUICKJS_PRELUDE = `'use strict';
for (const name of ['gc', 'performance', 'navigator', 'queueMicrotask', 'os', 'std', 'print', 'scriptArgs', 'bjson', 'console', 'DOMException']) { try { delete globalThis[name] } catch {} }
;(() => {
  const refuse = function () { throw new EvalError('Code generation from strings disallowed for this context') }
  for (const f of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    Object.defineProperty(Object.getPrototypeOf(f), 'constructor', { value: refuse, writable: false, configurable: false })
  }
  Object.defineProperty(refuse, 'prototype', { value: Function.prototype })
  Object.defineProperty(globalThis, 'Function', { value: refuse, writable: false, configurable: false, enumerable: false })
  Object.defineProperty(globalThis, 'eval', { value: refuse, writable: false, configurable: false, enumerable: false })
})()`

export interface QuickJSRun {
  /** Hands the bootstrap one message, as JSON text, and runs every job it queues. */
  deliver(text: string): void
  /** Frees the runtime. Safe to call more than once. */
  dispose(): void
  /** True once the run was interrupted, ran out of memory, or failed outside tool code. */
  readonly broken: boolean
}

/**
 * Evaluates `script` in a new QuickJS runtime. `send` gets the bootstrap's messages as JSON text.
 * `onBroken` is called once if the run has to stop (a slice past its deadline, the heap limit, a
 * failure in the bootstrap itself); the run has already posted `done` with `other` by then.
 */
export function openQuickJSRun(
  module: QuickJSWASMModule,
  script: string,
  send: (text: string) => void,
  options: {
    readonly limits?: QuickJSLimits
    readonly now?: () => number
    readonly onBroken?: () => void
  } = {},
): QuickJSRun {
  const limits = options.limits ?? DEFAULT_LIMITS
  const now = options.now ?? (() => Date.now())
  let runtime: QuickJSRuntime | null = module.newRuntime()
  runtime.setMemoryLimit(limits.memoryBytes)
  runtime.setMaxStackSize(limits.stackBytes)
  let deadline = Number.POSITIVE_INFINITY
  let interrupted = false
  runtime.setInterruptHandler(() => {
    if (now() <= deadline) return false
    interrupted = true
    return true
  })
  const context: QuickJSContext = runtime.newContext()
  let deliverFn: QuickJSHandle | null = null
  let broken = false
  let finished = false
  let disposed = false

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    try {
      deliverFn?.dispose()
      context.dispose()
      runtime?.dispose()
    } catch {
      // A runtime that broke mid-slice can hold handles QuickJS asserts on; it's gone either way.
    }
    runtime = null
  }
  const breakRun = (): void => {
    if (broken) return
    broken = true
    try {
      send(JSON.stringify({ t: 'done', ok: false, error: { kind: 'other' } }))
    } catch {}
    dispose()
    options.onBroken?.()
  }
  /** Runs `work` with the slice deadline set, then every pending job. False if it broke. */
  const slice = (work: () => boolean): boolean => {
    if (broken || disposed || runtime === null) return false
    deadline = now() + limits.sliceMs
    try {
      if (!work()) return false
      for (;;) {
        const jobs = runtime.executePendingJobs()
        if (jobs.error) {
          jobs.error.dispose()
          return false
        }
        if (jobs.value === 0) return true
      }
    } catch {
      return false
    } finally {
      deadline = Number.POSITIVE_INFINITY
    }
  }
  const sliceOk = (work: () => boolean): boolean => {
    const ok = slice(work)
    // An interrupt can surface as tool code's own exception; the run is still over.
    return ok && !interrupted
  }
  const evaluate = (source: string, filename: string): boolean => {
    const result = context.evalCode(source, filename, { type: 'global', strict: true })
    if (result.error) {
      result.error.dispose()
      return false
    }
    result.value.dispose()
    return true
  }

  const sendFn = context.newFunction('send', (handle) => {
    if (context.typeof(handle) !== 'string') return
    const text = context.getString(handle)
    try {
      send(text)
    } catch {}
  })
  const started = sliceOk(() => {
    if (!evaluate(PRELUDE, 'valet-prelude.js') || !evaluate(QUICKJS_PRELUDE, 'valet-quickjs-prelude.js'))
      return false
    // A script that throws while it loads is tool code's failure, not the sandbox's: it answers as
    // the vm worker does, with `other`, and the run is over.
    if (!evaluate(script, 'tool-script.js')) {
      if (interrupted) return false
      send(JSON.stringify({ t: 'done', ok: false, error: { kind: 'other' } }))
      finished = true
      return true
    }
    const bootstrap = context.evalCode(BOOTSTRAP, 'valet-bootstrap.js', { type: 'global', strict: true })
    if (bootstrap.error) {
      bootstrap.error.dispose()
      return false
    }
    const made = context.callFunction(bootstrap.value, context.undefined, sendFn)
    bootstrap.value.dispose()
    if (made.error) {
      made.error.dispose()
      return false
    }
    deliverFn = made.value
    return true
  })
  sendFn.dispose()
  if (!started) breakRun()
  else if (finished) dispose()

  return {
    deliver(text: string): void {
      if (broken || finished || disposed || deliverFn === null) return
      const fn = deliverFn
      const ok = sliceOk(() => {
        const message = context.newString(text)
        const result = context.callFunction(fn, context.undefined, message)
        message.dispose()
        if (result.error) {
          result.error.dispose()
          return false
        }
        result.value.dispose()
        return true
      })
      if (!ok) breakRun()
    },
    dispose,
    get broken() {
      return broken
    },
  }
}
