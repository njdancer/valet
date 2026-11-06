// The entry point: runs one auth action and reports it as an outcome, never as a thrown error.

import { type AdapterManifest, type AuditEvent, toReportable } from '@siteadapter/core'
import { BlockedHalt, checkAfterStep, type FlowContext, NeedsUserHalt } from './context'
import { runSteps } from './interpreter'
import type { AuthFlowInput, AuthOutcome } from './types'

export async function runAuthFlow(input: AuthFlowInput): Promise<AuthOutcome> {
  const { manifest, audit, callId } = input
  const startedAt = input.clock()
  const ctx: FlowContext = { input, startedAt, deadline: startedAt.getTime() + input.flowTimeoutMs }

  // A login that can't be audited doesn't happen.
  try {
    await audit.append({ type: 'login-started', adapterId: manifest.id, callId })
  } catch {
    return { status: 'failed', stage: 'auth-step', errorClass: 'internal' }
  }

  const outcome = await execute(ctx)

  try {
    await audit.append(finishedEvent(manifest, outcome))
  } catch {
    // Reporting ok without a record would let the caller hand the session to tool code unaudited.
    return { status: 'failed', stage: 'auth-step', errorClass: 'internal' }
  }
  return outcome
}

async function execute(ctx: FlowContext): Promise<AuthOutcome> {
  try {
    // The page may already be somewhere it shouldn't be, or on a block page, before the first step.
    await checkAfterStep(ctx)
    await runSteps(ctx, ctx.input.manifest.auth.steps)
    return { status: 'ok' }
  } catch (error) {
    return toOutcome(error)
  }
}

function toOutcome(error: unknown): AuthOutcome {
  if (error instanceof NeedsUserHalt) return { status: 'needsUser', reason: error.reason }
  if (error instanceof BlockedHalt) return { status: 'blocked' }
  // Only the stage and class survive; the error itself, and anything in its message, stays here.
  const { stage, errorClass } = toReportable(error, 'auth-step')
  return { status: 'failed', stage, errorClass }
}

/**
 * The audit vocabulary has no `blocked` outcome yet, so a block is recorded as a failure with the
 * `blocked-by-site` class. See coreChangeRequests in the auth-flow handover.
 */
function finishedEvent(manifest: AdapterManifest, outcome: AuthOutcome): AuditEvent {
  const adapterId = manifest.id
  switch (outcome.status) {
    case 'ok':
      return { type: 'login-finished', adapterId, outcome: 'ok' }
    case 'needsUser':
      return { type: 'login-finished', adapterId, outcome: 'needsUser' }
    case 'blocked':
      return {
        type: 'login-finished',
        adapterId,
        outcome: 'failed',
        stage: 'auth-step',
        errorClass: 'blocked-by-site',
      }
    case 'failed':
      return {
        type: 'login-finished',
        adapterId,
        outcome: 'failed',
        stage: outcome.stage,
        errorClass: outcome.errorClass,
      }
  }
}
