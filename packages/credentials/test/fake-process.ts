// A scripted child process and a manual timer, so process-driven code runs without spawning anything.

import { EventEmitter } from 'node:events'
import type { ChildLike, Spawner, Timers } from '../src/process'

export class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  /** What was written to stdin, copied at the time, so a later zeroing of the source shows. */
  readonly input: Buffer[] = []
  /** The buffers handed to stdin themselves, to check that the caller zeroes them. */
  readonly inputSources: Buffer[] = []
  readonly stdin = {
    end: (chunk: Buffer): void => {
      this.inputSources.push(chunk)
      this.input.push(Buffer.from(chunk))
    },
    on: (_event: 'error', _listener: (error: Error) => void): void => {},
  }
  readonly kills: (NodeJS.Signals | undefined)[] = []

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }

  /** Writes stdout and stderr, then exits with `code`, all on a later tick. */
  finish(code: number | null, stdout: Buffer | string = '', stderr = ''): void {
    queueMicrotask(() => {
      if (stdout.length > 0) this.stdout.emit('data', Buffer.from(stdout))
      if (stderr.length > 0) this.stderr.emit('data', Buffer.from(stderr))
      this.emit('close', code)
    })
  }
}

export interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly child: FakeChild
  /** Whether the caller asked for a stdin pipe. */
  readonly input: boolean
}

/** A spawner that records each call and lets `script` drive the child it returns. */
export function scriptedSpawner(script: (child: FakeChild, call: Omit<SpawnCall, 'child'>) => void): {
  spawner: Spawner
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  const spawner: Spawner = (command, args, options) => {
    const child = new FakeChild()
    const input = options?.input === true
    calls.push({ command, args, child, input })
    script(child, { command, args, input })
    return child
  }
  return { spawner, calls }
}

/** Timers that fire only when the test says so. */
export class ManualTimers implements Timers {
  readonly pending = new Map<number, { callback: () => void; ms: number }>()
  #next = 1

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++
    this.pending.set(id, { callback, ms })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }

  fireAll(): void {
    for (const [id, timer] of [...this.pending]) {
      this.pending.delete(id)
      timer.callback()
    }
  }
}
