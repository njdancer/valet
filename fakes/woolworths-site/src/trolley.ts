// Trolley state and the two trolley endpoints' response bodies. The live probe only saw an empty
// trolley, so the envelope is real but the item shape (a product plus Quantity) is an assumption
// still to be confirmed against a logged-in capture.

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

export type UpdateOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

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
  return { ok: true }
}

export function trolleyLines(trolley: Trolley): TrolleyLine[] {
  return [...trolley].map(([stockcode, quantity]) => ({ stockcode, quantity }))
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
    const item: JsonObject = {
      ...product,
      Quantity: quantity,
      QuantityInTrolley: quantity,
      IsInTrolley: true,
    }
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
