// The tool process as an Electron utility process: one per tool call, killed when the call ends
// (ToolHost and runIsolated in packages/runtime). It runs tool-process-entry.ts, which evaluates
// the adapter's tool script in a node:vm context with only the capability API. A utility process is
// a full Node process (Electron ignores --permission there), so this is crash and hang isolation
// with a capability-only context inside, not M7's sandbox (docs/registry-and-sandbox.md).

import type { ToolChannel, ToolProcessFactory } from '@valet/runtime'
import { utilityProcess } from 'electron'

export function utilityToolProcess(entry: string): ToolProcessFactory {
  return (): ToolChannel => {
    const child = utilityProcess.fork(entry, [], { serviceName: 'Valet tool code', stdio: 'ignore' })
    let exited = false
    const exits: (() => void)[] = []
    child.once('exit', () => {
      exited = true
      for (const exit of exits.splice(0)) exit()
    })
    return {
      send: (message) => {
        if (!exited) child.postMessage(message)
      },
      onMessage: (listener) => {
        child.on('message', listener)
      },
      onExit: (listener) => {
        if (exited) listener()
        else exits.push(listener)
      },
      kill: () => {
        if (!exited) child.kill()
      },
    }
  }
}
