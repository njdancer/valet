// The utility process's entry (built to out/main/tool-process.js): the runtime's tool worker over
// Electron's parent port. It imports nothing from the adapter: the tool script arrives as a message.

import { serveToolRuns } from '@valet/runtime/tool-worker'

const port = process.parentPort
serveToolRuns({
  postMessage: (message) => port.postMessage(message),
  on: (_event, listener) => {
    port.on('message', listener)
  },
})
