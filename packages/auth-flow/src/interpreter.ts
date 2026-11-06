// Runs a manifest's auth steps. The vocabulary is closed and no step evaluates script; see
// "Auth action: the steps" in docs/security-model.md.

import {
  type AuthStep,
  type Condition,
  type ErrorClass,
  SiteAdapterError,
  type Stage,
  urlOriginAllowed,
} from '@siteadapter/core'
import { evaluateCondition } from './conditions'
import {
  checkAfterStep,
  checkBlocked,
  checkDeadline,
  checkNavigation,
  type FlowContext,
  guarded,
  NeedsUserHalt,
  now,
  remainingMs,
} from './context'
import { fillMessagesOtp, fillSecret } from './secret-fill'

/** How often waitFor re-checks its condition. */
export const POLL_MS = 250

/**
 * Failures that a retry may plausibly fix, as stage and class together: the page was slow, or the
 * site refused a login it may accept next time. The stage matters as much as the class. An element
 * that went missing during a secret fill is a guard that fired, perhaps because the page changed
 * while the person approved Touch ID, and guard failures are never retried: retrying would only
 * give the page another chance to get past the guard, and ask the person for Touch ID again.
 */
const RETRYABLE: readonly (readonly [Stage, ErrorClass])[] = [
  ['auth-step', 'condition-timeout'],
  ['auth-step', 'element-missing'],
  ['auth-step', 'auth-failed'],
  ['probe', 'not-logged-in'],
]

function isRetryable(error: unknown): boolean {
  return (
    error instanceof SiteAdapterError &&
    RETRYABLE.some(([stage, errorClass]) => error.stage === stage && error.errorClass === errorClass)
  )
}

export async function runSteps(ctx: FlowContext, steps: readonly AuthStep[]): Promise<void> {
  for (const step of steps) {
    checkDeadline(ctx)
    await runStep(ctx, step)
    await checkAfterStep(ctx)
  }
}

async function runStep(ctx: FlowContext, step: AuthStep): Promise<void> {
  const { page, manifest, typingDelayMs } = ctx.input
  switch (step.op) {
    case 'goto':
      if (!urlOriginAllowed(step.url, manifest.navigation)) {
        throw new SiteAdapterError('navigate', 'navigation-escaped')
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
      await ctx.input.sleep(Math.min(step.ms, remainingMs(ctx)))
      return
    case 'when': {
      const holds = await guarded('auth-step', () => evaluateCondition(page, step.condition))
      await runSteps(ctx, holds ? step.steps : (step.otherwise ?? []))
      return
    }
    case 'retry':
      await retry(ctx, step.times, step.steps)
      return
    case 'assertLoggedIn':
      if (!(await guarded('probe', () => ctx.input.probe()))) {
        throw new SiteAdapterError('probe', 'not-logged-in')
      }
      return
    case 'needsUser':
      throw new NeedsUserHalt(step.reason)
    case 'fail':
      throw new SiteAdapterError('auth-step', 'auth-failed')
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
    if (await guarded('auth-step', () => evaluateCondition(ctx.input.page, condition))) return
    await checkNavigation(ctx)
    await checkBlocked(ctx)
    checkDeadline(ctx)
    if (now(ctx) >= stepDeadline) throw new SiteAdapterError('auth-step', 'condition-timeout')
    await ctx.input.sleep(POLL_MS)
  }
}

async function requireVisible(ctx: FlowContext, selector: string): Promise<void> {
  const element = await guarded('auth-step', () => ctx.input.page.inspect(selector))
  if (element === null || !element.visible) throw new SiteAdapterError('auth-step', 'element-missing')
}
