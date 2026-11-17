// Cart tools. Each one runs under withLogin (login.ts): session.ensure() first, because an anonymous
// trolley is a different trolley and writing to it would look like success and do nothing for the
// person; then, if the session expires partway, one more ensure() and a retry from the start.
//
// The update endpoint sets absolute quantities (community code; unverified live), so add_to_cart
// reads the current quantity first. That read is the only extra call any cart tool makes. Nothing
// here serialises that read-modify-write: the runtime must run a site's write tools one at a time
// (README, core change requests). What the adapter can do is report the quantity the site stored,
// not the one it asked for, and say when they differ.

import { httpsOriginOf, type InputPathSegment, type ToolContext, tool, urlOn, ValetError } from '@valet/core'
import { z } from 'zod'
import { withLogin } from './login'
import { productName, stockcodeSchema } from './products'
import { CART_PAGE, getHeldJson, getJson, PATHS, postJson } from './site'
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
export const MAX_LINE_QUANTITY = 20

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
export const TILE_BUCKETS = [
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
  /** `reason` is one of UNAVAILABLE_REASONS, never the site's text. */
  setAside: (reason: UnavailableReason) =>
    `The site put this product in the cart but set it aside (reason: ${reason}), so it is not in the subtotal and will not be in the order. It may be out of stock at this store: choose another product, or remove this one.`,
  notInCart: 'This product was not in the cart, so there was nothing to remove.',
} as const

const cartItemSchema = z.object({
  stockcode: z.number().int(),
  name: z.string(),
  quantity: z.number(),
  price: z.number().nullable().describe('Dollars for one unit. Null when the site gives none.'),
  lineTotal: z.number().nullable().describe('price times quantity, in dollars.'),
  available: z.boolean(),
})

const unavailableItemSchema = cartItemSchema.extend({
  reason: z.enum(UNAVAILABLE_REASONS).describe('Why the site set the line aside.'),
})

export const cartSchema = z.object({
  items: z.array(cartItemSchema).describe('The lines that will be in the order.'),
  /** Items set aside from the buyable ones, with the site's reason; they may not be in the subtotal. */
  unavailable: z
    .array(unavailableItemSchema)
    .describe(
      'Lines the site set aside (out of stock, over a limit, restricted), with its reason. They stay in the cart but are not in the subtotal and will not be in the order.',
    ),
  subtotal: z.number().describe('Dollars, for the lines in items only.'),
  savings: z.number().describe('Dollars saved on specials, for the lines in items only.'),
  /** Distinct products in the cart, as the site counts them. */
  itemCount: z.number().int().describe('Distinct products in the cart, set-aside lines included.'),
  /** Units across all products, as the site counts them. */
  totalQuantity: z.number().int().describe('Units across all products, set-aside lines included.'),
  /** The site's own notes about the cart, e.g. a minimum spend, then the adapter's. */
  notices: z
    .array(z.string())
    .describe("The site's own notes about the cart, such as a minimum spend, then this adapter's."),
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

interface LineOutcome {
  readonly quantity: number | null
  readonly confirmed: boolean
  readonly notices: string[]
}

/**
 * Sets each line's absolute quantity in one update request, and reports what the site stored for
 * each. The response is assumed to be the updated trolley; when it isn't, every line is reported as
 * unconfirmed rather than spending another request to fetch the cart.
 */
async function setQuantities(
  ctx: ToolContext,
  lines: readonly { readonly stockcode: number; readonly quantity: number }[],
  stockcodePath: (index: number) => readonly InputPathSegment[],
): Promise<{ readonly lines: LineOutcome[]; readonly cart: Cart | null; readonly notices: string[] }> {
  // The site answers an update it won't take with a 400 and "The request is invalid." The request is
  // the adapter's own, fixed but for the stockcodes and the quantities (checked already), so it is
  // most likely a stockcode the site doesn't know (the fake does exactly this; the live site's answer
  // is unverified). Told so, the agent looks the product up again rather than waiting on a site it
  // thinks is down. With several lines the site doesn't say which.
  const badRequest = new ValetError('tool-input', 'invalid', {
    path: lines.length === 1 ? stockcodePath(0) : ['items'],
    reason: 'not-accepted',
  })
  const body = await postJson(
    ctx,
    PATHS.trolleyUpdate,
    { items: lines.map(({ stockcode, quantity }) => ({ stockcode, quantity })) },
    z.unknown(),
    { badRequest },
  )
  const trolley = trolleyWire.safeParse(body)
  if (reportsRejection(body, trolley.success)) throw new ValetError('tool-run', 'invalid')
  if (!trolley.success) {
    const unconfirmed = { quantity: null, confirmed: false, notices: [NOTICES.unconfirmed] }
    return { lines: lines.map(() => unconfirmed), cart: null, notices: [NOTICES.unconfirmed] }
  }
  const read = readTrolley(trolley.data)
  const outcomes = lines.map(({ stockcode, quantity: requested }): LineOutcome => {
    // A line the reply doesn't show was removed, unless the reply has lines the adapter can't read.
    const stored = read.quantities.get(stockcode) ?? (read.complete ? 0 : null)
    if (stored === null) return { quantity: null, confirmed: false, notices: [NOTICES.lineUnreadable] }
    const notices = stored === requested ? [] : [NOTICES.differs(stored, requested)]
    // Stored, but set aside: out of stock, say. The write worked; the order won't have it.
    const aside = stored > 0 ? read.cart.unavailable.find((item) => item.stockcode === stockcode) : undefined
    if (aside !== undefined) notices.push(NOTICES.setAside(aside.reason))
    return { quantity: stored, confirmed: true, notices }
  })
  return { lines: outcomes, cart: read.cart, notices: [] }
}

/** Sets one line's absolute quantity, and reports what the site stored. */
async function setQuantity(ctx: ToolContext, stockcode: number, requested: number): Promise<WriteOutcome> {
  const { lines, cart } = await setQuantities(ctx, [{ stockcode, quantity: requested }], () => ['stockcode'])
  const [line] = lines as [LineOutcome]
  return { quantity: line.quantity, confirmed: line.confirmed, cart, notices: line.notices }
}

/**
 * The trolley an add starts from. The runtime may answer it from its session cache, which after a
 * cart write holds that write's own reply (D28), so a run of adds reads the trolley from the site
 * once. A cached answer this adapter can't fully read is not trusted: the site is asked instead.
 */
async function trolleyBeforeWrite(ctx: ToolContext): Promise<TrolleyRead> {
  const held = await getHeldJson(ctx, PATHS.trolley, trolleyWire)
  if (held !== null) {
    const read = readTrolley(held.data)
    if (read.complete || !held.fromCache) return read
  }
  return readTrolley(await getJson(ctx, PATHS.trolley, trolleyWire, { fresh: true }))
}

const writeOutput = {
  stockcode: z.number().int(),
  /** The line's quantity in the cart the site sent back. Null when the reply didn't show it. */
  quantity: z
    .number()
    .nullable()
    .describe("The line's quantity in the cart the site sent back. Null when the reply didn't show it."),
  /** True when `quantity` is the site's own. False means the change may or may not have happened. */
  confirmed: z
    .boolean()
    .describe(
      "True when quantity is what the site's reply shows. False: the change may or may not have happened, so call get_cart before trying again.",
    ),
  /** The cart the site sent back, or null. */
  cart: cartSchema.nullable().describe('The whole cart as the site sent it back, or null.'),
  /** The adapter's notes on the write, e.g. that the site stored less than was asked for. */
  notices: z
    .array(z.string())
    .describe('Notes on the write, e.g. that the site stored less than asked, or set the product aside.'),
}

/**
 * The trolley page on the site the tool page is on, or null when that isn't an https page. Built
 * from the page, not the manifest, because tool code never sees the manifest's options.
 */
function cartUrlOf(ctx: ToolContext): string | null {
  // Not `new URL`: the tool process has none (packages/core/src/tool-urls.ts).
  const origin = httpsOriginOf(ctx.page.currentUrl())
  return origin === null ? null : urlOn(origin, CART_PAGE)
}

export const getCart = tool({
  input: z.object({}),
  output: cartSchema.extend({
    /** The site's trolley page, for the person to check out in their own browser (D-checkout). */
    cartUrl: z
      .string()
      .nullable()
      .describe('The trolley page, where the person checks out in their own browser.'),
  }),
  async run(ctx) {
    // Always the site's own answer: this is the tool an agent checks the cart with.
    const cart = await withLogin(
      ctx,
      async () => readTrolley(await getJson(ctx, PATHS.trolley, trolleyWire, { fresh: true })).cart,
    )
    return { ...cart, cartUrl: cartUrlOf(ctx) }
  },
})

export const addToCart = tool({
  input: z.object({
    stockcode: stockcodeSchema,
    quantity: z
      .number()
      .int()
      .min(1)
      .max(MAX_LINE_QUANTITY)
      .default(1)
      .describe(
        `How many to add on top of any already in the cart (default 1). A line holds at most ${MAX_LINE_QUANTITY} of one product.`,
      ),
  }),
  output: z.object({
    ...writeOutput,
    previousQuantity: z.number().describe('The quantity in the cart before the call.'),
    /** previousQuantity plus the quantity added: what the write asked the site to store. */
    requestedQuantity: z.number().describe('previousQuantity plus the quantity added.'),
  }),
  async run(ctx, input) {
    return withLogin(ctx, async () => {
      const read = await trolleyBeforeWrite(ctx)
      // The write replaces the line's quantity, so a line hidden in a bucket the adapter can't read
      // would be overwritten with just the added amount. Refuse rather than shrink it. A line the
      // adapter can't read means the trolley's item shape isn't the one it expects.
      if (!read.complete) throw new ValetError('tool-run', 'site-changed')
      const previousQuantity = read.quantities.get(input.stockcode) ?? 0
      const requestedQuantity = previousQuantity + input.quantity
      if (requestedQuantity > MAX_LINE_QUANTITY) throw overTotal(['quantity'])
      const outcome = await setQuantity(ctx, input.stockcode, requestedQuantity)
      return { stockcode: input.stockcode, previousQuantity, requestedQuantity, ...outcome }
    })
  },
})

export const setCartQuantity = tool({
  input: z.object({
    stockcode: stockcodeSchema,
    quantity: z
      .number()
      .int()
      .min(0)
      .max(MAX_LINE_QUANTITY)
      .describe(`The line's new quantity, at most ${MAX_LINE_QUANTITY}. 0 removes the product.`),
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
    /** Whether the product was in the cart before the call. Null when the cart read couldn't say. */
    wasInCart: z
      .boolean()
      .nullable()
      .describe('Whether the product was in the cart before the call. Null when that could not be read.'),
    /** Whether this call took the product out: it was there, and the site's reply is without it. */
    removed: z
      .boolean()
      .nullable()
      .describe(
        'True when the product was in the cart and the reply is without it. False when it was not in the cart, or is still there. Null when unconfirmed.',
      ),
  }),
  async run(ctx, input) {
    return withLogin(ctx, async () => {
      // Read first, so the answer can say whether there was anything to remove. The write is made
      // anyway: the read may be the runtime's cached trolley, and setting 0 is right either way.
      const read = await trolleyBeforeWrite(ctx)
      const wasInCart = read.quantities.has(input.stockcode) ? true : read.complete ? false : null
      const outcome = await setQuantity(ctx, input.stockcode, 0)
      const removed =
        outcome.quantity === null || wasInCart === null ? null : wasInCart && outcome.quantity === 0
      const notices = wasInCart === false ? [...outcome.notices, NOTICES.notInCart] : outcome.notices
      return { stockcode: input.stockcode, wasInCart, removed, ...outcome, notices }
    })
  },
})

/** A line the cart already holds some of, that the call would take past the per-line ceiling. */
function overTotal(path: readonly InputPathSegment[]): ValetError {
  return new ValetError('tool-input', 'invalid', { path, reason: 'over-total', limit: MAX_LINE_QUANTITY })
}

/** The most lines one update_cart call may change. */
export const MAX_BATCH_LINES = 30

const batchLineSchema = z
  .object({
    stockcode: stockcodeSchema,
    /** With mode "add", how many to add (at least 1); with "set", the line's new quantity (0 removes it). */
    quantity: z
      .number()
      .int()
      .min(0)
      .max(MAX_LINE_QUANTITY)
      .optional()
      .describe(
        `With mode "add", how many to add (default 1). With mode "set", required: the line's new quantity, 0 removes it. A line holds at most ${MAX_LINE_QUANTITY} of one product.`,
      ),
    mode: z
      .enum(['add', 'set'])
      .default('add')
      .describe('"add" adds to the quantity already in the cart; "set" replaces it.'),
  })
  .superRefine((line, check) => {
    // A set with no quantity would otherwise set 1, never what was meant.
    if (line.mode === 'set' && line.quantity === undefined)
      check.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'required',
        params: { reason: 'missing' },
      })
    if (line.mode === 'add' && line.quantity === 0)
      check.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'at least 1',
        params: { reason: 'too-small', limit: 1 },
      })
  })

/**
 * Many lines in one call (D-pacing): the agent sends a whole shopping list at once instead of one
 * paced call per product. The site gets one trolley read (only when a line adds) and one update
 * carrying every line, so a 30-item shop costs two requests, not thirty.
 */
export const updateCart = tool({
  input: z.object({
    items: z
      .array(batchLineSchema)
      .min(1)
      .max(MAX_BATCH_LINES)
      .superRefine((items, check) => {
        const seen = new Set<number>()
        items.forEach((line, index) => {
          if (seen.has(line.stockcode)) {
            check.addIssue({
              code: 'custom',
              path: [index, 'stockcode'],
              message: 'each product may appear once',
              params: { reason: 'duplicate' },
            })
          }
          seen.add(line.stockcode)
        })
      })
      .describe(`The lines to change, each product once, at most ${MAX_BATCH_LINES}.`),
  }),
  output: z.object({
    items: z.array(
      z.object({
        stockcode: z.number().int(),
        mode: z.enum(['add', 'set']),
        /** The quantity before the call, as read from the site. Null for a set, which reads nothing. */
        previousQuantity: z.number().nullable(),
        /** What the write asked the site to store for this line. */
        requestedQuantity: z.number(),
        quantity: writeOutput.quantity,
        confirmed: writeOutput.confirmed,
        notices: writeOutput.notices,
      }),
    ),
    cart: writeOutput.cart,
    notices: writeOutput.notices,
  }),
  async run(ctx, input) {
    return withLogin(ctx, async () => {
      let quantities: ReadonlyMap<number, number> = new Map()
      if (input.items.some((line) => line.mode === 'add')) {
        const read = await trolleyBeforeWrite(ctx)
        // As in add_to_cart: an add over a line the adapter can't read would shrink it.
        if (!read.complete) throw new ValetError('tool-run', 'site-changed')
        quantities = read.quantities
      }
      const planned = input.items.map((line) => {
        const previousQuantity = line.mode === 'add' ? (quantities.get(line.stockcode) ?? 0) : null
        // The schema refuses a set without a quantity; an add's defaults to 1.
        const quantity = line.quantity ?? 1
        const requestedQuantity = line.mode === 'add' ? (previousQuantity ?? 0) + quantity : quantity
        return { stockcode: line.stockcode, mode: line.mode, previousQuantity, requestedQuantity }
      })
      const over = planned.findIndex((line) => line.requestedQuantity > MAX_LINE_QUANTITY)
      if (over !== -1) throw overTotal(['items', over, 'quantity'])
      const outcome = await setQuantities(
        ctx,
        planned.map((line) => ({ stockcode: line.stockcode, quantity: line.requestedQuantity })),
        (index) => ['items', index, 'stockcode'],
      )
      return {
        items: planned.map((line, index) => ({ ...line, ...(outcome.lines[index] as LineOutcome) })),
        cart: outcome.cart,
        notices: outcome.notices,
      }
    })
  },
})
