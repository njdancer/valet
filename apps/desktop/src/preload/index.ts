// The preload: exposes exactly SiteAdapterApi (src/shared/api.ts) as window.siteadapter, built from
// the channel list and nothing else. Each method is an ipcRenderer.invoke on its own channel; the
// main process validates every argument and who sent it. Events arrive on one channel and are passed
// on only as { type } (and seq), so nothing else the main process might attach can reach the page.

// Electron glue: covered by the smoke test (test/smoke) and the e2e suite, not by unit tests.
/* v8 ignore start */

import { contextBridge, ipcRenderer } from 'electron'
import { buildApi } from './api'

contextBridge.exposeInMainWorld('siteadapter', buildApi(ipcRenderer))
/* v8 ignore stop */
