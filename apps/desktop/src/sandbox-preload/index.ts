// The sandbox renderer's preload (docs/sandbox.md): runs QuickJS for tool code in this sandboxed,
// hidden window's isolated world. Nothing is exposed to the page, which is empty.

import { serveSandbox } from '@valet/sandbox/renderer'
import { ipcRenderer } from 'electron'

serveSandbox(ipcRenderer as never)
