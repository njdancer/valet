// The messages between the tool host (main process) and the isolated tool process. Everything is
// plain JSON: no functions, no prototypes, no transferables. The host checks every message it gets
// with isPlainJson() before it looks inside, because the other side runs adapter code.
//
// host → process: init (the tool script), run (a tool and its validated input), reply (to a
//   capability call), abort (the call's signal).
// process → host: ready, call (a capability: page.*, session.ensure, confirm), done (the tool's
//   result or what it threw).

import {
  ERROR_CLASSES,
  type ErrorClass,
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
  | { readonly kind: 'valet'; readonly stage: Stage; readonly errorClass: ErrorClass }
  | { readonly kind: 'needsUser'; readonly reason: NeedsUserReason }
  | { readonly kind: 'other' }

export type HostMessage =
  | { readonly t: 'init'; readonly script: string }
  | { readonly t: 'run'; readonly tool: string; readonly input: unknown; readonly url: string }
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
  if (error instanceof ValetError) return { kind: 'valet', stage: error.stage, errorClass: error.errorClass }
  if (error instanceof NeedsUserError) return { kind: 'needsUser', reason: error.reason }
  return { kind: 'other' }
}

/**
 * What the other side said was thrown, as an error the runtime knows, checked against the fixed
 * vocabularies. Anything unrecognised is a plain Error, which reports as internal.
 */
export function decodeError(wire: unknown): Error {
  if (wire !== null && typeof wire === 'object') {
    const w = wire as Partial<Record<'kind' | 'stage' | 'errorClass' | 'reason', unknown>>
    if (w.kind === 'valet' && isStage(w.stage) && isErrorClass(w.errorClass)) {
      return new ValetError(w.stage, w.errorClass)
    }
    if (w.kind === 'needsUser' && isReason(w.reason)) return new NeedsUserError(w.reason)
  }
  return new Error('tool code failed')
}

const isStage = (v: unknown): v is Stage => STAGES.some((s) => s === v)
const isErrorClass = (v: unknown): v is ErrorClass => ERROR_CLASSES.some((c) => c === v)
const isReason = (v: unknown): v is NeedsUserReason => NEEDS_USER_REASONS.some((r) => r === v)
export const isCapability = (v: unknown): v is Capability => CAPABILITIES.some((c) => c === v)
