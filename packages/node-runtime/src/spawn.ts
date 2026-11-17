// Starts a `raw` adapter's Node process (docs/node-runtime.md): the separately signed Node binary,
// under the adapter's Seatbelt profile, with Node's permission model on as well, an empty
// environment, a throwaway home, a heap cap and a lifetime cap. One process per tool call, like the
// other isolated runtimes, so nothing outlives a call or carries over to the next one. It returns a
// ToolProcessFactory, so runIsolated, describeIsolated and checkInputIsolated in @valet/runtime drive
// it exactly as they drive the `vm` and QuickJS processes.
//
// macOS only. Without sandbox-exec the runtime is unavailable, never unconfined. Tests off macOS may
// pass `withoutSeatbelt`, which the app never does.

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORBIDDEN_PATHS, touchesForbiddenPath, ValetError } from '@valet/core'
import type { HostMessage, ToolChannel, ToolProcessFactory } from '@valet/runtime'
import { BOOTSTRAP } from '@valet/runtime/bootstrap'
import { MAX_MESSAGE_CHARS } from '@valet/runtime/protocol'
import { nodeRuntimeProfile } from './profile'
import { type Endpoint, type OpenTunnels, parseEndpoint, type TunnelSet } from './tunnels'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** The host script every process runs. */
export const HOST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'host', 'runtime-host.cjs')

export const DEFAULT_HEAP_MB = 256
/** A backstop: the tool host's own deadline normally ends a call long before this. */
export const DEFAULT_MAX_LIFETIME_MS = 10 * 60_000
/** What is kept of the process's stderr, for diagnostics. Its stdout goes nowhere. */
export const MAX_STDERR_CHARS = 16_000
/** A line from the process longer than this ends it (the host would refuse the message anyway). */
export const MAX_LINE_CHARS = MAX_MESSAGE_CHARS + 1_000

export interface NodeRuntimeOptions {
  /** The runtime's Node binary: never Electron run as Node. */
  readonly nodeBinary: string
  /** The adapter's endpoints, `host:port`. Each gets a tunnel; nothing else is reachable. */
  readonly endpoints: readonly Endpoint[]
  readonly openTunnels: OpenTunnels
  /** The person's home folder, for the never-grantable places under it. */
  readonly home: string
  /** Declared read paths, absolute (`~` already expanded). */
  readonly readPaths?: readonly string[]
  /** Declared read-write paths, absolute. */
  readonly readWritePaths?: readonly string[]
  /** More places to deny whatever else allows them (Valet's own data folder, say). */
  readonly alsoForbidden?: readonly string[]
  readonly heapMb?: number
  readonly maxLifetimeMs?: number
  /** Where the process's stderr goes, capped. */
  readonly onStderr?: (text: string) => void
  /** Called once per process with the profile it ran under (tests and diagnostics). */
  readonly onProfile?: (profile: string) => void
  /** Tests only, off macOS: run without Seatbelt. The app never sets it. */
  readonly withoutSeatbelt?: boolean
  readonly platform?: NodeJS.Platform
  /** Tests only: a host script of their own. */
  readonly hostScript?: string
  /** Tests only: leave Node's permission model off, to probe the profile alone. */
  readonly withoutNodePermission?: boolean
}

/** The never-grantable places under the home, absolute, as named and resolved. */
export async function forbiddenUnderHome(home: string): Promise<string[]> {
  const out = new Set<string>()
  const base = home.replace(/\/+$/, '')
  for (const f of FORBIDDEN_PATHS) {
    if (!f.startsWith('~/')) continue
    const named = `${base}/${f.slice(2)}`
    out.add(named)
    out.add(await realpath(named).catch(() => named))
  }
  return [...out]
}

/** Resolves a declared path, refusing one that is, or resolves into, a never-grantable place. */
async function resolveDeclared(path: string, home: string): Promise<string> {
  if (!path.startsWith('/') || touchesForbiddenPath(path, home))
    throw new ValetError('tool-run', 'denied-path')
  const real = await realpath(path).catch(() => {
    throw new ValetError('tool-run', 'unavailable')
  })
  if (touchesForbiddenPath(real, home)) throw new ValetError('tool-run', 'denied-path')
  return real
}

/** The arguments Node runs with. Exported for the tests that check them. */
export function nodeArguments(input: {
  readonly hostScript: string
  readonly tempDir: string
  readonly readPaths: readonly string[]
  readonly readWritePaths: readonly string[]
  readonly heapMb: number
  readonly permission?: boolean
}): string[] {
  // Node's own permission model, inside the profile: no child processes, workers, addons, WASI or
  // inspector, and files only where the profile allows them too.
  const permission =
    input.permission === false
      ? []
      : [
          '--permission',
          ...[input.hostScript, input.tempDir, ...input.readPaths, ...input.readWritePaths].map(
            (p) => `--allow-fs-read=${p}`,
          ),
          ...[input.tempDir, ...input.readWritePaths].map((p) => `--allow-fs-write=${p}`),
        ]
  return [
    ...permission,
    '--no-addons',
    `--max-old-space-size=${input.heapMb}`,
    '--disable-warning=ExperimentalWarning',
    '--no-deprecation',
    input.hostScript,
  ]
}

/**
 * A factory for one adapter's processes. Each call of it starts a process for one tool call; the
 * channel it returns queues what is sent until the process is up.
 */
export function nodeRuntimeProcess(options: NodeRuntimeOptions): ToolProcessFactory {
  const endpoints = options.endpoints.map(parseEndpoint)
  if (process.versions['electron'] !== undefined && options.nodeBinary === process.execPath)
    throw new ValetError('tool-run', 'unavailable')
  return (): ToolChannel => {
    const listeners: ((message: unknown) => void)[] = []
    const exits: (() => void)[] = []
    const queue: string[] = []
    let child: ChildProcess | null = null
    let killed = false
    let exited = false
    let tempDir: string | null = null
    let tunnels: TunnelSet | null = null
    let lifetime: NodeJS.Timeout | null = null

    const cleanUp = (): void => {
      if (lifetime !== null) clearTimeout(lifetime)
      tunnels?.close()
      tunnels = null
      if (tempDir !== null) {
        const dir = tempDir
        tempDir = null
        void rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    const exit = (): void => {
      if (exited) return
      exited = true
      killed = true
      try {
        child?.kill('SIGKILL')
      } catch {}
      cleanUp()
      for (const listener of exits.splice(0)) listener()
    }
    const write = (line: string): void => {
      const pipe = child?.stdio[3] as NodeJS.WritableStream | undefined
      if (pipe === undefined || exited) return
      try {
        pipe.write(line)
      } catch {
        exit()
      }
    }

    const start = async (): Promise<void> => {
      const seatbelt = !options.withoutSeatbelt
      if (seatbelt && ((options.platform ?? process.platform) !== 'darwin' || !existsSync(SANDBOX_EXEC)))
        throw new ValetError('tool-run', 'unavailable')
      const home = await realpath(options.home).catch(() => options.home)
      const readPaths = await Promise.all(
        (options.readPaths ?? []).map((p) => resolveDeclared(p, options.home)),
      )
      const readWritePaths = await Promise.all(
        (options.readWritePaths ?? []).map((p) => resolveDeclared(p, options.home)),
      )
      const nodeBinary = await realpath(options.nodeBinary)
      const hostScript = await realpath(options.hostScript ?? HOST_SCRIPT)
      tempDir = await realpath(await mkdtemp(join(tmpdir(), 'valet-node-')))
      if (killed) return
      tunnels = await options.openTunnels(endpoints.map((e) => e.key))
      if (killed) return
      const tunnelMap: Record<string, number> = {}
      for (const e of endpoints) {
        const port = tunnels.ports.get(e.key)
        if (port === undefined) throw new ValetError('tool-run', 'unavailable')
        tunnelMap[e.key] = port
      }
      const forbidden = [
        ...(await forbiddenUnderHome(home)),
        ...(home === options.home ? [] : await forbiddenUnderHome(options.home)),
        ...(await Promise.all((options.alsoForbidden ?? []).map((p) => realpath(p).catch(() => p)))),
      ]
      const args = nodeArguments({
        hostScript,
        tempDir,
        readPaths,
        readWritePaths,
        heapMb: options.heapMb ?? DEFAULT_HEAP_MB,
        permission: !options.withoutNodePermission,
      })
      const profile = nodeRuntimeProfile({
        nodeBinary,
        hostScript,
        tempDir,
        readPaths,
        readWritePaths,
        tunnelPorts: Object.values(tunnelMap),
        forbidden,
      })
      options.onProfile?.(profile)
      const file = seatbelt ? SANDBOX_EXEC : nodeBinary
      const argv = seatbelt ? ['-p', profile, nodeBinary, ...args] : args
      const proc = spawn(file, argv, {
        cwd: tempDir,
        env: { HOME: tempDir, TMPDIR: `${tempDir}/`, LANG: 'en_US.UTF-8' },
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      })
      child = proc
      lifetime = setTimeout(exit, options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS)
      proc.once('close', exit)
      proc.once('error', exit)
      let stderr = 0
      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (text: string) => {
        if (stderr >= MAX_STDERR_CHARS) return
        const kept = text.slice(0, MAX_STDERR_CHARS - stderr)
        stderr += kept.length
        options.onStderr?.(kept)
      })
      const pipe = proc.stdio[3] as unknown as NodeJS.ReadableStream & NodeJS.WritableStream
      pipe.on('error', exit)
      let buffer = ''
      pipe.setEncoding('utf8')
      pipe.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line.length > MAX_LINE_CHARS) return exit()
          let message: unknown
          try {
            message = JSON.parse(line)
          } catch {
            // Not JSON: the host's checks would refuse it; say so the same way.
            message = { t: 'garbled' }
          }
          for (const listener of listeners) listener(message)
          if (exited) return
          index = buffer.indexOf('\n')
        }
        if (buffer.length > MAX_LINE_CHARS) exit()
      })
      write(`${JSON.stringify({ t: 'boot', bootstrap: BOOTSTRAP, tunnels: tunnelMap })}\n`)
      for (const line of queue.splice(0)) write(line)
    }

    start().catch((error: unknown) => {
      if (error instanceof ValetError) options.onStderr?.(`valet: ${error.stage}/${error.errorClass}\n`)
      else options.onStderr?.(`valet: the runtime could not start: ${String(error).slice(0, 300)}\n`)
      exit()
    })

    return {
      send: (message: HostMessage) => {
        if (exited) return
        const line = `${JSON.stringify(message)}\n`
        if (child === null) queue.push(line)
        else write(line)
      },
      onMessage: (listener) => {
        listeners.push(listener)
      },
      onExit: (listener) => {
        if (exited) listener()
        else exits.push(listener)
      },
      kill: exit,
    }
  }
}
