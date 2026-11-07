// window.valet, built over an ipcRenderer-shaped object so it is tested without Electron.

import {
  APP_EVENT_TYPES,
  EVENT_CHANNEL,
  INVOKE_METHODS,
  type InvokeMethod,
  invokeChannel,
} from '../main/core/channels'
import type { AppEvent, ValetApi } from '../shared/api'

/** The slice of ipcRenderer the preload uses. */
export interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, message: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, message: unknown) => void): unknown
}

type Tree = { [key: string]: Tree | ((...args: unknown[]) => Promise<unknown>) }

function invoker(ipc: IpcLike, method: InvokeMethod) {
  const channel = invokeChannel(method)
  return (...args: unknown[]): Promise<unknown> => {
    // An optional argument passed as undefined is the same call as one left out.
    const sent = [...args]
    while (sent.length > 0 && sent[sent.length - 1] === undefined) sent.pop()
    return ipc.invoke(channel, ...sent)
  }
}

/** Only known event types pass, as fresh objects with nothing but their fields. */
export function eventFrom(message: unknown): AppEvent | null {
  if (message === null || typeof message !== 'object') return null
  const { type, seq } = message as { type?: unknown; seq?: unknown }
  if (typeof type !== 'string' || !(APP_EVENT_TYPES as readonly string[]).includes(type)) return null
  if (type === 'audit-appended') {
    return { type, seq: typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : 0 }
  }
  return { type } as AppEvent
}

export function buildApi(ipc: IpcLike): ValetApi {
  const api: Tree = {}
  for (const method of INVOKE_METHODS) {
    const parts = method.split('.')
    let node = api
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {}
      node = node[part] as Tree
    }
    node[parts[parts.length - 1] as string] = invoker(ipc, method)
  }
  const onEvent = (listener: (event: AppEvent) => void): (() => void) => {
    const handler = (_event: unknown, message: unknown) => {
      const event = eventFrom(message)
      if (event !== null) listener(event)
    }
    ipc.on(EVENT_CHANNEL, handler)
    return () => {
      ipc.removeListener(EVENT_CHANNEL, handler)
    }
  }
  return { ...(api as unknown as Omit<ValetApi, 'onEvent'>), onEvent }
}
