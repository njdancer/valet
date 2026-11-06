// State shared by the interpreter's modules for one run, and the checks every step is followed by.

import { SiteAdapterError, type Stage, urlOriginAllowed } from '@siteadapter/core'
import type { AuthFlowInput } from './types'

export interface FlowContext {
  readonly input: AuthFlowInput
  /** When the flow started. One-time codes older than this are never used. */
  readonly startedAt: Date
  /** Epoch milliseconds after which the flow has timed out. */
  readonly deadline: number
}

/** Thrown to end the flow with needsUser. Not an error: the flow asked for the person. */
export class NeedsUserHalt extends Error {
  constructor(readonly reason: string) {
    super('needs user')
    this.name = 'NeedsUserHalt'
  }
}

/** Thrown to end the flow when the site's bot protection has refused us. */
export class BlockedHalt extends Error {
  constructor() {
    super('blocked by site')
    this.name = 'BlockedHalt'
  }
}

/**
 * Runs one injected effect. Anything it throws other than a SiteAdapterError becomes
 * `<stage>: internal`, because effect errors can carry page text or, worse, a secret.
 */
export async function guarded<T>(stage: Stage, effect: () => Promise<T> | T): Promise<T> {
  try {
    return await effect()
  } catch (error) {
    if (error instanceof SiteAdapterError) throw error
    throw new SiteAdapterError(stage, 'internal')
  }
}

export function now(ctx: FlowContext): number {
  return ctx.input.clock().getTime()
}

export function remainingMs(ctx: FlowContext): number {
  return Math.max(0, ctx.deadline - now(ctx))
}

export function checkDeadline(ctx: FlowContext): void {
  if (now(ctx) >= ctx.deadline) throw new SiteAdapterError('timeout', 'timed-out')
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
      throw new SiteAdapterError('navigate', 'navigation-escaped')
    }
  }
}

export async function checkBlocked(ctx: FlowContext): Promise<void> {
  if (await guarded('auth-step', () => ctx.input.isBlockedPage())) throw new BlockedHalt()
}

/** The checks that follow every step and every poll. Navigation first: an escape is the worse news. */
export async function checkAfterStep(ctx: FlowContext): Promise<void> {
  await checkNavigation(ctx)
  await checkBlocked(ctx)
  checkDeadline(ctx)
}
