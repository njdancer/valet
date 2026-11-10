// Runs a helper binary (op, security) with a bounded wait and bounded output. Spawning and timers
// are injected so tests never start a real 1Password or Keychain prompt.

import { spawn } from 'node:child_process'

/** The part of a ChildProcess this module uses. */
export interface ChildLike {
  /** Present when the spawner was asked for input (SpawnOptions.input). */
  readonly stdin?: {
    end(chunk: Buffer, callback?: () => void): unknown
    on?(event: 'error', listener: (error: Error) => void): unknown
  } | null
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface SpawnOptions {
  /** Open stdin as a pipe, for a secret handed over that way rather than in argv. */
  readonly input?: boolean
}

/** Starts `command` with `args` as argv. Never through a shell. */
export type Spawner = (command: string, args: readonly string[], options?: SpawnOptions) => ChildLike

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

// A helper gets only what it needs to run. Inheriting OP_SERVICE_ACCOUNT_TOKEN, OP_CONNECT_* or
// OP_SESSION_* from a developer's shell would let `op` authenticate some other way than the one a
// grant names. PATH stays for whatever op runs in turn; op itself is always run by absolute path.
const PASSED_THROUGH = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR'] as const

/** The environment helpers run with. LANG=C keeps the stderr phrases the classifiers match stable. */
export function helperEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { LANG: 'C', LC_ALL: 'C' }
  for (const name of PASSED_THROUGH) {
    const value = parent[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

export const nodeSpawner: Spawner = (command, args, options) =>
  spawn(command, [...args], {
    stdio: [options?.input === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
    env: helperEnv(),
  })

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
  /**
   * Written to stdin, which is then closed. The caller owns it and zeroes it once the run settles
   * (not before: the stream may still hold it).
   */
  readonly input?: Buffer
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
      child = options.input === undefined ? spawner(command, args) : spawner(command, args, { input: true })
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
    if (options.input !== undefined) {
      const stdin = child.stdin
      if (stdin === undefined || stdin === null) {
        child.kill('SIGKILL')
        settle({ kind: 'failed' })
        return
      }
      // A helper that exits before reading all of its input closes the pipe (EPIPE); its exit code
      // says what happened, so the write error itself is not the outcome.
      stdin.on?.('error', () => {})
      stdin.end(options.input)
    }
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
