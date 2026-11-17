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

import {
  type AdapterManifest,
  type BlockedRequest,
  type EnsureResult,
  rawEndpoints,
  runtimeOf,
  type SessionDriver,
  type ToolContext,
  uploadBudget,
  ValetError,
} from '@valet/core'
import { type OpenTunnels, type RunContext, RunMeter } from '@valet/egress'
import {
  breakerRefusal,
  CallState,
  GuardedHttp,
  GuardedToolPage,
  type HttpEgress,
  NO_HTTP_ACCESS,
  NO_PAGE,
  NO_SECRETS,
  noBrowserDriver,
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
  /**
   * A driver for the manifest whose partitions are in memory and new: the label names them. For a
   * signed-in trial, the installed adapter's session is copied into them one way.
   */
  readonly driver: (
    manifest: AdapterManifest,
    label: string,
    signedIn: SignedInTrial | null,
  ) => Promise<SessionDriver>
  /** The installed adapters' guards for the host (ToolHost.siteGuards). */
  readonly guards: (host: string) => SiteGuards
  /**
   * The egress broker for a draft that isn't a browser adapter, built from the endpoints it is
   * given. Without it, such a draft's ctx.http is not granted.
   */
  readonly egress?: (endpoints: { readonly egress: readonly string[] }) => HttpEgress
  /**
   * A raw draft's runtime (docs/adapter-kinds.md#raw): its Node process for one call, and the
   * broker's tunnels for the public endpoints it is given. Without it, a raw draft can't be tried.
   */
  readonly raw?: {
    start(manifest: AdapterManifest, openTunnels: OpenTunnels): ToolProcessFactory
    tunnels(
      endpoints: readonly string[],
    ): (run: RunContext, options: { readonly admit: () => Promise<void> }) => OpenTunnels
  }
  readonly timeoutMs?: number
}

/**
 * A signed-in trial (docs/authoring-tools.md#signed-in-authoring-sessions-pr-3), while the person's
 * authoring-session approval lasts: the installed manifest, which the person approved, bounds what
 * reaches the session.
 */
export interface SignedInTrial {
  readonly adapterId: string
  readonly installed: AdapterManifest
}

export type TrialOutcome =
  | { readonly kind: 'output'; readonly output: unknown }
  | { readonly kind: 'error'; readonly stage: string; readonly errorClass: string }
  | { readonly kind: 'needs-user'; readonly reason: string }
  | { readonly kind: 'invalid-output' }
  /** A signed-in trial's output held a value of the session: withheld. */
  | { readonly kind: 'session-value' }
  | { readonly kind: 'timeout' }
  /** The site's breaker is open, or its hourly cap is spent: nothing was sent. */
  | { readonly kind: 'site-resting'; readonly retryAfterMs: number }

export interface TrialBlocked {
  readonly method: string
  readonly url: string
  readonly reason: string
  /** Tool code (fetch, goto, opening home) or the site's own page. */
  readonly initiator: 'tool' | 'page'
}

export interface TrialResult {
  readonly outcome: TrialOutcome
  /**
   * Every request refused, scrubbed of ids: what an agent fixes egress and requests from. The
   * runtime's refusals of tool code's own fetch and goto (reason an error class, such as
   * `undeclared-request`) and the browser's of anything else (reason a block reason, such as
   * `host-not-allowed` or `undeclared`), opening home included.
   */
  readonly blocked: readonly TrialBlocked[]
  /** How many were refused, past the TRIAL_LIMITS.blocked listed too. */
  readonly blockedCount: number
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
  signedIn: SignedInTrial | null = null,
): Promise<TrialResult> {
  const started = now()
  const manifest = draft.manifest
  const declared = manifest.tools.find((t) => t.name === tool)
  const schemas = draft.tools[tool]
  if (declared === undefined || schemas === undefined || declared.sideEffect !== 'read')
    throw new Error('runTrial is for a declared read tool')
  const site = deps.guards(new URL(manifest.home).hostname)
  const blocked: TrialBlocked[] = []
  let blockedCount = 0
  const done = (outcome: TrialOutcome): TrialResult => ({
    outcome,
    blocked,
    blockedCount,
    ms: now() - started,
  })
  if (site.breaker.isOpen())
    return done({ kind: 'site-resting', retryAfterMs: site.breaker.status().retryAfterMs })
  // The hourly cap, asked about once before anything is sent, as an installed call's is.
  const spentForMs = site.budget.spentForMs()
  if (spentForMs > 0) return done({ kind: 'site-resting', retryAfterMs: spentForMs })

  const policy = trialPolicy(manifest, signedIn)
  // An http draft opens no browser. Its trial reaches the draft's public hosts only: an address on
  // the person's network waits for their approval of the adapter (docs/adapter-kinds.md).
  const http = runtimeOf(manifest) !== 'browser'
  const driver = http ? noBrowserDriver() : await deps.driver(manifest, label, signedIn)
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
    const record = (b: Omit<BlockedRequest, 'reason'> & { readonly reason: string }): void => {
      blockedCount++
      if (blocked.length < TRIAL_LIMITS.blocked)
        blocked.push({ method: b.method, url: scrubUrl(b.target), reason: b.reason, initiator: b.initiator })
    }
    driver.beginRun(
      { ...policy, unlocks: [], maxPurpose: 'read', ceiling: manifest.limits.requestsPerRun },
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
      if (runtimeOf(manifest) === 'raw') {
        // Its public endpoints only, a read's upload budget whatever the tool, the site's pace per
        // connection, and no credential: unapproved code is never entrusted with one.
        const raw = deps.raw
        if (raw === undefined) throw new ValetError('tool-run', 'unavailable')
        const publicOnly: AdapterManifest = { ...manifest, privateHosts: [] }
        const endpoints = rawEndpoints(publicOnly)
        const runContext: RunContext = {
          meter: new RunMeter(uploadBudget(manifest, 'read')),
          signal: controller.signal,
          record: (c) => {
            if (c.errorClass === null) return
            record({
              method: 'CONNECT',
              target: `tcp://${c.endpoint}`,
              reason: c.errorClass,
              initiator: 'tool',
            })
            if (
              c.errorClass === 'upload-budget' ||
              c.errorClass === 'sni-mismatch' ||
              c.errorClass === 'host-not-allowed'
            )
              state.violation ??= new ValetError('egress', c.errorClass)
          },
        }
        let connections = 0
        const admit = async (): Promise<void> => {
          if (++connections > manifest.limits.requestsPerRun) {
            state.violation ??= new ValetError('request-surface', 'request-ceiling')
            throw state.violation
          }
          if (site.breaker.isOpen()) throw breakerRefusal()
          await site.budget.acquire(controller.signal)
        }
        const rawCtx: ToolContext = {
          page: NO_PAGE,
          session: { ensure: async (): Promise<EnsureResult> => ({ status: 'ok' }) },
          confirm: async () => false,
          signal: controller.signal,
          local: NO_LOCAL_ACCESS,
          http: NO_HTTP_ACCESS,
          secrets: NO_SECRETS,
        }
        return runIsolated(
          raw.start(publicOnly, (asked) => raw.tunnels(endpoints)(runContext, { admit })(asked)),
          draft.script,
          rawCtx,
          tool,
          input,
        )
      }
      if (http) {
        const publicOnly: AdapterManifest = { ...manifest, privateHosts: [] }
        const httpCtx: ToolContext = {
          page: NO_PAGE,
          session: { ensure: async (): Promise<EnsureResult> => ({ status: 'ok' }) },
          confirm: async () => false,
          signal: controller.signal,
          local: NO_LOCAL_ACCESS,
          http:
            deps.egress === undefined
              ? NO_HTTP_ACCESS
              : new GuardedHttp({
                  adapterId: manifest.id,
                  manifest: publicOnly,
                  sideEffect: 'read',
                  unlocks: [],
                  site,
                  state,
                  audit: async (event) => {
                    if (event.type === 'request-blocked')
                      record({
                        method: event.method,
                        target: event.target,
                        reason: event.reason,
                        initiator: 'tool',
                      })
                  },
                  broker: deps.egress({ egress: policy.egress }),
                  run: {
                    meter: new RunMeter(uploadBudget(manifest, 'read')),
                    signal: controller.signal,
                    record: () => {},
                  },
                }),
        }
        return runIsolated(deps.start, draft.script, httpCtx, tool, input)
      }
      const inner = await driver.toolPage()
      const page = new GuardedToolPage({
        adapterId: manifest.id,
        manifest,
        sideEffect: 'read',
        unlocks: [],
        inner,
        site,
        state,
        // The guard refuses tool code's own requests before the browser sees them: list those too.
        audit: async (event) => {
          if (event.type === 'request-blocked')
            record({ method: event.method, target: event.target, reason: event.reason, initiator: 'tool' })
        },
      })
      const ctx: ToolContext = {
        page,
        session: {
          ensure: async (): Promise<EnsureResult> =>
            signedIn === null ? signedOut(manifest) : { status: 'ok' },
        },
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
    if (signedIn !== null) {
      // The agent never sees a cookie: output holding one is withheld whole.
      const text = JSON.stringify(output.data) ?? ''
      const secrets = await driver.sessionSecrets(
        signedIn.installed.session.cookieDomains,
        signedIn.installed.session.storage,
      )
      if (secrets.some((value) => value.length >= 6 && text.includes(value)))
        return done({ kind: 'session-value' })
    }
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

/**
 * What the trial may send. Signed out: the draft's own egress and read declarations. Signed in:
 * only what the installed manifest also allows, and only GETs it declares read, so nothing the
 * agent wrote widens what reaches the person's session.
 */
function trialPolicy(
  manifest: AdapterManifest,
  signedIn: SignedInTrial | null,
): { readonly egress: readonly string[]; readonly requests: AdapterManifest['requests'] } {
  const reads = manifest.requests.filter((r) => r.purpose === 'read')
  if (signedIn === null) return { egress: manifest.egress, requests: reads }
  const installed = signedIn.installed
  const allowedReads = installed.requests.filter((r) => r.purpose === 'read' && r.method === 'GET')
  return {
    egress: manifest.egress.filter((host) => installed.egress.includes(host)),
    requests: reads.filter((r) =>
      allowedReads.some((a) => a.method === r.method && a.path === r.path && a.host === r.host),
    ),
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
