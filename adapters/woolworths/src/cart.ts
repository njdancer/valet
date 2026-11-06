// Cart tools. Each one runs under withLogin (login.ts): session.ensure() first, because an anonymous
// trolley is a different trolley and writing to it would look like success and do nothing for the
// person; then, if the session expires partway, one more ensure() and a retry from the start.
//
// The update endpoint sets absolute quantities (community code; unverified live), so add_to_cart
// reads the current quantity first. That read is the only extra call any cart tool makes. Nothing
// here serialises that read-modify-write: the runtime must run a site's write tools one at a time
// (README, core change requests). What the adapter can do is report the quantity the site stored,
// not the one it asked for, and say when they differ.

import { SiteAdapterError, type ToolContext, tool } from '@siteadapter/core'
import { z } from 'zod'
import { withLogin } from './login'
import { productName, stockcodeSchema } from './products'
import { getJson, PATHS, postJson } from './site'
import { cents, text } from './text'
import {
  type ProductTileWire,
  productTileWire,
  supplyLimitGroupWire,
  type TrolleyWire,
  trolleyWire,
  updateStatusWire,
} from './wire'

/** Per-line ceiling. The site has its own supply limits (often 36) and clamps to them. */
export const MAX_LINE_QUANTITY = 50

/** Why a line is set aside from the buyable items, one per trolley bucket. */
export const UNAVAILABLE_REASONS = [
  'unavailable',
  'over-supply-limit',
  'over-stock-limit',
  'conflicted',
  'restricted',
  'restricted-crowd-delivery',
  'restricted-deli-platters',
  'restricted-delivery-method',
  'needs-id-verification',
  'restricted-seller-delivery',
] as const
type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

/** Buckets of plain product tiles, and the reason each one stands for. */
const TILE_BUCKETS = [
  ['ExceededAtpLimitItems', 'over-stock-limit'],
  ['ConflictedItems', 'conflicted'],
  ['RestrictedItems', 'restricted'],
  ['RestrictedByCrowdDeliveryItems', 'restricted-crowd-delivery'],
  ['RestrictedByDeliPlattersItems', 'restricted-deli-platters'],
  ['RestrictedByDeliveryMethodItems', 'restricted-delivery-method'],
  ['RestrictedByIdVerificationItems', 'needs-id-verification'],
  ['RestrictedBySellerDeliverabilityItems', 'restricted-seller-delivery'],
] as const satisfies readonly (readonly [keyof TrolleyWire, UnavailableReason])[]

/** The adapter's own notes. Fixed text, so no page text reaches the client through them. */
export const NOTICES = {
  incomplete:
    'Some items in this cart are in a form this adapter cannot read yet, so they are not listed. Check the cart on the Woolworths site.',
  unconfirmed:
    'The site did not send back the cart, so the change is unconfirmed. Call get_cart to check it.',
  lineUnreadable:
    "The site's reply does not show this product in a form this adapter can read. Check the cart on the Woolworths site.",
  differs: (stored: number, requested: number) =>
    `The site stored ${stored}, not the ${requested} asked for. It may limit how many of this product an order can have, or the cart changed at the same time.`,
} as const

const cartItemSchema = z.object({
  stockcode: z.number().int(),
  name: z.string(),
  quantity: z.number(),
  price: z.number().nullable(),
  lineTotal: z.number().nullable(),
  available: z.boolean(),
})

const unavailableItemSchema = cartItemSchema.extend({ reason: z.enum(UNAVAILABLE_REASONS) })

export const cartSchema = z.object({
  items: z.array(cartItemSchema),
  /** Items set aside from the buyable ones, with the site's reason; they may not be in the subtotal. */
  unavailable: z.array(unavailableItemSchema),
  subtotal: z.number(),
  savings: z.number(),
  /** Distinct products in the cart, as the site counts them. */
  itemCount: z.number().int(),
  /** Units across all products, as the site counts them. */
  totalQuantity: z.number().int(),
  /** The site's own notes about the cart, e.g. a minimum spend, then the adapter's. */
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

interface TrolleyRead {
  readonly cart: Cart
  /** Quantity per stockcode, for every line read exactly once. */
  readonly quantities: ReadonlyMap<number, number>
  /**
   * False when some line couldn't be read, a stockcode sat in two buckets, or the lines read don't
   * add up to the site's own count. A stockcode missing from `quantities` may then still be there.
   */
  readonly complete: boolean
}

function readTrolley(trolley: TrolleyWire): TrolleyRead {
  const unavailable: { tile: ProductTileWire; reason: UnavailableReason }[] = []
  let unreadable = 0
  for (const tile of trolley.UnavailableItems) unavailable.push({ tile, reason: 'unavailable' })
  for (const element of trolley.ExceededSupplyLimitGroups ?? []) {
    const group = supplyLimitGroupWire.safeParse(element)
    if (!group.success) unreadable++
    else for (const tile of group.data.Items) unavailable.push({ tile, reason: 'over-supply-limit' })
  }
  for (const [bucket, reason] of TILE_BUCKETS) {
    for (const element of trolley[bucket] ?? []) {
      const tile = productTileWire.safeParse(element)
      if (tile.success) unavailable.push({ tile: tile.data, reason })
      else unreadable++
    }
  }
  // What a bundle line looks like, and whether it is one line or several, is unknown.
  unreadable += trolley.BundleItems?.length ?? 0

  const counts = new Map<number, number>()
  const quantities = new Map<number, number>()
  for (const tile of [...trolley.AvailableItems, ...unavailable.map((line) => line.tile)]) {
    counts.set(tile.Stockcode, (counts.get(tile.Stockcode) ?? 0) + 1)
    quantities.set(tile.Stockcode, tile.QuantityInTrolley ?? 0)
  }
  for (const [stockcode, count] of counts) if (count > 1) quantities.delete(stockcode)
  const complete =
    unreadable === 0 && quantities.size === counts.size && counts.size === trolley.TrolleyItemCount

  const notices: string[] = []
  for (const error of trolley.Errors ?? []) {
    const message = text(error.Message)
    if (message !== null) notices.push(message)
  }
  if (!complete) notices.push(NOTICES.incomplete)
  const cart: Cart = {
    items: trolley.AvailableItems.map((tile) => toCartItem(tile, true)),
    unavailable: unavailable.map(({ tile, reason }) => ({ ...toCartItem(tile, false), reason })),
    subtotal: trolley.Totals.SubTotal,
    savings: trolley.Totals.TotalSavings,
    itemCount: trolley.TrolleyItemCount,
    totalQuantity: trolley.TotalTrolleyItemQuantity,
    notices,
  }
  return { cart, quantities, complete }
}

/** A 2xx whose body says the site refused the change. */
function reportsRejection(body: unknown, isTrolley: boolean): boolean {
  const reply = updateStatusWire.safeParse(body)
  if (!reply.success) return false
  if (reply.data.Success === false) return true
  // A trolley's Errors are cart notices such as a minimum spend; anything else's are a refusal.
  return !isTrolley && (reply.data.Errors?.length ?? 0) > 0
}

interface WriteOutcome {
  readonly quantity: number | null
  readonly confirmed: boolean
  readonly cart: Cart | null
  readonly notices: string[]
}

/**
 * Sets one line's absolute quantity, and reports what the site stored. The response is assumed to
 * be the updated trolley; when it isn't, the write is reported as unconfirmed rather than spending
 * another request to fetch the cart.
 */
async function setQuantity(ctx: ToolContext, stockcode: number, requested: number): Promise<WriteOutcome> {
  const body = await postJson(
    ctx,
    PATHS.trolleyUpdate,
    { items: [{ stockcode, quantity: requested }] },
    z.unknown(),
  )
  const trolley = trolleyWire.safeParse(body)
  if (reportsRejection(body, trolley.success)) throw new SiteAdapterError('tool-run', 'invalid')
  if (!trolley.success)
    return { quantity: null, confirmed: false, cart: null, notices: [NOTICES.unconfirmed] }
  const read = readTrolley(trolley.data)
  // A line the reply doesn't show was removed, unless the reply has lines the adapter can't read.
  const stored = read.quantities.get(stockcode) ?? (read.complete ? 0 : null)
  if (stored === null)
    return { quantity: null, confirmed: false, cart: read.cart, notices: [NOTICES.lineUnreadable] }
  const notices = stored === requested ? [] : [NOTICES.differs(stored, requested)]
  return { quantity: stored, confirmed: true, cart: read.cart, notices }
}

const writeOutput = {
  stockcode: z.number().int(),
  /** The line's quantity in the cart the site sent back. Null when the reply didn't show it. */
  quantity: z.number().nullable(),
  /** True when `quantity` is the site's own. False means the change may or may not have happened. */
  confirmed: z.boolean(),
  /** The cart the site sent back, or null. */
  cart: cartSchema.nullable(),
  /** The adapter's notes on the write, e.g. that the site stored less than was asked for. */
  notices: z.array(z.string()),
}

export const getCart = tool({
  input: z.object({}),
  output: cartSchema,
  async run(ctx) {
    return withLogin(ctx, async () => readTrolley(await getJson(ctx, PATHS.trolley, trolleyWire)).cart)
  },
})

export const addToCart = tool({
  input: z.object({
    stockcode: stockcodeSchema,
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY).default(1),
  }),
  output: z.object({
    ...writeOutput,
    previousQuantity: z.number(),
    /** previousQuantity plus the quantity added: what the write asked the site to store. */
    requestedQuantity: z.number(),
  }),
  async run(ctx, input) {
    return withLogin(ctx, async () => {
      const read = readTrolley(await getJson(ctx, PATHS.trolley, trolleyWire))
      // The write replaces the line's quantity, so a line hidden in a bucket the adapter can't read
      // would be overwritten with just the added amount. Refuse rather than shrink it.
      if (!read.complete) throw new SiteAdapterError('tool-run', 'invalid')
      const previousQuantity = read.quantities.get(input.stockcode) ?? 0
      const requestedQuantity = previousQuantity + input.quantity
      if (requestedQuantity > MAX_LINE_QUANTITY) throw new SiteAdapterError('tool-input', 'invalid')
      const outcome = await setQuantity(ctx, input.stockcode, requestedQuantity)
      return { stockcode: input.stockcode, previousQuantity, requestedQuantity, ...outcome }
    })
  },
})

export const setCartQuantity = tool({
  input: z.object({
    stockcode: stockcodeSchema,
    quantity: z.number().int().min(0).max(MAX_LINE_QUANTITY),
  }),
  output: z.object({ ...writeOutput, requestedQuantity: z.number() }),
  async run(ctx, input) {
    const outcome = await withLogin(ctx, () => setQuantity(ctx, input.stockcode, input.quantity))
    return { stockcode: input.stockcode, requestedQuantity: input.quantity, ...outcome }
  },
})

export const removeFromCart = tool({
  input: z.object({ stockcode: stockcodeSchema }),
  output: z.object({
    ...writeOutput,
    /** Whether the cart the site sent back is without the product. Null when unconfirmed. */
    removed: z.boolean().nullable(),
  }),
  async run(ctx, input) {
    const outcome = await withLogin(ctx, () => setQuantity(ctx, input.stockcode, 0))
    const removed = outcome.quantity === null ? null : outcome.quantity === 0
    return { stockcode: input.stockcode, removed, ...outcome }
  },
})
