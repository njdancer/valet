// The entry point: runs one auth action and reports it as an outcome, never as a thrown error.

import { type AdapterManifest, type AuditEvent, toReportable } from '@siteadapter/core'
import { compileUrlRegexes } from './conditions'
import { checkAfterStep, FailStep, type FlowContext, NeedsUserHalt } from './context'
import { assertLoggedIn, runSteps } from './interpreter'
import type { AuthFlowInput, AuthOutcome } from './types'
import { type UrlPatternMatcher, WorkerUrlMatcher } from './url-matcher'

export async function runAuthFlow(input: AuthFlowInput): Promise<AuthOutcome> {
  try {
    return await run(input)
  } catch {
    // Nothing should get here, but an injected effect outside the steps, such as a clock, could
    // still throw, with anything in its message. Only the class leaves.
    return { status: 'failed', stage: 'auth-step', errorClass: 'internal' }
  }
}

async function run(input: AuthFlowInput): Promise<AuthOutcome> {
  const { manifest } = input
  // Bad numbers would make every deadline check false and every poll loop endless.
  if (!isDuration(input.typingDelayMs) || !isDuration(input.flowTimeoutMs) || input.flowTimeoutMs === 0) {
    return { status: 'failed', stage: 'auth-step', errorClass: 'invalid' }
  }
  const patterns = compileUrlRegexes(manifest.auth.steps)
  if (patterns === null) return { status: 'failed', stage: 'manifest', errorClass: 'invalid' }
  // An injected matcher is the caller's to close; the default one is this run's.
  const matcher = input.urlMatcher ?? new WorkerUrlMatcher()
  try {
    return await audited(input, matcher, patterns)
  } finally {
    if (matcher !== input.urlMatcher) matcher.close()
  }
}

async function audited(
  input: AuthFlowInput,
  matcher: UrlPatternMatcher,
  patterns: ReadonlySet<string>,
): Promise<AuthOutcome> {
  const { manifest, audit, callId } = input
  const startedAt = input.clock()
  const ctx: FlowContext = {
    input,
    startedAt,
    deadline: startedAt.getTime() + input.flowTimeoutMs,
    regexes: { patterns, matcher },
    probed: false,
  }
  if (!Number.isFinite(ctx.deadline)) return { status: 'failed', stage: 'auth-step', errorClass: 'internal' }

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

/** A finite, non-negative number of milliseconds. */
function isDuration(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0
}

async function execute(ctx: FlowContext): Promise<AuthOutcome> {
  try {
    // The page may already be somewhere it shouldn't be, or on a block page, before the first step.
    await checkAfterStep(ctx)
    await runSteps(ctx, ctx.input.manifest.auth.steps)
    // The interpreter always finishes with the probe. A flow whose last word was a passing
    // assertLoggedIn has just run it; any other flow, however it ended, runs it now.
    if (!ctx.probed) {
      await assertLoggedIn(ctx)
      await checkAfterStep(ctx)
    }
    return { status: 'ok' }
  } catch (error) {
    return toOutcome(error)
  }
}

function toOutcome(error: unknown): AuthOutcome {
  if (error instanceof NeedsUserHalt) {
    return error.note === undefined
      ? { status: 'needsUser', reason: error.reason }
      : { status: 'needsUser', reason: error.reason, appNote: error.note }
  }
  const note = error instanceof FailStep && error.note !== undefined ? { appNote: error.note } : {}
  // Only the stage and class survive; the error itself, and anything in its message, stays here.
  const { stage, errorClass } = toReportable(error, 'auth-step')
  // A block, from the block page, the probe or a fail step, is the site's answer, not a fault:
  // the caller cools down instead of retrying.
  if (errorClass === 'blocked-by-site' || errorClass === 'rate-limited') {
    return { status: 'blocked', stage, errorClass, ...note }
  }
  return { status: 'failed', stage, errorClass, ...note }
}

/** What the audit log records. Notes are free text and never go in it; reasons and classes do. */
function finishedEvent(manifest: AdapterManifest, outcome: AuthOutcome): AuditEvent {
  const adapterId = manifest.id
  switch (outcome.status) {
    case 'ok':
      return { type: 'login-finished', adapterId, outcome: 'ok' }
    case 'needsUser':
      return { type: 'login-finished', adapterId, outcome: 'needsUser', needsUser: outcome.reason }
    case 'blocked':
    case 'failed':
      return {
        type: 'login-finished',
        adapterId,
        outcome: outcome.status,
        stage: outcome.stage,
        errorClass: outcome.errorClass,
      }
  }
}
