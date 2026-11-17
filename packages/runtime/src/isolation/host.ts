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

import {
  type HttpSocket,
  type InputIssue,
  isOperation,
  issueFromZod,
  MAX_SOCKETS_PER_CALL,
  type ToolContext,
  ValetError,
} from '@valet/core'
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
  /**
   * `detail`: keep what tool code's failure said, for failureDetail. Only for an author's cases on
   * their own fixtures: a real site's page text or a session value could be in it.
   */
  options: { readonly detail?: boolean } = {},
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
    const sockets = new SocketTable()
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
        const value = await dispatch(ctx, capability, args, sockets)
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
        return finish({ ok: false, error: decodeError(m.error, options.detail === true) })
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
    send({ t: 'run', tool, input, url: url(), ...(options.detail === true ? { detail: true as const } : {}) })
  })
}

/** Calls the guarded capability. Its own checks (types, the request surface, C4) apply as in process. */
function dispatch(
  ctx: ToolContext,
  capability: Capability,
  args: readonly unknown[],
  sockets: SocketTable,
): Promise<unknown> {
  if (capability.startsWith('local.')) return dispatchLocal(ctx.local, capability, args)
  if (capability.startsWith('http.')) return dispatchHttp(ctx, capability, args, sockets)
  if (capability === 'imap.op') return dispatchImap(ctx, args)
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
    case 'secrets.get':
      if (typeof args[0] !== 'string' || args.length !== 1)
        return Promise.reject(new ValetError('tool-run', 'invalid'))
      if (ctx.secrets === undefined) return Promise.reject(new ValetError('tool-run', 'not-granted'))
      return ctx.secrets.get(a)
    default:
      return Promise.reject(new ValetError('tool-run', 'invalid'))
  }
}

/**
 * The sockets one isolated run opened, by the small ids tool code holds for them. An id is never
 * reused within the run, and one the run didn't get from open is refused.
 */
class SocketTable {
  private next = 1
  private readonly open = new Map<number, HttpSocket>()
  /** Opens under way: counted before their first await, so concurrent opens can't pass the cap. */
  opening = 0

  add(socket: HttpSocket): number {
    const id = this.next++
    this.open.set(id, socket)
    return id
  }

  /**
   * An open socket. One this call opened and has since closed (by close, or the far end) is
   * unavailable, as GuardedHttp says of a closed socket; an id it never had is invalid.
   */
  get(id: unknown): HttpSocket {
    const socket = typeof id === 'number' ? this.open.get(id) : undefined
    if (socket !== undefined) return socket
    if (this.issued(id)) throw new ValetError('egress', 'unavailable')
    throw new ValetError('tool-run', 'invalid')
  }

  /** An id this table handed out, open or closed since. */
  issued(id: unknown): id is number {
    return typeof id === 'number' && Number.isInteger(id) && id >= 1 && id < this.next
  }

  delete(id: number): void {
    this.open.delete(id)
  }

  has(id: number): boolean {
    return this.open.has(id)
  }

  get size(): number {
    return this.open.size + this.opening
  }
}

/** `imap.op`: the operation's name and its argument list; GuardedImap checks both. */
function dispatchImap(ctx: ToolContext, args: readonly unknown[]): Promise<unknown> {
  const imap = ctx.imap
  if (imap === undefined) return Promise.reject(new ValetError('tool-run', 'not-granted'))
  const [name, list] = args
  if (!isOperation(name) || !Array.isArray(list) || list.length > 4) {
    return Promise.reject(new ValetError('tool-run', 'invalid'))
  }
  const method = imap[name] as (...a: unknown[]) => Promise<unknown>
  return method.apply(imap, list)
}

async function dispatchHttp(
  ctx: ToolContext,
  capability: Capability,
  args: readonly unknown[],
  sockets: SocketTable,
): Promise<unknown> {
  const http = ctx.http
  if (http === undefined) throw new ValetError('tool-run', 'not-granted')
  const [a, b, c] = args as [never, never, never]
  switch (capability) {
    case 'http.fetch':
      if (typeof args[0] !== 'string') throw new ValetError('tool-run', 'invalid')
      return http.fetch(a, b)
    case 'http.ws.open': {
      if (typeof args[0] !== 'string') throw new ValetError('tool-run', 'invalid')
      // The guard counts what is open; this only keeps the table from growing past it.
      if (sockets.size >= MAX_SOCKETS_PER_CALL) throw new ValetError('request-surface', 'request-ceiling')
      sockets.opening++
      let socket: HttpSocket
      try {
        socket = await http.websocket(a, b)
      } finally {
        sockets.opening--
      }
      return { id: sockets.add(socket) }
    }
    case 'http.ws.send':
      return sockets.get(args[0]).send(b, c)
    case 'http.ws.receive': {
      const message = await sockets.get(args[0]).receive(b)
      if (message?.kind === 'closed') sockets.delete(args[0] as number)
      return message
    }
    case 'http.ws.close':
      // Closing a socket that has closed already (the far end closed it, say) does nothing, as
      // closing one twice does in every client; tool code's `finally { close() }` relies on it.
      if (sockets.issued(args[0]) && !sockets.has(args[0])) return null
      await sockets.get(args[0]).close()
      sockets.delete(args[0] as number)
      return null
    default:
      throw new ValetError('tool-run', 'invalid')
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

/** What a tool's own input schema said: accepted, or refused with where and why when it said. */
export type InputCheck = { readonly ok: true } | { readonly ok: false; readonly issue?: InputIssue }

/**
 * Asks a fresh process whether `tool`'s own input schema accepts `input` (worker.ts, `check`).
 * Resolves accepted or refused; refused too if the process says anything else, exits or takes
 * longer than `timeoutMs`. A refusal's first zod issue, as the process reports it, is mapped here
 * to codes (issueFromZod), so nothing it says travels on as text. The script gets no capabilities.
 */
export function checkInputIsolated(
  start: ToolProcessFactory,
  script: string,
  tool: string,
  input: unknown,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
): Promise<InputCheck> {
  return new Promise((resolve) => {
    let channel: ToolChannel
    try {
      channel = start()
    } catch {
      resolve({ ok: false })
      return
    }
    let settled = false
    const finish = (check: InputCheck): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.kill()
      resolve(check)
    }
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs)
    channel.onExit(() => finish({ ok: false }))
    channel.onMessage((message) => {
      if (settled) return
      if (!isPlainJson(message) || !withinSize(message)) return finish({ ok: false })
      const m = message as Partial<Record<'t' | 'ok' | 'issue', unknown>>
      if (m.t === 'ready') return
      if (m.t === 'checked' && m.ok === true) return finish({ ok: true })
      if (m.t !== 'checked' || m.issue === undefined) return finish({ ok: false })
      finish({ ok: false, issue: issueFromZod(m.issue, input) })
    })
    channel.send({ t: 'init', script })
    channel.send({ t: 'check', tool, input })
  })
}
