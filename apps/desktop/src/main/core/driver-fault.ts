// What the browser driver threw, in a form safe to keep: for the diagnostics log on disk and for a
// call's trace (valet_get_call's fault). Page text and secrets never reach either, so an error is
// kept by its name, its code and the fixed step it failed at. Its message only when it is shaped
// like the browser's own fixed wording ("Render frame was disposed before WebFrameMain could be
// accessed", "No target with given id found"): no addresses, paths, quotes or digits beyond a few.

import { faultOf } from '@valet/core'
import type { CallFault } from '../../shared/api'
import { describeError } from './diagnostics-log'

/** Plain words and light punctuation, short; nothing a URL, a path, a quote or a value needs. */
const SAFE_MESSAGE = /^[A-Za-z][A-Za-z ,.;:()'-]{0,159}$/

/** The message when it reads as the browser's own fixed wording, otherwise null. */
export function safeMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  return SAFE_MESSAGE.test(trimmed) ? trimmed : null
}

const NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const STEP = /^[a-z][a-z-]{0,39}$/

function nameOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  return NAME.test(error.name) ? error.name : 'Error'
}

/**
 * A call's fault: where in the call the driver failed, the driver's own step when it named one,
 * and what was really thrown there (by name, and its message only when safeMessage keeps it).
 */
export function callFault(callStep: string, error: unknown): CallFault {
  const fault = faultOf(error)
  const cause = fault === undefined ? error : fault.cause
  return {
    step: STEP.test(callStep) ? callStep : 'unknown',
    at: fault !== undefined && STEP.test(fault.step) ? fault.step : null,
    error: nameOf(cause),
    message: cause instanceof Error ? safeMessage(cause.message) : null,
  }
}

/** Log lines for a fault: the call's fault, then the cause's name, code and stack frames. */
export function faultLines(head: string, callStep: string, error: unknown): string[] {
  const fault = callFault(callStep, error)
  const cause = faultOf(error)?.cause ?? error
  const where = fault.at === null ? fault.step : `${fault.step} at ${fault.at}`
  const what = fault.message === null ? fault.error : `${fault.error}: ${fault.message}`
  return [`${head} (${where}): ${what}`, ...describeError(cause).slice(1)]
}

/** A word from a fixed vocabulary, or "unknown": these go into the log as they are. */
function word(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(value) ? value : 'unknown'
}

/** The fields diagnosticLines reads; any diagnostic the app hears fits it. */
interface DiagnosticView {
  readonly type: string
  readonly adapterId?: unknown
  readonly callId?: unknown
  readonly step?: unknown
  readonly error?: unknown
  readonly diagnostic?: unknown
}

interface DriverView {
  readonly type?: unknown
  readonly role?: unknown
  readonly reason?: unknown
  readonly exitCode?: unknown
  readonly step?: unknown
  readonly error?: unknown
}

/** What a diagnostic says, as log lines: fixed words, an adapter id, and a fault's safe lines. */
export function diagnosticLines(diagnostic: DiagnosticView): string[] {
  const { type } = diagnostic
  const adapter = word(diagnostic.adapterId)
  if (type === 'driver-failed') {
    return faultLines(`diagnostic: driver-failed ${adapter}`, word(diagnostic.step), diagnostic.error)
  }
  if (type === 'browser') {
    const inner: DriverView =
      typeof diagnostic.diagnostic === 'object' && diagnostic.diagnostic !== null ? diagnostic.diagnostic : {}
    const role = word(inner.role)
    if (inner.type === 'renderer-gone') {
      const exit = Number.isInteger(inner.exitCode) ? String(inner.exitCode) : 'unknown'
      return [
        `diagnostic: ${adapter} ${role} page renderer gone (${word(inner.reason)}, exit ${exit}); its window was closed`,
      ]
    }
    if (inner.type === 'setup-failed') {
      return faultLines(`diagnostic: ${adapter} ${role} set-up failed`, word(inner.step), inner.error)
    }
    return [`diagnostic: ${adapter} browser ${word(inner.type)}`]
  }
  // Every other diagnostic is the app's own fixed text (some, such as "[blind relay] online", a
  // whole line), logged as it always was; the log flattens and caps each line.
  return [`diagnostic: ${type}`]
}
