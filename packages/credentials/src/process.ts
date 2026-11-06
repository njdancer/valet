// Runs a helper binary (op, security) with a bounded wait and bounded output. Spawning and timers
// are injected so tests never start a real 1Password or Keychain prompt.

import { spawn } from 'node:child_process'

/** The part of a ChildProcess this module uses. */
export interface ChildLike {
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** Starts `command` with `args` as argv. Never through a shell. */
export type Spawner = (command: string, args: readonly string[]) => ChildLike

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const nodeSpawner: Spawner = (command, args) =>
  spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })

export const nodeTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export type ProcessOutcome =
  /** `stdout` is owned by the caller, who must zero it when done. */
  | {
      readonly kind: 'exited'
      readonly code: number | null
      readonly stdout: Buffer
      readonly stderr: string
    }
  | { readonly kind: 'timed-out' }
  /** The binary isn't installed (ENOENT). */
  | { readonly kind: 'missing' }
  /** Any other spawn failure, or output larger than allowed. */
  | { readonly kind: 'failed' }

export interface RunOptions {
  readonly timeoutMs: number
  readonly maxStdoutBytes: number
  readonly timers: Timers
}

// Enough of stderr to classify a failure; it is never passed on.
const MAX_STDERR_BYTES = 8 * 1024

/** Runs a process to completion. Never rejects. Zeroes partial stdout on every path but `exited`. */
export function runProcess(
  spawner: Spawner,
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0
    let settled = false
    let timer: unknown

    const wipe = (): void => {
      for (const chunk of stdoutChunks) chunk.fill(0)
      stdoutChunks.length = 0
    }
    const settle = (outcome: ProcessOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) options.timers.clearTimeout(timer)
      if (outcome.kind !== 'exited') wipe()
      resolve(outcome)
    }

    let child: ChildLike
    try {
      child = spawner(command, args)
    } catch (error) {
      settle({ kind: isEnoent(error) ? 'missing' : 'failed' })
      return
    }

    timer = options.timers.setTimeout(() => {
      child.kill('SIGKILL')
      settle({ kind: 'timed-out' })
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) {
        chunk.fill(0)
        return
      }
      stdoutChunks.push(chunk)
      stdoutBytes += chunk.length
      if (stdoutBytes > options.maxStdoutBytes) {
        child.kill('SIGKILL')
        settle({ kind: 'failed' })
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return
      stderrChunks.push(chunk)
      stderrBytes += chunk.length
    })
    child.on('error', (error) => settle({ kind: isEnoent(error) ? 'missing' : 'failed' }))
    child.on('close', (code) => {
      if (settled) return
      const stdout = Buffer.concat(stdoutChunks)
      wipe()
      const stderr = Buffer.concat(stderrChunks).subarray(0, MAX_STDERR_BYTES).toString('utf8')
      settle({ kind: 'exited', code, stdout, stderr })
    })
  })
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
