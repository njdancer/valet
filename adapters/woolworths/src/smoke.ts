// The live smoke test's run, apart from the browser it runs in (smoke/ supplies a real tool page).
// Three paced reads, each checked by drift detection. It stops at the first sign of the site
// refusing us: a block costs a day, and the plan says to stop and wait (plan.md, "Live smoke
// tests"). The result holds paths, types and status codes, never a value, so it can be kept.

import { type DriftReport, describeShape, type FetchResult, type Shape } from '@valet/core'
import { checkResponse, type DriftEndpoint, firstStockcode, SMOKE_PLAN, type SmokeRequest } from './drift'

export interface SmokeStep {
  readonly endpoint: DriftEndpoint
  readonly method: string
  readonly path: string
  readonly status: number
  /** Null when the body wasn't JSON. */
  readonly report: DriftReport | null
  /** Keys and types of the body, for comparing runs. Null when it wasn't JSON. */
  readonly shape: Shape | null
}

export type SmokeStop =
  /** A 403, 429 or HTML answer: Akamai or a login page. Stop for the day. */
  | { readonly reason: 'blocked'; readonly status: number }
  /** Any other non-2xx, or a body that isn't JSON. */
  | { readonly reason: 'unavailable'; readonly status: number }
  /** fetch() threw: the driver refused the request or the network failed. Only the class is kept. */
  | { readonly reason: 'refused' }
  /** The search found nothing, so there is no product to read the detail of. */
  | { readonly reason: 'no-product' }

export interface SmokeResult {
  readonly steps: readonly SmokeStep[]
  /** Why the run ended early, or null when all three reads happened. */
  readonly stopped: SmokeStop | null
  /** True when every read happened and drift detection found nothing. */
  readonly ok: boolean
}

export interface SmokeOptions {
  /** The tool page's fetch, under the manifest's request surface. */
  readonly fetch: (path: string, init: SmokeRequest['init']) => Promise<FetchResult>
  /** Time between reads. The live run uses the site's own pacing (10 s for Woolworths). */
  readonly gapMs: number
  readonly sleep?: (ms: number) => Promise<void>
  /** The search term. One common word, so the search finds something. */
  readonly query?: string
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const sleep = options.sleep ?? defaultSleep
  const steps: SmokeStep[] = []
  const finish = (stopped: SmokeStop | null): SmokeResult => ({
    steps,
    stopped,
    ok: stopped === null && steps.every((step) => step.report?.ok === true),
  })

  const read = async (request: SmokeRequest): Promise<{ body: unknown } | { stop: SmokeStop }> => {
    let result: FetchResult
    try {
      result = await options.fetch(request.path, request.init)
    } catch {
      return { stop: { reason: 'refused' } }
    }
    const method = request.init.method ?? 'GET'
    const json = (result.contentType ?? '').toLowerCase().includes('json')
    const html = (result.contentType ?? '').toLowerCase().includes('html')
    const ok = result.status >= 200 && result.status < 300
    steps.push({
      endpoint: request.endpoint,
      method,
      path: request.path,
      status: result.status,
      report: ok && json ? checkResponse(request.endpoint, result.body) : null,
      shape: json ? describeShape(result.body) : null,
    })
    if (result.status === 403 || result.status === 429 || (ok && html)) {
      return { stop: { reason: 'blocked', status: result.status } }
    }
    if (!ok || !json) return { stop: { reason: 'unavailable', status: result.status } }
    return { body: result.body }
  }

  const search = await read(SMOKE_PLAN.search(options.query ?? 'milk'))
  if ('stop' in search) return finish(search.stop)
  const stockcode = firstStockcode(search.body)
  if (stockcode === null) return finish({ reason: 'no-product' })
  await sleep(options.gapMs)
  const detail = await read(SMOKE_PLAN.productDetail(stockcode))
  if ('stop' in detail) return finish(detail.stop)
  await sleep(options.gapMs)
  const trolley = await read(SMOKE_PLAN.trolley())
  if ('stop' in trolley) return finish(trolley.stop)
  return finish(null)
}
