// Trolley state and the two trolley endpoints' response bodies. The envelope is from an anonymous
// capture; the line prices and the update reply's shape are from signed-in traces (2026-11-27): a
// trolley line has no Price but UnitSalePrice (one unit) and SalePrice (the line), and an update is
// answered with only the lines it changed.

import { findProduct, money, roundMoney } from './catalogue'
import { emptyTrolleyTemplate, type JsonObject, type TrolleyBody } from './fixtures'

/** Stockcode to quantity, in the order items were first added. */
export type Trolley = Map<number, number>

export interface TrolleyLine {
  readonly stockcode: number
  readonly quantity: number
}

/** Pick up's minimum spend, in dollars. */
export const MINIMUM_SPEND = 50

export type UpdateOutcome =
  | { readonly ok: true; readonly changed: readonly number[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Applies a `POST /api/v3/ui/trolley/update` body. The whole update is validated before anything
 * changes, so a bad item leaves the trolley untouched. Quantities above a product's supply limit
 * are reduced to it, as the site does.
 */
export function applyTrolleyUpdate(trolley: Trolley, body: unknown): UpdateOutcome {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'body' }
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: 'items' }
  const changes: [number, number][] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return { ok: false, reason: 'item' }
    const { stockcode, quantity } = item as { stockcode?: unknown; quantity?: unknown }
    if (typeof stockcode !== 'number' || !Number.isInteger(stockcode))
      return { ok: false, reason: 'stockcode' }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
      return { ok: false, reason: 'quantity' }
    }
    const product = findProduct(stockcode)
    if (product === null) return { ok: false, reason: 'unknown-product' }
    changes.push([stockcode, Math.min(quantity, product.SupplyLimit)])
  }
  for (const [stockcode, quantity] of changes) {
    if (quantity === 0) trolley.delete(stockcode)
    else trolley.set(stockcode, quantity)
  }
  return { ok: true, changed: changes.map(([stockcode]) => stockcode) }
}

export function trolleyLines(trolley: Trolley): TrolleyLine[] {
  return [...trolley].map(([stockcode, quantity]) => ({ stockcode, quantity }))
}

/** A trolley line as the live site sends it: no Price, but the unit's and the line's prices. */
function trolleyItem(product: NonNullable<ReturnType<typeof findProduct>>, quantity: number): JsonObject {
  const { Price: _price, ...rest } = product
  return {
    ...rest,
    Quantity: quantity,
    QuantityInTrolley: quantity,
    IsInTrolley: true,
    UnitSalePrice: product.Price,
    SalePrice: roundMoney(product.Price * quantity),
    ListPrice: roundMoney(product.WasPrice * quantity),
  }
}

/**
 * The `POST /api/v3/ui/trolley/update` body, as the live site answers it: the lines the update
 * changed that are still in the trolley (a line set to 0 is left out), and the trolley's totals.
 */
export function trolleyUpdateResponse(trolley: Trolley, changed: readonly number[]): JsonObject {
  const whole = trolleyResponse(trolley)
  const updated: JsonObject[] = []
  for (const stockcode of changed) {
    const quantity = trolley.get(stockcode)
    const product = findProduct(stockcode)
    if (quantity !== undefined && product !== null) updated.push(trolleyItem(product, quantity))
  }
  return {
    Message: null,
    UpdatedItems: updated,
    DeliveryFee: { Total: 0 },
    PotentialOrderPromotions: [],
    Totals: whole.Totals,
    TotalTrolleyItemQuantity: whole.TotalTrolleyItemQuantity,
    TrolleyItemCount: whole.TrolleyItemCount,
  }
}

/** The `GET /apis/ui/Trolley` body for a trolley, in the captured envelope. */
export function trolleyResponse(trolley: Trolley): TrolleyBody {
  const response = emptyTrolleyTemplate()
  const available: JsonObject[] = []
  const unavailable: JsonObject[] = []
  let subTotal = 0
  let savings = 0
  let quantityTotal = 0

  for (const [stockcode, quantity] of trolley) {
    const product = findProduct(stockcode)
    if (product === null) continue
    const item = trolleyItem(product, quantity)
    quantityTotal += quantity
    if (product.IsAvailable) {
      available.push(item)
      subTotal += product.Price * quantity
      savings += (product.WasPrice - product.Price) * quantity
    } else {
      unavailable.push(item)
    }
  }

  subTotal = roundMoney(subTotal)
  savings = roundMoney(savings)
  response.AvailableItems = available
  response.UnavailableItems = unavailable
  response.Totals = {
    ...response.Totals,
    SubTotal: subTotal,
    Total: subTotal,
    TotalSavings: savings,
    WoolworthsDiscountableSubTotal: subTotal,
    WoolworthsSubTotal: subTotal,
    WoolworthsTotal: subTotal,
  }
  response.TotalTrolleyItemQuantity = quantityTotal
  response.TotalWowDeliveryTrolleyItemQuantity = quantityTotal
  response.TrolleyItemCount = available.length + unavailable.length
  response.Errors =
    subTotal < MINIMUM_SPEND
      ? [
          {
            Type: 'InvalidSubtotal',
            Message: `Pick up has a $${MINIMUM_SPEND} minimum spend. Add ${money(MINIMUM_SPEND - subTotal)} of Woolworths items to continue.`,
            ErrorCode: null,
          },
        ]
      : []
  return response
}
