// Ways to start the tool process in tests: in this process, with messages cloned and delivered on
// later turns as a port would; and as a real Node child process, for crashes and kills.

import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ToolChannel, ToolProcessFactory } from '../../src/isolation/host'
import { buildToolScript } from '../../src/isolation/tool-script'
import { serveToolRuns } from '../../src/isolation/worker'

export const HONEST = join(import.meta.dirname, 'honest-tools.ts')
export const HOSTILE = join(import.meta.dirname, 'hostile-tools.ts')

const scripts = new Map<string, Promise<string>>()
export function scriptFor(entry: string): Promise<string> {
  let script = scripts.get(entry)
  if (script === undefined) {
    script = buildToolScript(entry)
    scripts.set(entry, script)
  }
  return script
}

export interface Started {
  readonly start: ToolProcessFactory
  /** Channels started so far. */
  readonly channels: ToolChannel[]
  readonly killed: () => number
}

/** The process side runs here; `kill` stops delivery both ways, as a dead process would. */
export function inMemory(): Started {
  const channels: ToolChannel[] = []
  let killed = 0
  const start: ToolProcessFactory = () => {
    let alive = true
    const toHost: ((message: unknown) => void)[] = []
    const exits: (() => void)[] = []
    let toProcess: ((event: { data: unknown }) => void) | null = null
    serveToolRuns({
      postMessage: (message) => {
        const copy = structuredClone(message)
        setImmediate(() => {
          if (alive) for (const listener of toHost) listener(copy)
        })
      },
      on: (_event, listener) => {
        toProcess = listener
      },
    })
    const channel: ToolChannel = {
      send: (message) => {
        const copy = structuredClone(message)
        setImmediate(() => {
          if (alive) toProcess?.({ data: copy })
        })
      },
      onMessage: (listener) => toHost.push(listener),
      onExit: (listener) => exits.push(listener),
      kill: () => {
        if (!alive) return
        alive = false
        killed++
        for (const exit of exits) exit()
      },
    }
    channels.push(channel)
    return channel
  }
  return { start, channels, killed: () => killed }
}

const tsx = createRequire(import.meta.url).resolve('tsx/esm')

/** A real child process running worker.ts, as the app's utility process does. */
export function childProcess(): Started & { readonly pids: number[] } {
  const channels: ToolChannel[] = []
  const pids: number[] = []
  let killed = 0
  const start: ToolProcessFactory = () => {
    const child = fork(join(import.meta.dirname, 'child-entry.ts'), [], {
      execArgv: ['--import', tsx],
      stdio: 'ignore',
      serialization: 'advanced',
    })
    if (child.pid !== undefined) pids.push(child.pid)
    let exited = false
    const exits: (() => void)[] = []
    child.on('exit', () => {
      exited = true
      for (const exit of exits) exit()
    })
    const channel: ToolChannel = {
      send: (message) => {
        if (!exited && child.connected) child.send(message)
      },
      onMessage: (listener) => child.on('message', listener),
      onExit: (listener) => (exited ? listener() : exits.push(listener)),
      kill: () => {
        if (exited) return
        killed++
        child.kill('SIGKILL')
      },
    }
    channels.push(channel)
    return channel
  }
  return { start, channels, pids, killed: () => killed }
}
