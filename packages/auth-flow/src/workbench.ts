// The login workbench: an agent works out a site's login one batch of auth steps at a time, on the
// adapter's own auth page, through the same interpreter a real login runs. Every check a login has
// holds here, because it is the same code: secrets are filled only by secret-fill.ts, from the
// person's grant and only on its origins, after the element checks; the page can't leave the
// manifest's navigation origins; a block page ends the batch as blocked; a password is typed at
// most once for the workbench's whole life, however many batches ask (D32). What the agent learns is
// written in the manifest's own vocabulary, so the steps that worked are the fix.
//
// The workbench only runs steps. It never copies the session anywhere (the runtime's auth-to-tool
// hand-off is a login's, not the workbench's), and reading the page is the caller's, through
// AuthPage.describe().

import type { AuthStep } from '@valet/core'
import { compileUrlRegexes } from './conditions'
import { checkAfterStep, type FlowContext } from './context'
import { runSteps } from './interpreter'
import { toOutcome } from './run-auth-flow'
import type { AuthFlowInput, AuthOutcome } from './types'
import { type UrlPatternMatcher, WorkerUrlMatcher } from './url-matcher'

/**
 * What stays the same for the workbench's life: a login's input, less what each batch brings. A
 * urlMatcher passed in is the caller's to close; the default one is the workbench's.
 */
export type WorkbenchInput = Omit<
  AuthFlowInput,
  'flowTimeoutMs' | 'signal' | 'paceNavigation' | 'beforeAttempt'
>

export interface WorkbenchBatch {
  readonly steps: readonly AuthStep[]
  /** The most the batch may take, waits for one-time codes included. */
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** Awaited before each navigation, as a login's is (D55). */
  readonly paceNavigation?: () => Promise<void>
}

/**
 * How a batch ended. `ok` means every step ran; it says nothing about being logged in, which only
 * an assertLoggedIn step does. The other outcomes are a login's (AuthOutcome), less its notes:
 * the agent wrote any note itself.
 */
export type WorkbenchOutcome = { readonly status: 'ok' } | Exclude<AuthOutcome, { readonly status: 'ok' }>

export class LoginWorkbench {
  /** Across batches: the second password fill of the workbench's life is refused. */
  private passwordFills = 0
  private readonly matcher: UrlPatternMatcher
  private closed = false
  /** One batch at a time: the page is one page. */
  private running: Promise<unknown> = Promise.resolve()

  constructor(private readonly input: WorkbenchInput) {
    this.matcher = input.urlMatcher ?? new WorkerUrlMatcher()
  }

  /** Runs the steps on the page, after whatever earlier batches left it at. Never throws. */
  run(batch: WorkbenchBatch): Promise<WorkbenchOutcome> {
    const next = this.running.then(() => this.runNow(batch))
    this.running = next.catch(() => undefined)
    return next
  }

  /** Stops the URL matcher. The page is the caller's to close. */
  close(): void {
    this.closed = true
    if (this.matcher !== this.input.urlMatcher) this.matcher.close()
  }

  private async runNow(batch: WorkbenchBatch): Promise<WorkbenchOutcome> {
    if (this.closed) return { status: 'failed', stage: 'auth-step', errorClass: 'aborted' }
    if (!Number.isFinite(batch.timeoutMs) || batch.timeoutMs <= 0)
      return { status: 'failed', stage: 'auth-step', errorClass: 'invalid' }
    const patterns = compileUrlRegexes(batch.steps)
    if (patterns === null) return { status: 'failed', stage: 'manifest', errorClass: 'invalid' }
    let startedAt: Date
    try {
      startedAt = this.input.clock()
    } catch {
      return { status: 'failed', stage: 'auth-step', errorClass: 'internal' }
    }
    const ctx: FlowContext = {
      input: {
        ...this.input,
        flowTimeoutMs: batch.timeoutMs,
        urlMatcher: this.matcher,
        ...(batch.signal === undefined ? {} : { signal: batch.signal }),
        ...(batch.paceNavigation === undefined ? {} : { paceNavigation: batch.paceNavigation }),
      },
      startedAt,
      deadline: startedAt.getTime() + batch.timeoutMs,
      regexes: { patterns, matcher: this.matcher },
      probed: false,
      attemptStarted: false,
      passwordFills: this.passwordFills,
    }
    try {
      await checkAfterStep(ctx)
      await runSteps(ctx, batch.steps)
      return { status: 'ok' }
    } catch (error) {
      const outcome = toOutcome(error)
      // Notes are the agent's own words, or a manifest's; neither goes back.
      if (outcome.status === 'needsUser') return { status: 'needsUser', reason: outcome.reason }
      if (outcome.status === 'blocked')
        return { status: 'blocked', stage: outcome.stage, errorClass: outcome.errorClass }
      if (outcome.status === 'failed')
        return { status: 'failed', stage: outcome.stage, errorClass: outcome.errorClass }
      return { status: 'failed', stage: 'auth-step', errorClass: 'internal' }
    } finally {
      this.passwordFills = Math.max(this.passwordFills, ctx.passwordFills)
    }
  }
}
