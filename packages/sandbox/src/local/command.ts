// `ctx.local.run` (a `command` exception), enforced in the main process. The declared program only,
// with no shell, its real path checked again before every run (still not a shell or interpreter,
// still not somewhere the person can write), an empty environment, a fresh empty working folder,
// and time and output caps. Critical and Mac only on the card, whatever it names.
//
// A program is as broad as what it does with its arguments (`/bin/cp` reads anything), so it runs
// under a Seatbelt profile (commandProfile): no network, no Apple Events, no launching or opening
// anything, no exec but the program itself, writes only in its working folder, and no reads or
// writes of the never-grantable places (FORBIDDEN_PATHS under the home). macOS only: elsewhere
// `run` is unavailable.

import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FORBIDDEN_PATHS, isForbiddenCommand, type LocalRunResult, ValetError } from '@valet/core'

export const RUN_TIMEOUT_MS = 60_000
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_ARGS = 100
const MAX_ARG_CHARS = 4_000
const USER_WRITABLE = /^\/(users|volumes|tmp|private|var|opt\/homebrew|home)\//i

const fail = (errorClass: 'not-granted' | 'denied-path' | 'invalid' | 'unavailable' | 'condition-timeout') =>
  new ValetError('tool-run', errorClass)

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** A Seatbelt string literal. Paths come from the manifest and the home folder, so quote them. */
const literal = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * The Seatbelt profile a declared program runs under. `forbidden` is every never-grantable place,
 * absolute, in each form it may be reached by (as named, and resolved).
 */
export function commandProfile(program: string, workdir: string, forbidden: readonly string[]): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny appleevent-send)',
    '(deny process-exec)',
    `(allow process-exec (literal ${literal(program)}))`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${literal(workdir)}) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))`,
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents") (global-name-regex #"^com\\.apple\\.pasteboard"))',
  ]
  if (forbidden.length > 0)
    lines.push(`(deny file-read* file-write* ${forbidden.map((f) => `(subpath ${literal(f)})`).join(' ')})`)
  return lines.join('\n')
}

/** The home's never-grantable places, absolute (the system folders aren't: programs need them). */
export async function forbiddenUnderHome(home: string): Promise<string[]> {
  const out = new Set<string>()
  for (const f of FORBIDDEN_PATHS) {
    if (!f.startsWith('~/')) continue
    const named = `${home.replace(/\/+$/, '')}/${f.slice(2)}`
    out.add(named)
    out.add(await realpath(named).catch(() => named))
  }
  return [...out]
}

export interface CommandOptions {
  /** Declared programs, or 'open' (unsandboxed: any program that isn't forbidden). */
  readonly programs: readonly string[] | 'open'
  readonly home: string
  readonly timeoutMs?: number
  /** Tests only: where a program may live that the real rule would call user-writable. */
  readonly allowUserWritable?: boolean
  /** Tests only, off macOS: run without Seatbelt. The app never sets it. */
  readonly withoutSeatbelt?: boolean
  readonly platform?: NodeJS.Platform
}

export function localRun(options: CommandOptions) {
  return async (argsValue: unknown, optionsValue?: unknown): Promise<LocalRunResult> => {
    if (options.programs !== 'open' && options.programs.length === 0) throw fail('not-granted')
    if (!Array.isArray(argsValue) || argsValue.length > MAX_ARGS) throw fail('invalid')
    const args: string[] = []
    for (const a of argsValue) {
      if (typeof a !== 'string' || a.length > MAX_ARG_CHARS || a.includes('\0')) throw fail('invalid')
      args.push(a)
    }
    if (optionsValue !== undefined && (optionsValue === null || typeof optionsValue !== 'object'))
      throw fail('invalid')
    const o = (optionsValue ?? {}) as { program?: unknown; stdin?: unknown }
    if (o.stdin !== undefined && (typeof o.stdin !== 'string' || o.stdin.length > MAX_OUTPUT_BYTES))
      throw fail('invalid')
    let program: string
    if (o.program === undefined) {
      if (options.programs === 'open' || options.programs[0] === undefined) throw fail('invalid')
      program = options.programs[0]
    } else {
      if (typeof o.program !== 'string') throw fail('invalid')
      if (options.programs !== 'open' && !options.programs.includes(o.program)) throw fail('not-granted')
      if (!o.program.startsWith('/')) throw fail('invalid')
      program = o.program
    }
    // Checked again now: the program at that path, or a link it became, may not be what was approved.
    const real = await realpath(program).catch(() => {
      throw fail('unavailable')
    })
    if (isForbiddenCommand(real) || isForbiddenCommand(program)) throw fail('denied-path')
    if (!options.allowUserWritable && (USER_WRITABLE.test(real) || USER_WRITABLE.test(program)))
      throw fail('denied-path')
    const seatbelt = !options.withoutSeatbelt
    if (seatbelt && (options.platform ?? process.platform) !== 'darwin') throw fail('unavailable')
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'valet-run-')))
    const file = seatbelt ? SANDBOX_EXEC : real
    const argv = seatbelt
      ? ['-p', commandProfile(real, cwd, await forbiddenUnderHome(options.home)), real, ...args]
      : args
    try {
      return await new Promise<LocalRunResult>((resolve, reject) => {
        const child = execFile(
          file,
          argv,
          {
            cwd,
            env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
            shell: false,
            timeout: options.timeoutMs ?? RUN_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            if (error !== null) {
              const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown }
              if (e.killed) return reject(fail('condition-timeout'))
              if (typeof e.code === 'number') return resolve({ exitCode: e.code, stdout, stderr })
              if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(fail('invalid'))
              return reject(fail('unavailable'))
            }
            resolve({ exitCode: 0, stdout, stderr })
          },
        )
        if (o.stdin !== undefined) child.stdin?.end(o.stdin)
        else child.stdin?.end()
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }
}
