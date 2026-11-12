// Live trials (docs/authoring-tools.md#live-trials): one call of a draft's read tool against the
// real site, before anyone approves it. The draft's compiled code runs as an installed adapter's
// does (a fresh sandbox process with no local exceptions, through the runtime's GuardedToolPage, and
// a session driver holding the tool partition to the run's policy) with three differences:
//
// - read tools only: the run's policy allows read declarations and nothing else;
// - signed out: the driver's partitions are in memory and new for each trial, and
//   session.ensure() answers login-required unless the site needs no login;
// - the site's own guards: the rate budget and breaker the installed adapters for that host use,
//   so a trial waits its turn behind them, and a site that refuses one holds them back too.
//
// Electron-free; the app gives it the driver.

import type { AdapterManifest, BlockedRequest, EnsureResult, SessionDriver, ToolContext } from '@valet/core'
import {
  breakerRefusal,
  CallState,
  GuardedToolPage,
  runIsolated,
  SecretRedactionSet,
  type SiteGuards,
  type ToolProcessFactory,
} from '@valet/runtime'
import { NO_LOCAL_ACCESS } from '@valet/sandbox'
import { describeError, type RunnableDraft } from './cases'
import { scrubUrl } from './research'

export const TRIAL_LIMITS = {
  /** One call's whole time, from opening the page to the output. */
  timeoutMs: 60_000,
  /** Trials per draft in any hour. */
  perDraftPerHour: 6,
  /** The output handed back, as JSON text. */
  outputChars: 20_000,
  /** Refused requests listed. */
  blocked: 20,
} as const

export interface TrialDeps {
  /** A fresh sandbox process for the call (SandboxPool.oneShot()). */
  readonly start: ToolProcessFactory
  /** A driver for the manifest whose partitions are in memory and new: the label names them. */
  readonly driver: (manifest: AdapterManifest, label: string) => Promise<SessionDriver>
  /** The installed adapters' guards for the host (ToolHost.siteGuards). */
  readonly guards: (host: string) => SiteGuards
  readonly timeoutMs?: number
}

export type TrialOutcome =
  | { readonly kind: 'output'; readonly output: unknown }
  | { readonly kind: 'error'; readonly stage: string; readonly errorClass: string }
  | { readonly kind: 'needs-user'; readonly reason: string }
  | { readonly kind: 'invalid-output' }
  | { readonly kind: 'timeout' }
  /** The site's breaker is open, or its hourly cap is spent: nothing was sent. */
  | { readonly kind: 'site-resting'; readonly retryAfterMs: number }

export interface TrialResult {
  readonly outcome: TrialOutcome
  /** What the driver refused, scrubbed of ids: what an agent fixes egress and requests from. */
  readonly blocked: readonly { readonly method: string; readonly url: string; readonly reason: string }[]
  readonly ms: number
}

/** Runs one call of `tool` with `input`, already checked against its input schema. */
export async function runTrial(
  draft: RunnableDraft,
  tool: string,
  input: unknown,
  label: string,
  deps: TrialDeps,
  now: () => number = Date.now,
): Promise<TrialResult> {
  const started = now()
  const manifest = draft.manifest
  const declared = manifest.tools.find((t) => t.name === tool)
  const schemas = draft.tools[tool]
  if (declared === undefined || schemas === undefined || declared.sideEffect !== 'read')
    throw new Error('runTrial is for a declared read tool')
  const site = deps.guards(new URL(manifest.home).hostname)
  const blocked: TrialResult['blocked'][number][] = []
  const done = (outcome: TrialOutcome): TrialResult => ({ outcome, blocked, ms: now() - started })
  if (site.breaker.isOpen())
    return done({ kind: 'site-resting', retryAfterMs: site.breaker.status().retryAfterMs })
  // The hourly cap, asked about once before anything is sent, as an installed call's is.
  const spentForMs = site.budget.spentForMs()
  if (spentForMs > 0) return done({ kind: 'site-resting', retryAfterMs: spentForMs })

  const driver = await deps.driver(manifest, label)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    driver.watchSite?.({
      refused: (refusal) => site.breaker.trip(refusal.cause, null),
      held: () => site.breaker.isOpen(),
      pace: async () => {
        if (site.breaker.isOpen()) throw breakerRefusal()
        await site.budget.acquire(controller.signal)
      },
    })
    const record = (b: BlockedRequest): void => {
      if (blocked.length < TRIAL_LIMITS.blocked)
        blocked.push({ method: b.method, url: scrubUrl(b.target), reason: b.reason })
    }
    driver.beginRun(
      {
        egress: manifest.egress,
        requests: manifest.requests.filter((r) => r.purpose === 'read'),
        unlocks: [],
        maxPurpose: 'read',
        ceiling: manifest.limits.requestsPerRun,
      },
      record,
    )
    const state = new CallState(`trial-${label}`, controller.signal, () => new SecretRedactionSet())
    const timeoutMs = deps.timeoutMs ?? TRIAL_LIMITS.timeoutMs
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve('timeout')
      }, timeoutMs)
    })
    const run = async (): Promise<unknown> => {
      const inner = await driver.toolPage()
      const page = new GuardedToolPage({
        adapterId: manifest.id,
        manifest,
        sideEffect: 'read',
        unlocks: [],
        inner,
        site,
        state,
        audit: async () => {},
      })
      const ctx: ToolContext = {
        page,
        session: { ensure: async (): Promise<EnsureResult> => signedOut(manifest) },
        // A read tool never asks; a trial would answer no.
        confirm: async () => false,
        signal: controller.signal,
        local: NO_LOCAL_ACCESS,
      }
      return runIsolated(deps.start, draft.script, ctx, tool, input)
    }
    const settled = await Promise.race([
      run().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      timedOut,
    ])
    if (settled === 'timeout') return done({ kind: 'timeout' })
    // A guard the tool caught and swallowed still ends the call as that violation, as installed.
    const error = settled.ok ? state.violation : settled.error
    if (error !== null && error !== undefined) {
      const described = describeError(error)
      if (described.kind === 'needs-user') return done({ kind: 'needs-user', reason: described.reason })
      if (described.kind === 'error')
        return done({ kind: 'error', stage: described.stage, errorClass: described.errorClass })
      return done({ kind: 'error', stage: 'tool-run', errorClass: 'internal' })
    }
    const output = await schemas.output.safeParseAsync(settled.ok ? settled.value : undefined)
    if (!output.success) return done({ kind: 'invalid-output' })
    return done({ kind: 'output', output: clipOutput(output.data) })
  } finally {
    clearTimeout(timer)
    controller.abort()
    try {
      driver.endRun()
    } catch {
      // Closing below stops everything anyway.
    }
    await driver.close().catch(() => undefined)
  }
}

/** A trial is signed out: only a site with no login has a session. */
function signedOut(manifest: AdapterManifest): EnsureResult {
  return manifest.session.probe.kind === 'none'
    ? { status: 'ok' }
    : { status: 'needsUser', reason: 'login-required' }
}

/** The output as it is, or, past the cap, its JSON text cut with a marker. */
function clipOutput(value: unknown): unknown {
  const text = JSON.stringify(value) ?? 'null'
  if (text.length <= TRIAL_LIMITS.outputChars) return value
  return { truncatedJson: text.slice(0, TRIAL_LIMITS.outputChars), totalChars: text.length }
}
