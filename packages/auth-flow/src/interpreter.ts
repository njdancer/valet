// Runs a manifest's auth steps. The vocabulary is closed and no step evaluates script; see
// "Auth action: the steps" in docs/security-model.md.

import {
  type AuthStep,
  type Condition,
  type ErrorClass,
  FAIL_CLASSES,
  NEEDS_USER_REASONS,
  type Stage,
  urlOriginAllowed,
  ValetError,
} from '@valet/core'
import { evaluateCondition } from './conditions'
import {
  checkAfterStep,
  checkBlocked,
  checkDeadline,
  checkNavigation,
  FailStep,
  type FlowContext,
  guarded,
  NeedsUserHalt,
  now,
  pause,
  remainingMs,
} from './context'
import { probeLoggedIn } from './probe'
import { fillMessagesOtp, fillSecret } from './secret-fill'

/** How often waitFor re-checks its condition. */
export const POLL_MS = 250

/**
 * Failures that a retry may plausibly fix, as stage and class together: the page wasn't ready yet
 * (D32). A rejected login and a probe that still says logged out are never retried: both come after
 * a password submit, and a second submit is what locks accounts (AC10). The stage matters as much
 * as the class. An element
 * that went missing during a secret fill is a guard that fired, perhaps because the page changed
 * while the person approved Touch ID, and guard failures are never retried: retrying would only
 * give the page another chance to get past the guard, and ask the person for Touch ID again.
 */
const RETRYABLE: readonly (readonly [Stage, ErrorClass])[] = [
  ['auth-step', 'condition-timeout'],
  ['auth-step', 'element-missing'],
]

function isRetryable(error: unknown): boolean {
  return (
    error instanceof ValetError &&
    RETRYABLE.some(([stage, errorClass]) => error.stage === stage && error.errorClass === errorClass)
  )
}

export async function runSteps(ctx: FlowContext, steps: readonly AuthStep[]): Promise<void> {
  for (const step of steps) {
    checkDeadline(ctx)
    // when and retry don't act themselves; the steps inside them clear or set it.
    if (step.op !== 'when' && step.op !== 'retry') ctx.probed = false
    await runStep(ctx, step)
    await checkAfterStep(ctx)
  }
}

/**
 * Runs the probe, and fails with probe: not-logged-in unless it says logged in. The flow ends with
 * this whether or not the manifest asked for it: a flow that ran out of steps hasn't shown it
 * logged in, and handing its session to tool code on that basis would hand over whatever the page
 * was left with.
 */
export async function assertLoggedIn(ctx: FlowContext): Promise<void> {
  if (!(await probeLoggedIn(ctx))) throw new ValetError('probe', 'not-logged-in')
  ctx.probed = true
}

async function runStep(ctx: FlowContext, step: AuthStep): Promise<void> {
  const { page, manifest, typingDelayMs } = ctx.input
  switch (step.op) {
    case 'goto':
      if (!urlOriginAllowed(step.url, manifest.navigation)) {
        throw new ValetError('navigate', 'navigation-escaped')
      }
      await guarded('navigate', () => page.goto(step.url))
      return
    case 'waitFor':
      await waitFor(ctx, step.condition, step.timeoutMs)
      return
    case 'click':
      await requireVisible(ctx, step.selector)
      await guarded('auth-step', () => page.click(step.selector))
      return
    case 'fill':
      if ('literal' in step.value) {
        const literal = step.value.literal
        await requireVisible(ctx, step.selector)
        await guarded('auth-step', () => page.focus(step.selector))
        await guarded('auth-step', () => page.type(literal, { delayMs: typingDelayMs }))
      } else {
        await fillSecret(ctx, step.selector, step.value)
      }
      return
    case 'otp':
      if ('secret' in step.source) {
        await fillSecret(ctx, step.selector, { secret: step.source.secret, field: 'otp' })
      } else {
        await fillMessagesOtp(ctx, step.selector, step.source.messages)
      }
      return
    case 'pause':
      await pause(ctx, Math.min(step.ms, remainingMs(ctx)))
      return
    case 'when': {
      const holds = await guarded('auth-step', () => evaluateCondition(page, step.condition, ctx.regexes))
      await runSteps(ctx, holds ? step.steps : (step.otherwise ?? []))
      return
    }
    case 'retry':
      await retry(ctx, step.times, step.steps)
      return
    case 'assertLoggedIn':
      await assertLoggedIn(ctx)
      return
    // The vocabularies are checked again here, not only at parse time: the reason reaches the MCP
    // client, and free text there would be an injection channel for whoever wrote the manifest.
    case 'needsUser':
      if (!NEEDS_USER_REASONS.includes(step.reason)) throw new ValetError('manifest', 'invalid')
      throw new NeedsUserHalt(step.reason, step.note)
    case 'fail':
      if (!FAIL_CLASSES.includes(step.errorClass)) throw new ValetError('manifest', 'invalid')
      throw new FailStep(step.errorClass, step.note)
  }
}

/** Runs `steps`, and re-runs them up to `times` more times while they fail retryably. */
async function retry(ctx: FlowContext, times: number, steps: readonly AuthStep[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runSteps(ctx, steps)
      return
    } catch (error) {
      if (!isRetryable(error) || attempt >= times) throw error
    }
  }
}

/**
 * Polls in Node rather than in the page, because navigation kills in-page timers. Navigation and
 * bot-block checks run on every poll, so a redirect during a long wait is caught when it happens.
 */
async function waitFor(ctx: FlowContext, condition: Condition, timeoutMs: number): Promise<void> {
  const stepDeadline = now(ctx) + timeoutMs
  for (;;) {
    if (await guarded('auth-step', () => evaluateCondition(ctx.input.page, condition, ctx.regexes))) return
    await checkNavigation(ctx)
    await checkBlocked(ctx)
    checkDeadline(ctx)
    if (now(ctx) >= stepDeadline) throw new ValetError('auth-step', 'condition-timeout')
    await pause(ctx, POLL_MS)
  }
}

async function requireVisible(ctx: FlowContext, selector: string): Promise<void> {
  const element = await guarded('auth-step', () => ctx.input.page.inspect(selector))
  if (element === null || !element.visible) throw new ValetError('auth-step', 'element-missing')
}
