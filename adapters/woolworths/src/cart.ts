// Cart tools. Each one calls session.ensure() first, because an anonymous trolley is a different
// trolley: writing to it would look like success and do nothing for the person.
//
// The update endpoint sets absolute quantities (community code; unverified live), so add_to_cart
// reads the current quantity first. That read is the only extra call any cart tool makes.

import { SiteAdapterError, type ToolContext, tool } from '@siteadapter/core'
import { z } from 'zod'
import { requireLogin } from './login'
import { productName, stockcodeSchema } from './products'
import { getJson, PATHS, postJson } from './site'
import { cents, text } from './text'
import { type ProductTileWire, type TrolleyWire, trolleyWire } from './wire'

/** Per-line ceiling. The site has its own supply limits (often 36) and clamps to them. */
export const MAX_LINE_QUANTITY = 50

const cartItemSchema = z.object({
  stockcode: z.number().int(),
  name: z.string(),
  quantity: z.number(),
  price: z.number().nullable(),
  lineTotal: z.number().nullable(),
  available: z.boolean(),
})

export const cartSchema = z.object({
  items: z.array(cartItemSchema),
  /** Items in the cart that can't currently be bought; they are not in the subtotal. */
  unavailable: z.array(cartItemSchema),
  subtotal: z.number(),
  savings: z.number(),
  /** Distinct products in the cart. */
  itemCount: z.number().int(),
  /** Units across all products. */
  totalQuantity: z.number().int(),
  /** The site's own notes about the cart, e.g. a minimum spend. */
  notices: z.array(z.string()),
})
export type Cart = z.infer<typeof cartSchema>

function toCartItem(tile: ProductTileWire, available: boolean): Cart['items'][number] {
  const quantity = tile.QuantityInTrolley ?? 0
  const price = tile.Price ?? null
  return {
    stockcode: tile.Stockcode,
    name: productName(tile),
    quantity,
    price,
    lineTotal: price === null ? null : cents(price * quantity),
    available,
  }
}

export function toCart(trolley: TrolleyWire): Cart {
  const notices: string[] = []
  for (const error of trolley.Errors ?? []) {
    const message = text(error.Message)
    if (message !== null) notices.push(message)
  }
  return {
    items: trolley.AvailableItems.map((tile) => toCartItem(tile, true)),
    unavailable: trolley.UnavailableItems.map((tile) => toCartItem(tile, false)),
    subtotal: trolley.Totals.SubTotal,
    savings: trolley.Totals.TotalSavings,
    itemCount: trolley.TrolleyItemCount,
    totalQuantity: trolley.TotalTrolleyItemQuantity,
    notices,
  }
}

function quantityInTrolley(trolley: TrolleyWire, stockcode: number): number {
  const tile = [...trolley.AvailableItems, ...trolley.UnavailableItems].find((t) => t.Stockcode === stockcode)
  return tile?.QuantityInTrolley ?? 0
}

/**
 * Sets one line's absolute quantity. The response is assumed to be the updated trolley; when it
 * isn't, the cart is reported as null rather than spending another request to fetch it.
 */
async function setQuantity(ctx: ToolContext, stockcode: number, quantity: number): Promise<Cart | null> {
  const body = await postJson(ctx, PATHS.trolleyUpdate, { items: [{ stockcode, quantity }] }, z.unknown())
  const trolley = trolleyWire.safeParse(body)
  return trolley.success ? toCart(trolley.data) : null
}

/** The cart after a change, when the site sent it back. Null means call get_cart to see it. */
const cartAfterSchema = cartSchema.nullable()

export const getCart = tool({
  input: z.object({}),
  output: cartSchema,
  async run(ctx) {
    await requireLogin(ctx)
    return toCart(await getJson(ctx, PATHS.trolley, trolleyWire))
  },
})

export const addToCart = tool({
  input: z.object({
    stockcode: stockcodeSchema,
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY).default(1),
  }),
  output: z.object({
    stockcode: z.number().int(),
    previousQuantity: z.number(),
    quantity: z.number(),
    cart: cartAfterSchema,
  }),
  async run(ctx, input) {
    await requireLogin(ctx)
    const trolley = await getJson(ctx, PATHS.trolley, trolleyWire)
    const previousQuantity = quantityInTrolley(trolley, input.stockcode)
    const quantity = previousQuantity + input.quantity
    if (quantity > MAX_LINE_QUANTITY) throw new SiteAdapterError('tool-input', 'invalid')
    const cart = await setQuantity(ctx, input.stockcode, quantity)
    return { stockcode: input.stockcode, previousQuantity, quantity, cart }
  },
})

export const setCartQuantity = tool({
  input: z.object({
    stockcode: stockcodeSchema,
    quantity: z.number().int().min(0).max(MAX_LINE_QUANTITY),
  }),
  output: z.object({ stockcode: z.number().int(), quantity: z.number(), cart: cartAfterSchema }),
  async run(ctx, input) {
    await requireLogin(ctx)
    const cart = await setQuantity(ctx, input.stockcode, input.quantity)
    return { stockcode: input.stockcode, quantity: input.quantity, cart }
  },
})

export const removeFromCart = tool({
  input: z.object({ stockcode: stockcodeSchema }),
  output: z.object({ stockcode: z.number().int(), removed: z.literal(true), cart: cartAfterSchema }),
  async run(ctx, input) {
    await requireLogin(ctx)
    const cart = await setQuantity(ctx, input.stockcode, 0)
    return { stockcode: input.stockcode, removed: true as const, cart }
  },
})
