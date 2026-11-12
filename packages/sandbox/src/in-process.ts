// QuickJS runs in this process, behind the same ToolChannel the sandbox renderer gives: for tests
// and for adapter packages' own tests. Messages cross as JSON copies, asynchronously, as they do
// over a MessagePort. Not a boundary by itself (an interpreter escape lands here): the app always
// uses the sandbox renderer.

import type { ToolChannel, ToolProcessFactory } from '@valet/runtime'
import type { QuickJSFactory } from './module'
import { type ServeOptions, serveRun } from './serve'

const copy = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown

export function inProcessQuickJS(module: QuickJSFactory, options: ServeOptions = {}): ToolProcessFactory {
  return (): ToolChannel => {
    const toHost: ((message: unknown) => void)[] = []
    const exits: (() => void)[] = []
    let toRun: ((data: unknown) => void) | null = null
    let exited = false
    const exit = (): void => {
      if (exited) return
      exited = true
      end()
      for (const listener of exits.splice(0)) listener()
    }
    const end = serveRun(
      {
        postMessage: (message) => {
          const data = copy(message)
          queueMicrotask(() => {
            if (!exited) for (const listener of toHost) listener(data)
          })
        },
        onMessage: (listener) => {
          toRun = listener
        },
      },
      module,
      {
        ...options,
        // A broken run takes its "process" with it, as the renderer is destroyed in the app.
        onBroken: () => {
          options.onBroken?.()
          queueMicrotask(exit)
        },
      },
    )
    return {
      send: (message) => {
        if (exited) return
        const data = copy(message)
        setTimeout(() => {
          if (!exited) toRun?.(data)
        }, 0)
      },
      onMessage: (listener) => {
        toHost.push(listener)
      },
      onExit: (listener) => {
        if (exited) listener()
        else exits.push(listener)
      },
      kill: exit,
    }
  }
}
