// Cart tools need a logged-in session. When the runtime can't provide one, the tool throws, rather
// than returning a "not logged in" result, so that the runtime sees a failed call (and can re-run
// the auth action or show the person the login window) instead of a successful one.

import {
  ERROR_CLASSES,
  type ErrorClass,
  SiteAdapterError,
  STAGES,
  type Stage,
  type ToolContext,
} from '@siteadapter/core'

export async function requireLogin(ctx: ToolContext): Promise<void> {
  const result = await ctx.session.ensure()
  if (result.status === 'ok') return
  // A failure from the runtime keeps its stage and class, e.g. credential/locked, so the client
  // learns that 1Password needs unlocking. Anything outside the fixed vocabularies, and the free-text
  // needsUser reason, is never passed on.
  if (result.status === 'failed' && isStage(result.stage) && isErrorClass(result.errorClass)) {
    throw new SiteAdapterError(result.stage, result.errorClass)
  }
  throw new SiteAdapterError('tool-run', 'not-logged-in')
}

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value)
}

function isErrorClass(value: string): value is ErrorClass {
  return (ERROR_CLASSES as readonly string[]).includes(value)
}
