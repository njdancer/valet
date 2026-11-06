// Errors leave the runtime as a stage plus an error class from fixed vocabularies, never as free
// text: page text and exception messages can carry secrets or personal data.

export const STAGES = [
  'manifest',
  'grant',
  'credential',
  'navigate',
  'auth-step',
  'secret-fill',
  'otp',
  'probe',
  'session-handoff',
  'request-surface',
  'egress',
  'tool-input',
  'tool-run',
  'tool-output',
  'confirm',
  'timeout',
] as const
export type Stage = (typeof STAGES)[number]

export const ERROR_CLASSES = [
  'invalid',
  'not-granted',
  'locked',
  'not-found',
  'field-missing',
  'unavailable',
  'origin-mismatch',
  'element-missing',
  'element-unsuitable',
  'form-action-mismatch',
  'navigation-escaped',
  'condition-timeout',
  'auth-failed',
  'not-logged-in',
  'blocked-by-site',
  'undeclared-request',
  'denied-path',
  'host-not-allowed',
  'request-ceiling',
  'declined',
  'timed-out',
  'aborted',
  'internal',
] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

export class SiteAdapterError extends Error {
  constructor(
    readonly stage: Stage,
    readonly errorClass: ErrorClass,
  ) {
    super(`${stage}: ${errorClass}`)
    this.name = 'SiteAdapterError'
  }
}

/** Collapses anything thrown into a reportable stage and class. Unknown errors become `internal`. */
export function toReportable(error: unknown, fallbackStage: Stage): { stage: Stage; errorClass: ErrorClass } {
  if (error instanceof SiteAdapterError) return { stage: error.stage, errorClass: error.errorClass }
  return { stage: fallbackStage, errorClass: 'internal' }
}
