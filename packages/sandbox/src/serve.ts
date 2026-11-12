// One run over one port, in QuickJS: what the sandbox renderer's preload does with each port the
// main process hands it, and what the in-process test channel does. The host sends `init` with the
// tool script, then `run`, `describe` or `check`, then replies and `abort`. The protocol is the
// `vm` worker's (packages/runtime/src/isolation/protocol.ts), unchanged.
//
// No Node and no Electron imports (the preload bundles this file).

import type { QuickJSFactory } from './module'
import { openQuickJSRun, type QuickJSLimits, type QuickJSRun } from './quickjs'

/** A MessagePort's shape, as both Electron's renderer and the test channel provide it. */
export interface RunPort {
  postMessage(message: unknown): void
  /** Each message the host sends. Untrusted only in the sense that it's parsed as data. */
  onMessage(listener: (data: unknown) => void): void
}

export interface ServeOptions {
  readonly limits?: QuickJSLimits
  readonly now?: () => number
  /** The run broke (deadline, heap, bootstrap failure): the renderer should not be trusted further. */
  readonly onBroken?: () => void
}

/** Serves one run on `port`. Returns a function that ends it (the host's kill). */
export function serveRun(port: RunPort, newModule: QuickJSFactory, options: ServeOptions = {}): () => void {
  let run: QuickJSRun | null = null
  let starting = false
  /** What arrives while the instance is being made, delivered in order once it is. */
  const waiting: string[] = []
  let ended = false
  const post = (text: string): void => {
    if (ended) return
    // Parsed here, outside QuickJS, so what reaches the port is plain data.
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    port.postMessage(message)
  }
  port.onMessage((data) => {
    if (ended || data === null || typeof data !== 'object') return
    const message = data as { readonly t?: unknown; readonly script?: unknown }
    if (message.t === 'init') {
      if (starting || typeof message.script !== 'string') return
      starting = true
      const script = message.script
      newModule().then(
        (module) => {
          if (ended) return
          run = openQuickJSRun(module, script, post, {
            ...(options.limits === undefined ? {} : { limits: options.limits }),
            ...(options.now === undefined ? {} : { now: options.now }),
            onBroken: () => options.onBroken?.(),
          })
          port.postMessage({ t: 'ready' })
          for (const text of waiting.splice(0)) run.deliver(text)
        },
        () => {
          if (ended) return
          port.postMessage({ t: 'done', ok: false, error: { kind: 'other' } })
          options.onBroken?.()
        },
      )
      return
    }
    if (!starting) return
    let text: string
    try {
      text = JSON.stringify(data)
    } catch {
      return
    }
    if (run === null) waiting.push(text)
    else run.deliver(text)
  })
  return () => {
    ended = true
    ;(run as QuickJSRun | null)?.dispose()
  }
}
