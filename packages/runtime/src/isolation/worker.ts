// The process side of an isolated tool run: what the app's utility process runs (and what tests
// run directly). It evaluates the adapter's tool script in a fresh `node:vm` context per run, with
// no `require`, no `process`, no `import()`, no timers, no `fetch` and no string compilation:
// nothing but JavaScript's own built-ins and the ToolContext the bootstrap below builds out of
// messages. Only strings cross between this file and the context, so no host object (and so no
// host Function constructor) is reachable from tool code.
//
// This is not M7's sandbox (docs/registry-and-sandbox.md#the-sandbox): `node:vm` is not a security
// boundary, and the process around it is a full Node process. It gives the shape M7 keeps (tool
// code as a script with only injected capabilities, JSON messages over a port, one context per run,
// a process the host can kill) and the crash and hang isolation M3 needs.

import vm from 'node:vm'
import type { HostMessage } from './protocol'

/** Electron's `process.parentPort`, or a test double. */
export interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): void
}

/** Run in the fresh context before the tool script, so the script never sees what it removes. */
const PRELUDE = `'use strict'; delete globalThis.SharedArrayBuffer; delete globalThis.Atomics; delete globalThis.WebAssembly; delete globalThis.console;`

/**
 * Inside the context. `send` is the only host function it ever holds, kept in this closure and
 * called with strings; what it throws is never rethrown. It returns `deliver`, which the host calls
 * with JSON text. The tool script must define `__valetTools` (its IIFE's global) with `tools`,
 * `ValetError` and `NeedsUserError`.
 */
const BOOTSTRAP = `(function (send) {
  'use strict'
  // False when the message isn't JSON (a cycle, say); what send throws is never rethrown either way.
  const post = (message) => {
    let text
    try { text = JSON.stringify(message) } catch { return false }
    if (typeof text !== 'string') return false
    try { send(text) } catch {}
    return true
  }
  const lib = globalThis.__valetTools
  // A var the script declared, so it can't be deleted; emptied instead.
  globalThis.__valetTools = undefined
  if (!lib || typeof lib !== 'object') { post({ t: 'done', ok: false, error: { kind: 'other' } }); return () => {} }
  const { tools, ValetError, NeedsUserError } = lib
  let url = ''
  let next = 1
  const pending = new Map()
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) { if (type === 'abort' && typeof listener === 'function') listeners.add(listener) },
    removeEventListener(type, listener) { listeners.delete(listener) },
    throwIfAborted() { if (signal.aborted) throw new ValetError('tool-run', 'aborted') },
  }
  const fromWire = (error) => {
    if (error && error.kind === 'valet') return new ValetError(error.stage, error.errorClass)
    if (error && error.kind === 'needsUser') return new NeedsUserError(error.reason)
    return new Error('capability failed')
  }
  const toWire = (error) => {
    if (error instanceof ValetError) return { kind: 'valet', stage: error.stage, errorClass: error.errorClass }
    if (error instanceof NeedsUserError) return { kind: 'needsUser', reason: error.reason }
    return { kind: 'other' }
  }
  const call = (capability, ...args) => {
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop()
    const id = next++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      if (!post({ t: 'call', id, capability, args })) {
        pending.delete(id)
        reject(new ValetError('tool-run', 'invalid'))
      }
    })
  }
  const ctx = Object.freeze({
    page: Object.freeze({
      goto: (u) => call('page.goto', u).then(() => undefined),
      currentUrl: () => url,
      click: (s) => call('page.click', s).then(() => undefined),
      fill: (s, t) => call('page.fill', s, t).then(() => undefined),
      extract: (s, o) => call('page.extract', s, o),
      evaluate: (source, a) => call('page.evaluate', source, a),
      fetch: (p, init) => call('page.fetch', p, init),
    }),
    session: Object.freeze({ ensure: () => call('session.ensure') }),
    confirm: (action) => call('confirm', action),
    signal,
  })
  return function deliver(text) {
    const m = JSON.parse(text)
    if (typeof m.url === 'string') url = m.url
    if (m.t === 'run') {
      const impl = Object.prototype.hasOwnProperty.call(tools, m.tool) ? tools[m.tool] : undefined
      if (!impl || typeof impl.run !== 'function') { post({ t: 'done', ok: false, error: { kind: 'valet', stage: 'manifest', errorClass: 'not-found' } }); return }
      Promise.resolve()
        .then(() => impl.run(ctx, m.input))
        .then(
          (value) => value === undefined ? post({ t: 'done', ok: true }) : post({ t: 'done', ok: true, value }),
          (error) => post({ t: 'done', ok: false, error: toWire(error) }),
        )
        .then((sent) => { if (!sent) post({ t: 'done', ok: false, error: { kind: 'valet', stage: 'tool-output', errorClass: 'invalid' } }) })
    } else if (m.t === 'reply') {
      const waiting = pending.get(m.id)
      if (!waiting) return
      pending.delete(m.id)
      if (m.ok) waiting.resolve(m.value)
      else waiting.reject(fromWire(m.error))
    } else if (m.t === 'abort') {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = new ValetError('tool-run', 'aborted')
      for (const listener of listeners) { try { listener() } catch {} }
    }
  }
})`

/**
 * Serves one run on `port`: the host sends `init` with the tool script, then `run`. Tool code's
 * messages go back as plain JSON. A second `init` is ignored; the host starts a new process per run.
 */
export function serveToolRuns(port: ParentPort): void {
  let deliver: ((text: string) => void) | null = null
  const post = (text: string): void => {
    // Parsed here, outside the context, so what reaches the port is host data, never a context object.
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    port.postMessage(message)
  }
  port.on('message', (event) => {
    const message = event.data as HostMessage
    if (message === null || typeof message !== 'object') return
    if (message.t === 'init') {
      if (deliver !== null || typeof message.script !== 'string') return
      deliver = evaluateToolScript(message.script, post)
      port.postMessage({ t: 'ready' })
      return
    }
    if (deliver === null) return
    deliver(JSON.stringify(message))
  })
}

/** A fresh context with the script and the bootstrap in it; returns the context's `deliver`. */
export function evaluateToolScript(script: string, send: (text: string) => void): (text: string) => void {
  const context = vm.createContext(Object.create(null), {
    name: 'valet-tool-code',
    codeGeneration: { strings: false, wasm: false },
  })
  try {
    // Shared memory is only a side channel, wasm can't compile here, and V8's console only reaches an
    // inspector; tool code needs none of them.
    vm.runInContext(PRELUDE, context, { filename: 'valet-prelude.js' })
    vm.runInContext(script, context, { filename: 'tool-script.js' })
    const bootstrap = vm.runInContext(BOOTSTRAP, context, { filename: 'valet-bootstrap.js' }) as (
      send: (text: string) => void,
    ) => (text: string) => void
    // A host function the context holds: it takes strings only, and returns nothing.
    const deliver = bootstrap((text: string) => {
      if (typeof text === 'string') send(text)
    })
    return (text) => {
      try {
        deliver(text)
      } catch {
        // A context that throws while handling a message has nothing to say to the host.
      }
    }
  } catch {
    send(JSON.stringify({ t: 'done', ok: false, error: { kind: 'other' } }))
    return () => {}
  }
}
