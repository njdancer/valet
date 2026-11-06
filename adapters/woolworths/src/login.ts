// Cart tools need a logged-in session. When the runtime can't provide one, the tool throws, rather
// than returning a "not logged in" result, so that the runtime sees a failed call instead of a
// successful one: NeedsUserError when the auth action stopped for the person (a CAPTCHA, a code
// it can't read), so the run ends as needsUser and the app shows the window; otherwise the
// runtime's own stage and class (credential/locked, say, so the client learns 1Password needs
// unlocking).
//
// The anonymous trolley answers 200 like a logged-in one, so a cart call can't tell on its own that
// the session is anonymous: ensure() runs first, every time. A 401 can still come back if the
// session expires between the probe and the call; the tool then runs ensure() once more and
// retries, because a refused request changed nothing on the site.

import {
  ERROR_CLASSES,
  type ErrorClass,
  NEEDS_USER_REASONS,
  NeedsUserError,
  type NeedsUserReason,
  SiteAdapterError,
  STAGES,
  type Stage,
  type ToolContext,
} from '@siteadapter/core'

export async function requireLogin(ctx: ToolContext): Promise<void> {
  const result = await ctx.session.ensure()
  if (result.status === 'ok') return
  // The result is typed, but it crosses from the runtime; only the fixed vocabularies are passed
  // on, so nothing else can ride along in a reason, stage or class.
  if (result.status === 'needsUser') {
    throw new NeedsUserError(isNeedsUserReason(result.reason) ? result.reason : 'other')
  }
  if (isStage(result.stage) && isErrorClass(result.errorClass)) {
    throw new SiteAdapterError(result.stage, result.errorClass)
  }
  // ensure() has already run the auth action, so its failure is the auth action's, not an
  // expired session for the runtime to log in again over.
  throw new SiteAdapterError('auth-step', 'auth-failed')
}

/**
 * Runs `call` on a logged-in session. If the site answers 401 partway (the session expired after
 * the probe), it logs in once more and runs `call` again from the start; a second 401 is thrown.
 */
export async function withLogin<T>(ctx: ToolContext, call: () => Promise<T>): Promise<T> {
  await requireLogin(ctx)
  try {
    return await call()
  } catch (error) {
    if (!sessionExpired(error)) throw error
  }
  await requireLogin(ctx)
  return call()
}

function sessionExpired(error: unknown): boolean {
  return (
    error instanceof SiteAdapterError && error.stage === 'tool-run' && error.errorClass === 'not-logged-in'
  )
}

function isNeedsUserReason(value: string): value is NeedsUserReason {
  return (NEEDS_USER_REASONS as readonly string[]).includes(value)
}

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value)
}

function isErrorClass(value: string): value is ErrorClass {
  return (ERROR_CLASSES as readonly string[]).includes(value)
}
