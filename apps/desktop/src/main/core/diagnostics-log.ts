// The app's own diagnostics log: what a menu-bar app with no terminal would otherwise say to nobody.
// The audit log records what was done for whom; this records why the app itself misbehaved (a
// crash, a renderer or tool process that died, an audit write that failed), so a bad day in real use
// can be explained afterwards.
//
// It is plain text on disk, so it holds to the same rule as everything else the app keeps: nothing
// that could be page text or a secret. Callers pass fixed text and codes. An error is recorded by
// its name, its code and the frames of its stack, never by its message: messages can quote a page,
// a URL or a path the person chose.
//
// Writes are synchronous on purpose. A line about a crash must be on disk before the process exits,
// and the volume is a few lines a day.

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** A line longer than this is cut. */
export const MAX_LINE_LENGTH = 400
/** At this size the file becomes `<name>.1`, replacing the one before: at most two files are kept. */
export const MAX_LOG_BYTES = 1024 * 1024
/** Stack frames kept for one error. */
export const MAX_FRAMES = 12

/** The file operations the log needs, so tests can make them fail. */
export interface LogFiles {
  mkdir(dir: string): void
  size(path: string): number | null
  rename(from: string, to: string): void
  append(path: string, text: string): void
}

/* v8 ignore start -- the real file system; the app's smoke test and e2e suite run it */
export const realLogFiles: LogFiles = {
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  },
  size: (path) => {
    try {
      return statSync(path).size
    } catch {
      return null
    }
  },
  rename: (from, to) => renameSync(from, to),
  append: (path, text) => {
    appendFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  },
}
/* v8 ignore stop */

export interface DiagnosticsLogOptions {
  readonly path: string
  readonly now: () => number
  readonly files?: LogFiles
  readonly maxBytes?: number
}

export interface DiagnosticsLog {
  readonly path: string
  /** Appends one line. Never throws: a log that can't be written must not take the app down. */
  write(line: string): void
  /** Appends `what`, then the error's name, code and stack frames. Never its message. */
  writeError(what: string, error: unknown): void
}

export function createDiagnosticsLog(options: DiagnosticsLogOptions): DiagnosticsLog {
  const files = options.files ?? realLogFiles
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES
  let ready = false

  const append = (lines: readonly string[]): void => {
    try {
      if (!ready) {
        files.mkdir(dirname(options.path))
        ready = true
      }
      const size = files.size(options.path)
      if (size !== null && size >= maxBytes) files.rename(options.path, `${options.path}.1`)
      const stamp = new Date(options.now()).toISOString()
      files.append(options.path, lines.map((line) => `${stamp} ${flatten(line)}\n`).join(''))
    } catch {
      // Nowhere left to say so.
    }
  }

  return {
    path: options.path,
    write: (line) => append([line]),
    writeError: (what, error) => append([what, ...describeError(error)]),
  }
}

/** One line: control and format characters out (a newline would forge an entry), length capped. */
export function flatten(line: string): string {
  return line
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .trim()
    .slice(0, MAX_LINE_LENGTH)
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
/** A V8 frame: "at fn (file:line:col)" or "at file:line:col". */
const FRAME = /^\s*at .+:\d+:\d+\)?$/

/**
 * An error as lines safe to keep: its name and code when they look like identifiers, and its stack
 * frames. The message is never included. A stack repeats the message before its frames, so only
 * what follows the message is read, and of that only lines shaped like frames: a message with a
 * line of its own that looks like a frame is still left out. A stack that doesn't hold the message
 * (someone assigned one or the other) gives no frames at all.
 */
export function describeError(error: unknown): string[] {
  if (!(error instanceof Error)) return [`  thrown: ${typeof error}`]
  const name = ERROR_NAME.test(error.name) ? error.name : 'Error'
  const code = (error as { code?: unknown }).code
  const head = typeof code === 'string' && ERROR_CODE.test(code) ? `  ${name} (${code})` : `  ${name}`
  return [head, ...framesOf(error)]
}

function framesOf(error: Error): string[] {
  const { stack, message } = error
  if (typeof stack !== 'string' || typeof message !== 'string') return []
  const at = stack.indexOf(message)
  if (at < 0) return []
  return stack
    .slice(at + message.length)
    .split('\n')
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => `    ${line.trim()}`)
}

/** What happened to a process the app started, from Electron's own fixed vocabulary. */
export function processGoneLine(kind: string, reason: string, exitCode: number): string {
  const word = (value: string): string => (/^[A-Za-z][A-Za-z0-9 -]{0,39}$/.test(value) ? value : 'unknown')
  return `process gone: ${word(kind)} (${word(reason)}, exit ${Number.isInteger(exitCode) ? exitCode : 'unknown'})`
}

/**
 * What to do after an exception nothing caught. The process's state can't be trusted, so it never
 * carries on. A packaged app that had been up for a while starts again, once: a crash at or soon
 * after start would only crash again, and a loop of restarts is worse than a stopped app.
 */
export function afterCrash(state: { packaged: boolean; uptimeMs: number }): 'relaunch' | 'exit' {
  return state.packaged && state.uptimeMs >= MIN_UPTIME_TO_RELAUNCH_MS ? 'relaunch' : 'exit'
}

export const MIN_UPTIME_TO_RELAUNCH_MS = 60_000
