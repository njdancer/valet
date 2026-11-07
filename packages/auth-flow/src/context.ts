// State shared by the interpreter's modules for one run, and the checks every step is followed by.

import { type FailClass, type NeedsUserReason, type Stage, urlOriginAllowed, ValetError } from '@valet/core'
import type { UrlRegexes } from './conditions'
import type { AuthFlowInput } from './types'

export interface FlowContext {
  readonly input: AuthFlowInput
  /** When the flow started. One-time codes older than this are never used. */
  readonly startedAt: Date
  /** Epoch milliseconds after which the flow has timed out. */
  readonly deadline: number
  /** Every urlRegex in the flow, compiled before the first step. */
  readonly regexes: UrlRegexes
  /**
   * True when the last thing the flow did was a probe that said logged in. Any other step clears
   * it, and the flow probes once more before reporting ok unless it is set.
   */
  probed: boolean
  /**
   * True once a password or one-time code has begun to be typed. A flow stopped after that may have
   * spent an attempt against the account; one stopped before it has cost the site nothing.
   */
  attemptStarted: boolean
}

/** Thrown to end the flow with needsUser. Not an error: the flow asked for the person. */
export class NeedsUserHalt extends Error {
  constructor(
    readonly reason: NeedsUserReason,
    /** The manifest's note, for the app only. */
    readonly note: string | undefined,
  ) {
    super('needs user')
    this.name = 'NeedsUserHalt'
  }
}

/** A manifest fail step. A ValetError, so retry treats it like any other, plus its note. */
export class FailStep extends ValetError {
  constructor(
    errorClass: FailClass,
    /** The manifest's note, for the app only. */
    readonly note: string | undefined,
  ) {
    super('auth-step', errorClass)
    this.name = 'FailStep'
  }
}

/**
 * Runs one injected effect. Anything it throws other than a ValetError becomes
 * `<stage>: internal`, because effect errors can carry page text or, worse, a secret.
 */
export async function guarded<T>(stage: Stage, effect: () => Promise<T> | T): Promise<T> {
  try {
    return await effect()
  } catch (error) {
    if (error instanceof ValetError) throw error
    throw new ValetError(stage, 'internal')
  }
}

/** The injected clock's time. A clock that can't tell the time ends the flow rather than every wait. */
export function now(ctx: FlowContext): number {
  const time = ctx.input.clock().getTime()
  if (!Number.isFinite(time)) throw new ValetError('auth-step', 'internal')
  return time
}

export function remainingMs(ctx: FlowContext): number {
  return Math.max(0, ctx.deadline - now(ctx))
}

export function checkDeadline(ctx: FlowContext): void {
  checkAborted(ctx)
  if (now(ctx) >= ctx.deadline) throw new ValetError('timeout', 'timed-out')
}

/** The caller gave up: the tool call was cancelled or timed out. */
export function checkAborted(ctx: FlowContext): void {
  if (ctx.input.signal?.aborted === true) throw new ValetError('auth-step', 'aborted')
}

/**
 * The injected sleep, cut short when the caller gives up, so a long pause or poll doesn't outlive
 * the call. Throws `auth-step: aborted` if it was.
 */
export async function pause(ctx: FlowContext, ms: number): Promise<void> {
  const { signal, sleep } = ctx.input
  checkAborted(ctx)
  if (signal === undefined) {
    await sleep(ms)
    return
  }
  let onAbort = (): void => {}
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([sleep(ms), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  checkAborted(ctx)
}

/**
 * Every URL the auth page has committed to must be on the navigation allowlist. Checking the whole
 * history, not just the current URL, catches an open redirect that bounced through another host and
 * came back. A fresh page's about:blank has no origin to leak to and is allowed.
 */
export async function checkNavigation(ctx: FlowContext): Promise<void> {
  const urls = await guarded('navigate', () => ctx.input.page.committedUrls())
  for (const url of urls) {
    if (url === 'about:blank') continue
    if (!urlOriginAllowed(url, ctx.input.manifest.navigation)) {
      throw new ValetError('navigate', 'navigation-escaped')
    }
  }
}

/** The site's bot protection showing its block page ends the flow as blocked, never retried. */
export async function checkBlocked(ctx: FlowContext): Promise<void> {
  if (await guarded('auth-step', () => ctx.input.isBlockedPage())) {
    throw new ValetError('auth-step', 'blocked-by-site')
  }
}

/** The checks that follow every step and every poll. Navigation first: an escape is the worse news. */
export async function checkAfterStep(ctx: FlowContext): Promise<void> {
  await checkNavigation(ctx)
  await checkBlocked(ctx)
  checkDeadline(ctx)
}
