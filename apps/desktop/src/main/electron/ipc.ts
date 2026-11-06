// ipcMain glue: one handler per channel, each handing the request and who sent it to the
// dispatcher (core/ipc.ts), which checks everything. The event channel goes to our windows only.

import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type { AppEvent } from '../../shared/api'
import { EVENT_CHANNEL, INVOKE_METHODS, invokeChannel } from '../core/channels'
import { createDispatcher, type MainApi, type Sender } from '../core/ipc'
import { isAppPage, type RendererBase } from '../core/launch'
import type { AppWindows } from './windows'

function senderOf(event: IpcMainInvokeEvent, windows: AppWindows): Sender {
  const frame = event.senderFrame
  const main = event.sender.mainFrame
  const window = windows.windowOf(event.sender)
  return {
    role: window?.role ?? null,
    shows: window?.shows ?? null,
    frameUrl: frame?.url ?? '',
    mainFrame:
      frame !== null &&
      frame !== undefined &&
      frame.processId === main.processId &&
      frame.routingId === main.routingId,
  }
}

export function registerIpc(
  api: MainApi,
  windows: AppWindows,
  base: RendererBase,
  log: (line: string) => void,
): void {
  const dispatcher = createDispatcher(api, {
    isAppPage: (url) => isAppPage(base, url),
    onRefused: (method, why) => log(`ipc refused: ${method ?? '(unknown channel)'} (${why})`),
  })
  for (const method of INVOKE_METHODS) {
    const channel = invokeChannel(method)
    ipcMain.handle(channel, (event, ...args: unknown[]) =>
      dispatcher.dispatch(channel, args, senderOf(event, windows)),
    )
  }
}

export function broadcast(windows: AppWindows, event: AppEvent): void {
  for (const window of windows.all()) window.webContents.send(EVENT_CHANNEL, event)
}
