// The sandbox renderer's side (docs/sandbox.md#the-renderer-around-it), run by the preload in the
// isolated world of a sandboxed, hidden BrowserWindow. The main process sends the QuickJS wasm's
// bytes once, then one MessagePort per run; each port gets a fresh QuickJS instance and runtime.
// It answers pings, so the main process can tell a renderer stuck in a C-level operation, and says
// when a run broke, so the main process destroys this renderer rather than trust it further.
//
// The IPC object is passed in: no module outside apps/desktop and browser-electron imports Electron.

import { compileQuickJS, type QuickJSFactory, quickJSFactory } from './module'
import { serveRun } from './serve'

/** Channel names, shared with the main process (apps/desktop/src/main/electron/sandbox.ts). */
export const SANDBOX_CHANNELS = {
  wasm: 'valet-sandbox:wasm',
  ready: 'valet-sandbox:ready',
  run: 'valet-sandbox:run',
  ping: 'valet-sandbox:ping',
  pong: 'valet-sandbox:pong',
  broken: 'valet-sandbox:broken',
} as const

/** A run's control message from the main process, never passed to QuickJS. */
export const END_RUN = 'valet-sandbox:end'

interface RendererPort {
  postMessage(message: unknown): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
  start(): void
  close(): void
}

export interface SandboxIpc {
  on(
    channel: string,
    listener: (event: { readonly ports: readonly RendererPort[] }, ...args: unknown[]) => void,
  ): void
  send(channel: string, ...args: unknown[]): void
}

export function serveSandbox(ipc: SandboxIpc): void {
  let factory: Promise<QuickJSFactory> | null = null
  ipc.on(SANDBOX_CHANNELS.wasm, (_event, bytes) => {
    if (factory !== null || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return
    const buffer = bytes instanceof ArrayBuffer ? bytes : (bytes as Uint8Array).slice().buffer
    factory = compileQuickJS(buffer as ArrayBuffer).then(quickJSFactory)
    factory.then(
      () => ipc.send(SANDBOX_CHANNELS.ready, true),
      () => ipc.send(SANDBOX_CHANNELS.ready, false),
    )
  })
  ipc.on(SANDBOX_CHANNELS.ping, (_event, id) => ipc.send(SANDBOX_CHANNELS.pong, id))
  ipc.on(SANDBOX_CHANNELS.run, (event) => {
    const port = event.ports[0]
    const made = factory
    if (port === undefined || made === null) return
    let listener: ((data: unknown) => void) | null = null
    let end: () => void = () => {}
    port.onmessage = (message) => {
      if (message.data === END_RUN) {
        end()
        port.close()
        return
      }
      listener?.(message.data)
    }
    end = serveRun(
      {
        postMessage: (m) => port.postMessage(m),
        onMessage: (l) => {
          listener = l
        },
      },
      () => made.then((f) => f()),
      { onBroken: () => ipc.send(SANDBOX_CHANNELS.broken) },
    )
    port.start()
  })
}
