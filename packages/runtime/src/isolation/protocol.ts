// The messages between the tool host (main process) and the isolated tool process. Everything is
// plain JSON: no functions, no prototypes, no transferables. The host checks every message it gets
// with isPlainJson() before it looks inside, because the other side runs adapter code.
//
// host → process: init (the tool script), run (a tool and its validated input), reply (to a
//   capability call), abort (the call's signal); or init then describe (the tools' schemas).
// process → host: ready, call (a capability: page.*, session.ensure, confirm), done (the tool's
//   result or what it threw), described (the answer to describe).

import {
  ERROR_CLASSES,
  type ErrorClass,
  type InputIssue,
  inputIssue,
  NEEDS_USER_REASONS,
  NeedsUserError,
  type NeedsUserReason,
  STAGES,
  type Stage,
  ValetError,
} from '@valet/core'

/** The capabilities tool code can call across the channel: the whole of ToolContext. */
export const CAPABILITIES = [
  'page.goto',
  'page.click',
  'page.fill',
  'page.extract',
  'page.evaluate',
  'page.fetch',
  'session.ensure',
  'confirm',
  // Sandbox exceptions (docs/sandbox.md): each answered only if the manifest declares its kind.
  'local.files.list',
  'local.files.stat',
  'local.files.read',
  'local.files.write',
  'local.files.mkdir',
  'local.fetch',
  'local.service',
  'local.run',
  'local.appleScript',
  // The egress broker (docs/adapter-kinds.md#ctxhttp): not-granted unless the runtime isn't browser.
  'http.fetch',
  'http.ws.open',
  'http.ws.send',
  'http.ws.receive',
  'http.ws.close',
  // Entrusted credentials (docs/adapter-kinds.md#raw): not-granted unless the runtime is raw.
  'secrets.get',
  // The protocol host (docs/imap.md): one capability, the operation's name and its arguments.
  'imap.op',
  // The SFTP host (docs/sftp.md): likewise, the operation's name and its arguments.
  'sftp.op',
  // Sending mail (workstream G): one message per call of it; GuardedSmtp checks and confirms it.
  'smtp.send',
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** At most this many capability calls may be waiting at once; tool code awaits each one anyway. */
export const MAX_IN_FLIGHT = 16
/** The longest message either side accepts, as JSON text. Site responses come back in replies. */
export const MAX_MESSAGE_CHARS = 4_000_000
const MAX_DEPTH = 64
const MAX_NODES = 200_000

/** How an error crosses the channel: a stage and class, a needsUser reason, or nothing at all. */
export type WireError =
  | {
      readonly kind: 'valet'
      readonly stage: Stage
      readonly errorClass: ErrorClass
      readonly detail?: string
      /** A tool-input refusal's where and why; checked against the vocabulary when decoded. */
      readonly issue?: InputIssue
    }
  | { readonly kind: 'needsUser'; readonly reason: NeedsUserReason }
  /** `detail`, only for a run that asked for it: what the tool threw, in its own words, clipped. */
  | { readonly kind: 'other'; readonly detail?: string }

export type HostMessage =
  | { readonly t: 'init'; readonly script: string }
  | {
      readonly t: 'run'
      readonly tool: string
      readonly input: unknown
      readonly url: string
      /**
       * Asks for a failure's detail on the wire: what a plain thrown error said, or where the
       * output broke its schema. Only for an author's cases, which run on their own fixtures; never
       * for a call or trial on a real site, whose page text could be in it.
       */
      readonly detail?: true
    }
  | {
      readonly t: 'reply'
      readonly id: number
      readonly ok: true
      readonly value: unknown
      readonly url: string
    }
  | {
      readonly t: 'reply'
      readonly id: number
      readonly ok: false
      readonly error: WireError
      readonly url: string
    }
  | { readonly t: 'abort' }
  /** Instead of run: asks for each tool's input and output schemas as JSON Schema. */
  | { readonly t: 'describe' }
  /** Instead of run: asks whether the tool's own input schema accepts `input`. */
  | { readonly t: 'check'; readonly tool: string; readonly input: unknown }

export type ProcessMessage =
  | { readonly t: 'ready' }
  | {
      readonly t: 'call'
      readonly id: number
      readonly capability: Capability
      readonly args: readonly unknown[]
    }
  | { readonly t: 'done'; readonly ok: true; readonly value?: unknown }
  | { readonly t: 'done'; readonly ok: false; readonly error: WireError }
  /**
   * The answer to describe: by tool, its schemas ('missing' where the tool gives none, null where one
   * isn't representable), or null.
   */
  | { readonly t: 'checked'; readonly ok: boolean }
  | { readonly t: 'described'; readonly tools: Readonly<Record<string, DescribedTool | null>> | null }

export interface DescribedTool {
  readonly input: unknown
  readonly output: unknown
}

/**
 * True for JSON-shaped data only: null, booleans, finite numbers, strings, arrays, and objects whose
 * prototype is Object.prototype or null, with no accessors, within a depth and size bound. Anything
 * else (a function, a Map, a Date, a cycle, a getter) is false.
 */
export function isPlainJson(value: unknown): boolean {
  let nodes = 0
  const seen = new Set<object>()
  const walk = (v: unknown, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return false
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true
    if (typeof v === 'number') return Number.isFinite(v)
    if (typeof v !== 'object') return false
    if (seen.has(v)) return false
    seen.add(v)
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) return false
      for (let i = 0; i < v.length; i++) if (!walk(v[i], depth + 1)) return false
      return true
    }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return false
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(v, key)
      if (descriptor === undefined || !('value' in descriptor)) return false
      if (!walk(descriptor.value, depth + 1)) return false
    }
    seen.delete(v)
    return true
  }
  return walk(value, 0)
}

/** Within MAX_MESSAGE_CHARS once written as JSON. Call only on a value isPlainJson() accepted. */
export function withinSize(value: unknown): boolean {
  return JSON.stringify(value).length <= MAX_MESSAGE_CHARS
}

export function encodeError(error: unknown): WireError {
  if (error instanceof ValetError) {
    const wire = { kind: 'valet', stage: error.stage, errorClass: error.errorClass } as const
    return error.issue === undefined ? wire : { ...wire, issue: error.issue }
  }
  if (error instanceof NeedsUserError) return { kind: 'needsUser', reason: error.reason }
  return { kind: 'other' }
}

/**
 * What the other side said was thrown, as an error the runtime knows, checked against the fixed
 * vocabularies. Anything unrecognised is a plain Error, which reports as internal.
 */
export function decodeError(wire: unknown, withDetail = false): Error {
  let error: Error = new Error('tool code failed')
  let detail: unknown
  if (wire !== null && typeof wire === 'object') {
    const w = wire as Partial<
      Record<'kind' | 'stage' | 'errorClass' | 'reason' | 'detail' | 'issue', unknown>
    >
    if (w.kind === 'valet' && isStage(w.stage) && isErrorClass(w.errorClass)) {
      // ValetError keeps an issue for tool-input only, and only the parts the vocabulary allows.
      error = new ValetError(w.stage, w.errorClass, inputIssue(w.issue))
    } else if (w.kind === 'needsUser' && isReason(w.reason)) {
      return new NeedsUserError(w.reason)
    }
    detail = w.detail
  }
  if (withDetail && typeof detail === 'string' && detail !== '')
    details.set(error, detail.slice(0, MAX_DETAIL))
  return error
}

/** The most of a failure's detail kept. */
export const MAX_DETAIL = 300
const details = new WeakMap<object, string>()

/**
 * What tool code's failure said, for a run that asked for it (runIsolated's `detail`): a plain
 * error's own message, or where the output broke its schema. Null otherwise.
 */
export function failureDetail(error: unknown): string | null {
  return typeof error === 'object' && error !== null ? (details.get(error) ?? null) : null
}

const isStage = (v: unknown): v is Stage => STAGES.some((s) => s === v)
const isErrorClass = (v: unknown): v is ErrorClass => ERROR_CLASSES.some((c) => c === v)
const isReason = (v: unknown): v is NeedsUserReason => NEEDS_USER_REASONS.some((r) => r === v)
export const isCapability = (v: unknown): v is Capability => CAPABILITIES.some((c) => c === v)
