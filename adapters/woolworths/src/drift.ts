// Drift detection for the Woolworths API (M4). Each read endpoint the tools call is checked against
// the same zod schema the tool parses it with, plus the per-item schemas the trolley's unconfirmed
// buckets are read with one by one. The fixture tests, the fake site's tests and the gated live
// smoke test (smoke/) all go through checkResponse(), so the three can't disagree about what counts
// as drift. A report has paths and type names, never values.

import { checkShape, type DriftReport, type FetchInit, mergeReports } from '@valet/core'
import { TILE_BUCKETS } from './cart'
import { searchRequest } from './products'
import { PATHS } from './site'
import { productDetailWire, productTileWire, searchWire, supplyLimitGroupWire, trolleyWire } from './wire'

export const DRIFT_ENDPOINTS = ['search', 'productDetail', 'trolley'] as const
export type DriftEndpoint = (typeof DRIFT_ENDPOINTS)[number]

/** Checks one response body from `endpoint` against what the adapter reads it with. */
export function checkResponse(endpoint: DriftEndpoint, body: unknown): DriftReport {
  switch (endpoint) {
    case 'search':
      return checkShape(searchWire, body)
    case 'productDetail':
      return checkShape(productDetailWire, body)
    case 'trolley':
      return checkTrolley(body)
  }
}

/**
 * The trolley's buckets other than AvailableItems and UnavailableItems are read item by item, so
 * the tool survives an item it can't read (it says the cart is incomplete). Drift detection reads
 * them the same way and reports each unreadable item. BundleItems has no schema yet: any bundle
 * line is reported, since nobody has seen one.
 */
function checkTrolley(body: unknown): DriftReport {
  const whole = checkShape(trolleyWire, body)
  const parsed = trolleyWire.safeParse(body)
  if (!parsed.success) return whole
  const parts = [{ at: '', report: whole }]
  const trolley = parsed.data
  for (const element of trolley.ExceededSupplyLimitGroups ?? []) {
    parts.push({ at: 'ExceededSupplyLimitGroups[]', report: checkShape(supplyLimitGroupWire, element) })
  }
  for (const [bucket] of TILE_BUCKETS) {
    for (const element of trolley[bucket] ?? []) {
      parts.push({ at: `${bucket}[]`, report: checkShape(productTileWire, element) })
    }
  }
  if ((trolley.BundleItems?.length ?? 0) > 0) {
    parts.push({
      at: 'BundleItems[]',
      report: {
        ok: false,
        issues: [{ path: '(root)', code: 'no_schema', expected: null, received: 'object' }],
        absent: [],
      },
    })
  }
  return mergeReports(parts)
}

/** One read the live smoke test makes, exactly as the tool makes it. */
export interface SmokeRequest {
  readonly endpoint: DriftEndpoint
  readonly path: string
  readonly init: FetchInit
}

/**
 * The smoke test's reads, in order: a small search, the detail of the first product it found, and
 * the trolley. All read-only, all declared `read` in the manifest. Three requests.
 */
export const SMOKE_PLAN = {
  search: (query: string): SmokeRequest => ({
    endpoint: 'search',
    path: PATHS.search,
    init: { method: 'POST', json: searchRequest({ query, page: 1, pageSize: 3, specialsOnly: false }) },
  }),
  productDetail: (stockcode: number): SmokeRequest => ({
    endpoint: 'productDetail',
    path: PATHS.productDetail(stockcode),
    init: { method: 'GET' },
  }),
  trolley: (): SmokeRequest => ({ endpoint: 'trolley', path: PATHS.trolley, init: { method: 'GET' } }),
} as const

/**
 * The first stockcode in a search response, for the detail request, or null. Read loosely, so a
 * search that drifted still leads to a detail read and the report covers every endpoint.
 */
export function firstStockcode(body: unknown): number | null {
  const groups = field(body, 'Products')
  if (!Array.isArray(groups)) return null
  for (const group of groups) {
    const products = field(group, 'Products')
    if (!Array.isArray(products)) continue
    for (const product of products) {
      const code = Number(field(product, 'Stockcode'))
      if (Number.isSafeInteger(code) && code > 0) return code
    }
  }
  return null
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined
}
