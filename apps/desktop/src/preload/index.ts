// The preload: exposes exactly ValetApi (src/shared/api.ts) as window.valet, built from
// the channel list and nothing else. Each method is an ipcRenderer.invoke on its own channel; the
// main process validates every argument and who sent it. Events arrive on one channel and are passed
// on only as { type } (and seq), so nothing else the main process might attach can reach the page.
//
// It also exposes window.valetChrome (WindowChrome): how this window is drawn, read synchronously
// from the argument the main process passed it (core/chrome.ts), for <html data-platform …>.

import { contextBridge, ipcRenderer } from 'electron'
import { chromeFromArgv } from '../main/core/chrome'
import { buildApi } from './api'

contextBridge.exposeInMainWorld('valet', buildApi(ipcRenderer))
contextBridge.exposeInMainWorld('valetChrome', chromeFromArgv(process.argv, process.platform))
