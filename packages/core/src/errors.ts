// Errors leave the runtime as a stage plus an error class from fixed vocabularies, never as free
// text: page text and exception messages can carry secrets or personal data.

import { type InputIssue, inputIssue } from './input-issue'

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
   * The page a tool's fetch ran in refused it under its own Content-Security-Policy: the request
   * never left the browser. The tool should open a page on the API's own origin first.
   */
  'page-policy',
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
  /**
   * A tunnelled TLS connection named another server than the endpoint it was allowed to reach
   * (its ClientHello's SNI), so the broker closed it (docs/adapter-kinds.md#f1-the-egress-broker).
   */
  'sni-mismatch',
  /** The run sent more than its upload budget allows, so the broker closed the connection. */
  'upload-budget',
  /**
   * A protocol command the tool's declared side effect doesn't allow, or a folder or path the
   * manifest doesn't name, so nothing was sent (docs/imap.md).
   */
  'command-not-allowed',
  /**
   * An SSH server offered a host key other than the one the manifest pins, so Valet closed the
   * connection before signing in (docs/sftp.md). The server was replaced, or someone is in between.
   */
  'host-key-mismatch',
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

/**
 * Where inside Valet a failure happened and what was thrown there, kept for the app's own
 * diagnostics (its log, and valet_get_call's fault). `step` is a fixed word the thrower picks;
 * `cause` is whatever was thrown, which never reaches a client as it is.
 */
export interface ValetFault {
  readonly step: string
  readonly cause: unknown
}

export class ValetError extends Error {
  /** Set (by faulted) where Valet's own code turns an unexpected error into this one. */
  fault?: ValetFault
  /**
   * For stage tool-input only: where the input was wrong and why, from a fixed vocabulary
   * (input-issue.ts). Checked here, so whatever tool code passed only reaches a client as codes.
   */
  readonly issue?: InputIssue

  constructor(
    readonly stage: Stage,
    readonly errorClass: ErrorClass,
    issue?: InputIssue,
  ) {
    super(`${stage}: ${errorClass}`)
    this.name = 'ValetError'
    const checked = stage === 'tool-input' ? inputIssue(issue) : undefined
    if (checked !== undefined) this.issue = checked
  }
}

/** A ValetError that keeps what was really thrown, and where, for diagnostics. */
export function faulted(stage: Stage, errorClass: ErrorClass, step: string, cause: unknown): ValetError {
  const error = new ValetError(stage, errorClass)
  error.fault = { step, cause }
  return error
}

/** The fault a ValetError carries, if any. */
export function faultOf(error: unknown): ValetFault | undefined {
  return error instanceof ValetError ? error.fault : undefined
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
