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
import { BOOTSTRAP, PRELUDE } from './bootstrap'
import type { HostMessage } from './protocol'

/** Electron's `process.parentPort`, or a test double. */
export interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): void
}

export { BOOTSTRAP, PRELUDE }

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
