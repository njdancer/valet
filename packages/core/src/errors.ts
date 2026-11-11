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
  /** The app's own updates: the signed feed, the download and the install. */
  'update',
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
  /**
   * The call could not get its turn behind earlier calls for the same adapter in the time the
   * runtime allows, and was not started. Nothing was sent; it may be made again.
   */
  'busy',
  'undeclared-request',
  'denied-path',
  'host-not-allowed',
  'request-ceiling',
  'ambiguous-path',
  /**
   * A response was not the kind the caller expects at all: HTML where JSON was asked for, or a body
   * over a size cap. An error page or a redirect, as often as a changed site.
   */
  'unexpected-shape',
  /**
   * A site response was JSON but failed the adapter's schema: the site changed what it sends, and
   * the adapter needs an update. Retrying won't help.
   */
  'site-changed',
  /** The element exists but trusted input cannot reach it, e.g. inside an out-of-process frame. */
  'input-unreachable',
  /** A local file has loose permissions or an unexpected owner. */
  'insecure-file',
  'login-in-progress',
  'unsupported',
  /** A signature did not verify: an update feed's envelope, or a downloaded build. */
  'signature-invalid',
  /** Signed metadata past its validity window, e.g. an update feed that stopped being re-signed. */
  'expired',
  /** The person paused this one site in the app: the call was not started (stage config). */
  'site-paused',
  /** The person locked Valet down: every call is refused (stage config). */
  'locked-down',
  'declined',
  'timed-out',
  'aborted',
  'internal',
] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

export class ValetError extends Error {
  constructor(
    readonly stage: Stage,
    readonly errorClass: ErrorClass,
  ) {
    super(`${stage}: ${errorClass}`)
    this.name = 'ValetError'
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
  /** A setting the adapter requires has no value yet: the person picks one in the app (D69). */
  'setting-required',
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
  if (error instanceof ValetError) return { stage: error.stage, errorClass: error.errorClass }
  return { stage: fallbackStage, errorClass: 'internal' }
}
