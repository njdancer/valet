// The main-process side of an isolated tool run. The tool's code runs in another process (the app
// uses an Electron utilityProcess) and reaches the page, the session and the person only through
// the capability calls below, each answered by the same guarded ToolContext an in-process tool
// gets. So every guard, budget, redaction and audit rule is unchanged; what's new is that a crash,
// a hang or a memory bomb in tool code ends that process, not the app.
//
// The channel is untrusted: every message is checked to be plain JSON within the size bound before
// it is read, a capability call must name one of CAPABILITIES with JSON arguments, and no more than
// MAX_IN_FLIGHT may wait at once. Anything else ends the run as `tool-run/invalid` and kills the
// process. A process that exits before saying it is done ends the run as `tool-run/internal`.

import { type ToolContext, ValetError } from '@valet/core'
import { dispatchLocal } from './local-dispatch'
import {
  type Capability,
  decodeError,
  encodeError,
  type HostMessage,
  isCapability,
  isPlainJson,
  MAX_IN_FLIGHT,
  withinSize,
} from './protocol'

/** One process running one adapter's tool code, as the runtime sees it. No Electron here. */
export interface ToolChannel {
  send(message: HostMessage): void
  /** Every message the process sends. Untrusted. */
  onMessage(listener: (message: unknown) => void): void
  /** Once, when the process has exited or can no longer be reached. */
  onExit(listener: () => void): void
  /** Ends the process. Safe to call more than once. */
  kill(): void
}

/** Starts a fresh process for one call. */
export type ToolProcessFactory = () => ToolChannel

/**
 * Runs `tool` with `input` in a fresh process from `start`, answering its capability calls from
 * `ctx`. Resolves with the tool's output, or rejects with what it threw (as a ValetError or
 * NeedsUserError where it named one the runtime knows). The process is killed when the run ends,
 * however it ends, and as soon as `ctx.signal` aborts.
 */
export function runIsolated(
  start: ToolProcessFactory,
  script: string,
  ctx: ToolContext,
  tool: string,
  input: unknown,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new ValetError('tool-run', 'aborted'))
      return
    }
    let channel: ToolChannel
    try {
      channel = start()
    } catch {
      reject(new ValetError('tool-run', 'internal'))
      return
    }
    let settled = false
    const inFlight = new Set<number>()
    const finish = (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void => {
      if (settled) return
      settled = true
      ctx.signal.removeEventListener('abort', onAbort)
      channel.kill()
      if (outcome.ok) resolve(outcome.value)
      else reject(outcome.error)
    }
    const onAbort = (): void => {
      // The host stops waiting through its own race; this only makes sure the code stops too.
      send({ t: 'abort' })
      finish({ ok: false, error: new ValetError('tool-run', 'aborted') })
    }
    const violation = (): void => finish({ ok: false, error: new ValetError('tool-run', 'invalid') })
    const url = (): string => {
      try {
        return ctx.page.currentUrl()
      } catch {
        return ''
      }
    }
    const send = (message: HostMessage): void => {
      if (!settled) channel.send(message)
    }

    const answer = async (id: number, capability: Capability, args: readonly unknown[]): Promise<void> => {
      try {
        const value = await dispatch(ctx, capability, args)
        // What a capability returns is the runtime's, but the page's fetch can return anything the
        // site sent; it crosses as JSON or not at all.
        const reply = value === undefined ? null : value
        if (!isPlainJson(reply) || !withinSize(reply)) throw new ValetError('tool-run', 'unexpected-shape')
        send({ t: 'reply', id, ok: true, value: reply, url: url() })
      } catch (error) {
        send({ t: 'reply', id, ok: false, error: encodeError(error), url: url() })
      } finally {
        inFlight.delete(id)
      }
    }

    channel.onExit(() => finish({ ok: false, error: new ValetError('tool-run', 'internal') }))
    channel.onMessage((message) => {
      if (settled) return
      if (!isPlainJson(message) || !withinSize(message)) return violation()
      const m = message as Partial<
        Record<'t' | 'ok' | 'value' | 'error' | 'id' | 'capability' | 'args', unknown>
      >
      if (m.t === 'ready') return
      if (m.t === 'done') {
        if (m.ok === true) return finish({ ok: true, value: m.value })
        return finish({ ok: false, error: decodeError(m.error) })
      }
      if (m.t !== 'call') return violation()
      const { id, capability, args } = m
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || inFlight.has(id)) return violation()
      if (!isCapability(capability) || !Array.isArray(args) || args.length > 3) return violation()
      if (inFlight.size >= MAX_IN_FLIGHT) return violation()
      inFlight.add(id)
      void answer(id, capability, args)
    })
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    send({ t: 'init', script })
    send({ t: 'run', tool, input, url: url() })
  })
}

/** Calls the guarded capability. Its own checks (types, the request surface, C4) apply as in process. */
function dispatch(ctx: ToolContext, capability: Capability, args: readonly unknown[]): Promise<unknown> {
  if (capability.startsWith('local.')) return dispatchLocal(ctx.local, capability, args)
  // Strings where the capability takes a selector, a URL or source text; the guards check the rest.
  const takesString = capability.startsWith('page.')
  if (takesString && typeof args[0] !== 'string') return Promise.reject(new ValetError('tool-run', 'invalid'))
  if (capability === 'page.fill' && typeof args[1] !== 'string') {
    return Promise.reject(new ValetError('tool-run', 'invalid'))
  }
  const [a, b] = args as [never, never]
  switch (capability) {
    case 'page.goto':
      return ctx.page.goto(a)
    case 'page.click':
      return ctx.page.click(a)
    case 'page.fill':
      return ctx.page.fill(a, b)
    case 'page.extract':
      return ctx.page.extract(a, b)
    case 'page.evaluate':
      return ctx.page.evaluate(a, b)
    case 'page.fetch':
      return ctx.page.fetch(a, b)
    case 'session.ensure':
      return ctx.session.ensure()
    case 'confirm':
      return ctx.confirm(a)
    default:
      return Promise.reject(new ValetError('tool-run', 'invalid'))
  }
}

/** How long describe may take, the process's start included. */
export const DESCRIBE_TIMEOUT_MS = 5_000

/**
 * Starts a fresh process from `start`, evaluates `script` and asks it for each tool's schemas as
 * JSON Schema (worker.ts, `describe`). Resolves with what it said, by tool, unchecked beyond plain
 * JSON: the caller bounds it (packages/adapter-store). Rejects if the process says nothing usable,
 * exits or takes longer than `timeoutMs`. Nothing is answered: the script gets no capabilities.
 */
export function describeIsolated(
  start: ToolProcessFactory,
  script: string,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    let channel: ToolChannel
    try {
      channel = start()
    } catch {
      reject(new ValetError('tool-run', 'internal'))
      return
    }
    let settled = false
    const finish = (outcome: { ok: true; value: Record<string, unknown> } | { ok: false }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.kill()
      if (outcome.ok) resolve(outcome.value)
      else reject(new ValetError('tool-run', 'invalid'))
    }
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs)
    channel.onExit(() => finish({ ok: false }))
    channel.onMessage((message) => {
      if (settled) return
      if (!isPlainJson(message) || !withinSize(message)) return finish({ ok: false })
      const m = message as Partial<Record<'t' | 'tools', unknown>>
      if (m.t === 'ready') return
      if (m.t !== 'described' || m.tools === null || typeof m.tools !== 'object' || Array.isArray(m.tools))
        return finish({ ok: false })
      finish({ ok: true, value: m.tools as Record<string, unknown> })
    })
    channel.send({ t: 'init', script })
    channel.send({ t: 'describe' })
  })
}

/**
 * Asks a fresh process whether `tool`'s own input schema accepts `input` (worker.ts, `check`).
 * Resolves true or false; false too if the process says anything else, exits or takes longer than
 * `timeoutMs`. The script gets no capabilities.
 */
export function checkInputIsolated(
  start: ToolProcessFactory,
  script: string,
  tool: string,
  input: unknown,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let channel: ToolChannel
    try {
      channel = start()
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.kill()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    channel.onExit(() => finish(false))
    channel.onMessage((message) => {
      if (settled) return
      if (!isPlainJson(message) || !withinSize(message)) return finish(false)
      const m = message as Partial<Record<'t' | 'ok', unknown>>
      if (m.t === 'ready') return
      finish(m.t === 'checked' && m.ok === true)
    })
    channel.send({ t: 'init', script })
    channel.send({ t: 'check', tool, input })
  })
}
