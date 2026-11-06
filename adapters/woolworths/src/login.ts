// Cart tools need a logged-in session. When the runtime can't provide one, the tool throws, rather
// than returning a "not logged in" result, so that the runtime sees a failed call (and can re-run
// the auth action or show the person the login window) instead of a successful one.
//
// needsUser and an expired session are reported differently on purpose. docs/security-model.md has
// the runtime re-run the auth action when the site wants a login partway through a tool; that is
// ('tool-run', 'not-logged-in'), which a 401 produces. needsUser means the auth action has already
// asked for the person (a CAPTCHA, say), and re-running the scripted login then would resubmit a
// password on a session the site has flagged. Until core has a typed needsUser signal, it leaves
// as ('auth-step', 'not-logged-in'), which a retry keyed on the tool-run pair will not match.

import {
  ERROR_CLASSES,
  type ErrorClass,
  SiteAdapterError,
  STAGES,
  type Stage,
  type ToolContext,
} from '@siteadapter/core'

/** The stage and class a needsUser from ensure() leaves as. Never the expired-session pair. */
export const NEEDS_USER = ['auth-step', 'not-logged-in'] as const satisfies readonly [Stage, ErrorClass]

export async function requireLogin(ctx: ToolContext): Promise<void> {
  const result = await ctx.session.ensure()
  if (result.status === 'ok') return
  // A failure from the runtime keeps its stage and class, e.g. credential/locked, so the client
  // learns that 1Password needs unlocking. Anything outside the fixed vocabularies, and the free-text
  // needsUser reason, is never passed on.
  if (result.status === 'needsUser') throw new SiteAdapterError(...NEEDS_USER)
  if (isStage(result.stage) && isErrorClass(result.errorClass)) {
    throw new SiteAdapterError(result.stage, result.errorClass)
  }
  // ensure() has already run the auth action, so its failure is the auth action's, not an
  // expired session for the runtime to log in again over.
  throw new SiteAdapterError('auth-step', 'auth-failed')
}

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value)
}

function isErrorClass(value: string): value is ErrorClass {
  return (ERROR_CLASSES as readonly string[]).includes(value)
}
