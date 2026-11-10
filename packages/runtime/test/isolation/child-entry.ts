// The child side of processes.ts's childProcess(): worker.ts over Node's IPC channel.

import { serveToolRuns } from '../../src/isolation/worker'

serveToolRuns({
  postMessage: (message) => process.send?.(message),
  on: (_event, listener) => process.on('message', (data) => listener({ data })),
})
