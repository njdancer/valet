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
  /** The login action as a whole: the attempt marker and the runner around the interpreter. */
  'login',
  /** Local files the app owns: endpoint token, bridge config, grants, approvals. */
  'config',
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
  /** The site answered 429, or our own rate budget or circuit breaker refused the request. */
  'rate-limited',
  'undeclared-request',
  'denied-path',
  'host-not-allowed',
  'request-ceiling',
  'ambiguous-path',
  /** A site response did not have the shape the adapter expects: the site probably changed. */
  'unexpected-shape',
  /** The element exists but trusted input cannot reach it, e.g. inside an out-of-process frame. */
  'input-unreachable',
  /** A local file has loose permissions or an unexpected owner. */
  'insecure-file',
  'login-in-progress',
  'unsupported',
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

/**
 * Why a run stopped to wait for the person. Codes, not text: the MCP client sees only the code, and
 * the app renders its own wording. Free text from a manifest is shown only inside the app.
 */
export const NEEDS_USER_REASONS = [
  'login-required',
  'otp-required',
  'captcha',
  'account-locked',
  'terms-update',
  'site-changed',
  'login-attempt-pending',
  'other',
] as const
export type NeedsUserReason = (typeof NEEDS_USER_REASONS)[number]

/** Thrown by tool code (or the runtime) to stop a run and ask the person to act in the app. */
export class NeedsUserError extends Error {
  constructor(readonly reason: NeedsUserReason) {
    super(`needs user: ${reason}`)
    this.name = 'NeedsUserError'
  }
}

/** Collapses anything thrown into a reportable stage and class. Unknown errors become `internal`. */
export function toReportable(error: unknown, fallbackStage: Stage): { stage: Stage; errorClass: ErrorClass } {
  if (error instanceof SiteAdapterError) return { stage: error.stage, errorClass: error.errorClass }
  return { stage: fallbackStage, errorClass: 'internal' }
}
