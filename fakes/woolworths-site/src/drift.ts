// Shape drift: the site changing what its API sends, as the real one will one day. Applied to the
// product-bearing API responses (search, product detail, trolley and its update) while switched on,
// so tests can see the adapter fail with site-changed rather than return wrong data, and drift
// detection name the field.

/**
 * `renamed-field`: every product's `Price` becomes `CurrentPrice`. The adapter's schema declares
 * Price nullish, so this still parses, and only drift detection's absent-field check notices.
 * `changed-type`: every product's `Stockcode` becomes a string, which the schema rejects.
 */
export type ShapeDrift = 'renamed-field' | 'changed-type'

export const SHAPE_DRIFTS: readonly ShapeDrift[] = ['renamed-field', 'changed-type']

export function applyShapeDrift(body: unknown, drift: ShapeDrift): unknown {
  if (Array.isArray(body)) return body.map((element) => applyShapeDrift(element, drift))
  if (body === null || typeof body !== 'object') return body
  const out: Record<string, unknown> = {}
  const isProduct = typeof (body as Record<string, unknown>)['Stockcode'] === 'number'
  for (const [key, value] of Object.entries(body)) {
    if (isProduct && drift === 'renamed-field' && key === 'Price') out['CurrentPrice'] = value
    else if (isProduct && drift === 'changed-type' && key === 'Stockcode') out[key] = String(value)
    else out[key] = applyShapeDrift(value, drift)
  }
  return out
}
