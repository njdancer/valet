import { NeedsUserError, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { addToCart, getCart, NOTICES, removeFromCart, setCartQuantity, updateCart } from '../src/cart'
import { FAKE_ORIGIN, FakeToolContext, json, loadFixture } from './fake-context'

const TROLLEY = '/apis/ui/Trolley'
const UPDATE = '/api/v3/ui/trolley/update'

describe('get_cart', () => {
  it('ensures the login before reading the trolley', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
    await getCart.run(ctx, {})
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley'])
  })

  it('always asks the site, never the runtime’s read cache: it is the tool a cart is checked with', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
    await getCart.run(ctx, {})
    expect(ctx.fetches.map((f) => f.reload)).toEqual([true])
  })

  it('maps items, line totals and totals', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
    const cart = await getCart.run(ctx, {})
    expect(cart).toEqual({
      items: [
        {
          stockcode: 88436,
          name: 'Dairy Farmers Full Cream Milk 2L',
          quantity: 2,
          price: 4.2,
          lineTotal: 8.4,
          available: true,
        },
        {
          stockcode: 888137,
          name: 'Woolworths Full Cream Milk 2L',
          quantity: 1,
          price: 3.4,
          lineTotal: 3.4,
          available: true,
        },
      ],
      unavailable: [],
      subtotal: 11.8,
      savings: 1,
      itemCount: 2,
      totalQuantity: 3,
      notices: [],
      cartUrl: `${FAKE_ORIGIN}/shop/cart`,
    })
    expect(getCart.output.parse(cart)).toEqual(cart)
  })

  it('maps the captured empty trolley, with the site notice', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
    const cart = await getCart.run(ctx, {})
    expect(cart).toEqual({
      items: [],
      unavailable: [],
      subtotal: 0,
      savings: 0,
      itemCount: 0,
      totalQuantity: 0,
      notices: ['Pick up has a $50 minimum spend. Add $50.00 of Woolworths items to continue.'],
      cartUrl: `${FAKE_ORIGIN}/shop/cart`,
    })
  })

  it('gives no cart link when the tool page is not an https page', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
    Object.assign(ctx.page, { currentUrl: () => 'about:blank' })
    expect((await getCart.run(ctx, {})).cartUrl).toBeNull()
  })

  it('lists unavailable items separately', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.UnavailableItems = [body.AvailableItems.pop()]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const cart = await getCart.run(ctx, {})
    expect(cart.items.map((i) => i.stockcode)).toEqual([88436])
    expect(cart.unavailable).toEqual([
      {
        stockcode: 888137,
        name: 'Woolworths Full Cream Milk 2L',
        quantity: 1,
        price: 3.4,
        lineTotal: 3.4,
        available: false,
        reason: 'unavailable',
      },
    ])
    expect(cart.notices).toEqual([])
  })

  it('lists an item from each set-aside bucket with its reason, instead of dropping it', async () => {
    const buckets = [
      ['ExceededAtpLimitItems', 'over-stock-limit'],
      ['ConflictedItems', 'conflicted'],
      ['RestrictedItems', 'restricted'],
      ['RestrictedByCrowdDeliveryItems', 'restricted-crowd-delivery'],
      ['RestrictedByDeliPlattersItems', 'restricted-deli-platters'],
      ['RestrictedByDeliveryMethodItems', 'restricted-delivery-method'],
      ['RestrictedByIdVerificationItems', 'needs-id-verification'],
      ['RestrictedBySellerDeliverabilityItems', 'restricted-seller-delivery'],
    ]
    for (const [bucket, reason] of buckets) {
      const body = loadFixture('trolley-two-items.json')
      body[bucket as string] = [body.AvailableItems.pop()]
      const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
      const cart = await getCart.run(ctx, {})
      expect(cart.items.map((i) => i.stockcode)).toEqual([88436])
      expect(cart.unavailable).toEqual([expect.objectContaining({ stockcode: 888137, quantity: 1, reason })])
      expect(cart.notices).toEqual([])
      expect(getCart.output.parse(cart)).toEqual(cart)
    }
  })

  it('lists the items of a supply-limit group', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.ExceededSupplyLimitGroups = [{ Items: [body.AvailableItems.pop()] }]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const cart = await getCart.run(ctx, {})
    expect(cart.unavailable).toEqual([
      expect.objectContaining({ stockcode: 888137, reason: 'over-supply-limit' }),
    ])
    expect(cart.notices).toEqual([])
  })

  it('says so when an item is in a shape it cannot read, without echoing the item', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.AvailableItems.pop()
    body.ConflictedItems = [{ Stockcode: 'canary-5e1d', Name: 'canary-5e1d' }]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const cart = await getCart.run(ctx, {})
    expect(cart.items.map((i) => i.stockcode)).toEqual([88436])
    expect(cart.unavailable).toEqual([])
    expect(cart.notices).toEqual([NOTICES.incomplete])
    expect(JSON.stringify(cart)).not.toContain('canary-5e1d')
  })

  it('says so for a supply-limit group in a shape it cannot read', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.ExceededSupplyLimitGroups = [{ Products: [body.AvailableItems.pop()] }]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    expect((await getCart.run(ctx, {})).notices).toEqual([NOTICES.incomplete])
  })

  it('says so for a bundle, whose shape is unknown', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.BundleItems = [{ BundleId: 1 }]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    expect((await getCart.run(ctx, {})).notices).toEqual([NOTICES.incomplete])
  })

  it("says so when the lines it read don't add up to the site's own count", async () => {
    const body = loadFixture('trolley-two-items.json')
    body.TrolleyItemCount = 3
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const cart = await getCart.run(ctx, {})
    expect(cart.itemCount).toBe(3)
    expect(cart.notices).toEqual([NOTICES.incomplete])
  })

  it('says so when one product sits in two buckets', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.RestrictedItems = [body.AvailableItems[0]]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    expect((await getCart.run(ctx, {})).notices).toEqual([NOTICES.incomplete])
  })

  it('gives no line total for an item with no price', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.AvailableItems[0].Price = null
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const cart = await getCart.run(ctx, {})
    expect(cart.items[0]).toMatchObject({ price: null, lineTotal: null })
  })

  it('rounds line totals to cents', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.AvailableItems[0].Price = 1.1
    body.AvailableItems[0].QuantityInTrolley = 3
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const cart = await getCart.run(ctx, {})
    expect(cart.items[0]?.lineTotal).toBe(3.3)
  })

  it('treats an item with no quantity as zero', async () => {
    const body = loadFixture('trolley-two-items.json')
    delete body.AvailableItems[0].QuantityInTrolley
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const cart = await getCart.run(ctx, {})
    expect(cart.items[0]).toMatchObject({ quantity: 0, lineTotal: 0 })
  })

  it('skips blank notices and tolerates a missing Errors list', async () => {
    const withBlank = loadFixture('trolley-empty.json')
    withBlank.Errors = [
      { Type: 'X', Message: '  ' },
      { Type: 'Y', Message: null },
    ]
    const noErrors = loadFixture('trolley-empty.json')
    delete noErrors.Errors
    const first = new FakeToolContext().on('GET', TROLLEY, json(withBlank))
    const second = new FakeToolContext().on('GET', TROLLEY, json(noErrors))
    expect((await getCart.run(first, {})).notices).toEqual([])
    expect((await getCart.run(second, {})).notices).toEqual([])
  })

  it('reports a trolley in an unexpected shape as site-changed, not as bad input', async () => {
    const body = loadFixture('trolley-empty.json')
    delete body.Totals
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const error = await getCart.run(ctx, {}).catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'site-changed'))
  })

  it('logs in once more after a 401 partway through, and reads the trolley again', async () => {
    let calls = 0
    const ctx = new FakeToolContext().on('GET', TROLLEY, () => {
      calls += 1
      return calls === 1 ? json({}, 401) : json(loadFixture('trolley-two-items.json'))
    })
    const cart = await getCart.run(ctx, {})
    expect(cart.itemCount).toBe(2)
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley', 'ensure', 'GET /apis/ui/Trolley'])
  })

  it('reports a second 401 as not-logged-in, without trying a third time', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json({}, 401))
    const error = await getCart.run(ctx, {}).catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'not-logged-in'))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley', 'ensure', 'GET /apis/ui/Trolley'])
  })

  it('ends as needsUser when logging in again after a 401 needs the person', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, () => {
      ctx.ensureResult = { status: 'needsUser', reason: 'otp-required' }
      return json({}, 401)
    })
    const error = await getCart.run(ctx, {}).catch((e: unknown) => e)
    expect(error).toEqual(new NeedsUserError('otp-required'))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley', 'ensure'])
  })

  it('does not log in again for anything but a 401', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json({}, 403))
    const error = await getCart.run(ctx, {}).catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'blocked-by-site'))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley'])
  })
})

describe('add_to_cart', () => {
  it('adds to the quantity already in the cart, because the update sets absolute quantities', async () => {
    const reply = loadFixture('trolley-two-items.json')
    reply.AvailableItems[0].QuantityInTrolley = 5
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
      .on('POST', UPDATE, json(reply))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 3 }))
    expect(ctx.fetches.at(-1)?.json).toEqual({ items: [{ stockcode: 88436, quantity: 5 }] })
    expect(result).toMatchObject({
      stockcode: 88436,
      previousQuantity: 2,
      requestedQuantity: 5,
      quantity: 5,
      confirmed: true,
      notices: [],
    })
    expect(addToCart.output.parse(result)).toEqual(result)
  })

  it('starts from zero for a product not in the cart, and reports an unconfirmed write as such', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
      .on('POST', UPDATE, json({}))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 64746 }))
    expect(ctx.fetches.at(-1)?.json).toEqual({ items: [{ stockcode: 64746, quantity: 1 }] })
    expect(result).toEqual({
      stockcode: 64746,
      previousQuantity: 0,
      requestedQuantity: 1,
      quantity: null,
      confirmed: false,
      cart: null,
      notices: [NOTICES.unconfirmed],
    })
  })

  it('counts a quantity held in the unavailable list', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.UnavailableItems = [body.AvailableItems.pop()]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body)).on('POST', UPDATE, json({}))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 888137, quantity: 2 }))
    expect(result).toMatchObject({ previousQuantity: 1, requestedQuantity: 3 })
  })

  it('counts a quantity held in a supply-limit group, so the write does not shrink the line', async () => {
    const body = loadFixture('trolley-two-items.json')
    const tile = body.AvailableItems.pop()
    tile.QuantityInTrolley = 4
    body.ExceededSupplyLimitGroups = [{ Items: [tile] }]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body)).on('POST', UPDATE, json({}))
    await addToCart.run(ctx, addToCart.input.parse({ stockcode: 888137, quantity: 1 }))
    expect(ctx.fetches.at(-1)?.json).toEqual({ items: [{ stockcode: 888137, quantity: 5 }] })
  })

  it('makes no write when the trolley has a line it cannot read, which the write could shrink', async () => {
    const unreadable = loadFixture('trolley-two-items.json')
    unreadable.AvailableItems.pop()
    unreadable.ExceededAtpLimitItems = [{ Stockcode: 888137, QuantityInTrolley: 'four' }]
    const bundle = loadFixture('trolley-two-items.json')
    bundle.BundleItems = [{ Stockcode: 888137 }]
    const miscounted = loadFixture('trolley-two-items.json')
    miscounted.TrolleyItemCount = 3
    const duplicated = loadFixture('trolley-two-items.json')
    duplicated.ConflictedItems = [duplicated.AvailableItems[1]]

    for (const trolley of [unreadable, bundle, miscounted, duplicated]) {
      const ctx = new FakeToolContext().on('GET', TROLLEY, json(trolley)).on('POST', UPDATE, json({}))
      const error = await addToCart
        .run(ctx, addToCart.input.parse({ stockcode: 888137, quantity: 1 }))
        .catch((e: unknown) => e)
      expect(error).toEqual(new ValetError('tool-run', 'site-changed'))
      expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley'])
    }
  })

  it('reports the quantity the site stored when it clamps the line, with a notice', async () => {
    const before = loadFixture('trolley-two-items.json')
    before.AvailableItems[0].QuantityInTrolley = 10
    const reply = loadFixture('trolley-two-items.json')
    reply.AvailableItems[0].QuantityInTrolley = 12
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(before)).on('POST', UPDATE, json(reply))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 10 }))
    expect(ctx.fetches.at(-1)?.json).toEqual({ items: [{ stockcode: 88436, quantity: 20 }] })
    expect(result).toMatchObject({
      previousQuantity: 10,
      requestedQuantity: 20,
      quantity: 12,
      confirmed: true,
      notices: [NOTICES.differs(12, 20)],
    })
    expect(result.notices[0]).toBe(
      'The site stored 12, not the 20 asked for. It may limit how many of this product an order can have, or the cart changed at the same time.',
    )
  })

  it('flags a reply showing more than it asked for, as a parallel add would leave it', async () => {
    const reply = loadFixture('trolley-two-items.json')
    reply.AvailableItems[0].QuantityInTrolley = 4
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
      .on('POST', UPDATE, json(reply))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 1 }))
    expect(result).toMatchObject({ requestedQuantity: 3, quantity: 4, notices: [NOTICES.differs(4, 3)] })
  })

  it('reports a 200 whose body says the site refused the change as invalid, not success', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
      .on('POST', UPDATE, json({ Success: false, Errors: [{ Message: 'Item not available canary-0b2e' }] }))
    const error = await addToCart
      .run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 3 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'invalid'))
    expect(String(error)).not.toContain('canary-0b2e')
  })

  it('starts from the trolley the runtime has cached, when it is one this adapter can fully read', async () => {
    const cached = { ...json(loadFixture('trolley-two-items.json')), fromCache: true as const }
    const ctx = new FakeToolContext().on('GET', TROLLEY, cached).on('POST', UPDATE, json({}))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 888137, quantity: 1 }))
    expect(result.previousQuantity).toBe(1)
    expect(ctx.fetches.map((f) => [f.method, f.reload])).toEqual([
      ['GET', undefined],
      ['POST', undefined],
    ])
  })

  it('asks the site instead when the cached trolley is not a trolley, or has a line it cannot read', async () => {
    const miscounted = loadFixture('trolley-two-items.json')
    miscounted.TrolleyItemCount = 3
    // What the cache holds after a write whose reply wasn't the trolley after all.
    for (const stale of [{ Success: true }, miscounted]) {
      const ctx = new FakeToolContext()
        .on('GET', TROLLEY, (request) =>
          request.reload === true
            ? json(loadFixture('trolley-two-items.json'))
            : { ...json(stale), fromCache: true as const },
        )
        .on('POST', UPDATE, json({}))
      const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 888137, quantity: 1 }))
      expect(result.requestedQuantity).toBe(2)
      expect(ctx.fetches.map((f) => [f.method, f.reload])).toEqual([
        ['GET', undefined],
        ['GET', true],
        ['POST', undefined],
      ])
    }
  })

  it('does not ask twice when the site’s own fresh answer is the unreadable one', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json({ Success: true })).on('POST', UPDATE, json({}))
    const error = await addToCart
      .run(ctx, addToCart.input.parse({ stockcode: 888137, quantity: 1 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'site-changed'))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley'])
  })

  it('makes exactly ensure, one read and one write, in that order', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
      .on('POST', UPDATE, json({}))
    await addToCart.run(ctx, addToCart.input.parse({ stockcode: 64746 }))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley', 'POST /api/v3/ui/trolley/update'])
  })

  it('after a 401 on the write, logs in again and re-reads before writing, so it never adds twice', async () => {
    let writes = 0
    const after = loadFixture('trolley-two-items.json')
    after.AvailableItems[0].QuantityInTrolley = 3
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
      .on('POST', UPDATE, () => {
        writes += 1
        return writes === 1 ? json({}, 401) : json(after)
      })
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 1 }))
    expect(ctx.events).toEqual([
      'ensure',
      'GET /apis/ui/Trolley',
      'POST /api/v3/ui/trolley/update',
      'ensure',
      'GET /apis/ui/Trolley',
      'POST /api/v3/ui/trolley/update',
    ])
    expect(ctx.fetches.filter((f) => f.method === 'POST').map((f) => f.json)).toEqual([
      { items: [{ stockcode: 88436, quantity: 3 }] },
      { items: [{ stockcode: 88436, quantity: 3 }] },
    ])
    expect(result).toMatchObject({ previousQuantity: 2, requestedQuantity: 3, quantity: 3, confirmed: true })
  })

  it('returns the updated cart when the site sends it back', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
      .on('POST', UPDATE, json(loadFixture('trolley-two-items.json')))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 2 }))
    expect(result.cart?.items.map((i) => [i.stockcode, i.quantity])).toEqual([
      [88436, 2],
      [888137, 1],
    ])
    expect(result).toMatchObject({ quantity: 2, confirmed: true, notices: [] })
    expect(addToCart.output.parse(result)).toEqual(result)
  })

  it('refuses to push a line over 20 and makes no write (D54)', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.AvailableItems[0].QuantityInTrolley = 15
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body)).on('POST', UPDATE, json({}))
    const error = await addToCart
      .run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 6 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-input', 'invalid'))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley'])
  })

  it('makes no write when cancelled after reading the cart', async () => {
    const ctx = new FakeToolContext()
    ctx
      .on('GET', TROLLEY, () => {
        ctx.controller.abort()
        return json(loadFixture('trolley-empty.json'))
      })
      .on('POST', UPDATE, json({}))
    const error = await addToCart
      .run(ctx, addToCart.input.parse({ stockcode: 64746 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'aborted'))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley'])
  })

  it('makes no write when the read is blocked by the site', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, { status: 403, contentType: 'text/html', body: 'Access Denied' })
      .on('POST', UPDATE, json({}))
    const error = await addToCart
      .run(ctx, addToCart.input.parse({ stockcode: 64746 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'blocked-by-site'))
    expect(ctx.fetches.map((f) => f.method)).toEqual(['GET'])
  })

  it('makes no write when the read comes back as an HTML page with a 200', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<html>Sign in</html>',
      })
      .on('POST', UPDATE, json({}))
    const error = await addToCart
      .run(ctx, addToCart.input.parse({ stockcode: 64746 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'blocked-by-site'))
    expect(ctx.fetches.map((f) => f.method)).toEqual(['GET'])
  })

  it('bounds the quantity to 1..20 whole units', () => {
    const parse = (input: unknown) => addToCart.input.safeParse(input)
    expect(parse({ stockcode: 1, quantity: 20 }).success).toBe(true)
    expect(parse({ stockcode: 1, quantity: 21 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: 0 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: -3 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: 1.5 }).success).toBe(false)
    expect(parse({ stockcode: '1' }).success).toBe(false)
  })
})

describe('set_cart_quantity', () => {
  async function set(ctx: FakeToolContext, stockcode: number, quantity: number) {
    return setCartQuantity.run(ctx, setCartQuantity.input.parse({ stockcode, quantity }))
  }

  it('sets the absolute quantity with one write and no read, confirmed by the reply', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json(loadFixture('trolley-two-items.json')))
    const result = await set(ctx, 88436, 2)
    expect(ctx.events).toEqual(['ensure', 'POST /api/v3/ui/trolley/update'])
    expect(ctx.fetches[0]?.json).toEqual({ items: [{ stockcode: 88436, quantity: 2 }] })
    expect(result).toMatchObject({ requestedQuantity: 2, quantity: 2, confirmed: true, notices: [] })
    expect(result.cart?.subtotal).toBe(11.8)
    expect(setCartQuantity.output.parse(result)).toEqual(result)
  })

  it('reports a reply that is not a trolley as unconfirmed, not as the quantity asked for', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json({ Success: true }))
    expect(await set(ctx, 88436, 2)).toEqual({
      stockcode: 88436,
      requestedQuantity: 2,
      quantity: null,
      confirmed: false,
      cart: null,
      notices: [NOTICES.unconfirmed],
    })
  })

  it('reports replies of unknown shape as unconfirmed', async () => {
    for (const body of [null, [], 'ok', 3, { Trolley: {} }]) {
      const ctx = new FakeToolContext().on('POST', UPDATE, json(body))
      expect(await set(ctx, 88436, 2)).toMatchObject({ quantity: null, confirmed: false, cart: null })
    }
  })

  it('reports an error-bodied 200 as invalid, never as success', async () => {
    const trolleyRefused = loadFixture('trolley-two-items.json')
    trolleyRefused.Success = false
    const refusals = [
      { Success: false, Errors: [{ Message: 'Item not available' }] },
      { Success: false },
      { Errors: [{ Message: 'Item not available' }] },
      trolleyRefused,
    ]
    for (const body of refusals) {
      const ctx = new FakeToolContext().on('POST', UPDATE, json(body))
      const error = await set(ctx, 88436, 3).catch((e: unknown) => e)
      expect(error).toEqual(new ValetError('tool-run', 'invalid'))
    }
  })

  it('does not treat a reply with an empty Errors list as a refusal', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json({ Success: true, Errors: [] }))
    expect(await set(ctx, 88436, 2)).toMatchObject({ confirmed: false })
  })

  it('reports the clamped quantity the site stored, not the one asked for', async () => {
    const reply = loadFixture('trolley-two-items.json')
    reply.AvailableItems[0].QuantityInTrolley = 12
    const ctx = new FakeToolContext().on('POST', UPDATE, json(reply))
    expect(await set(ctx, 88436, 20)).toMatchObject({
      requestedQuantity: 20,
      quantity: 12,
      confirmed: true,
      notices: [NOTICES.differs(12, 20)],
    })
  })

  it('reports zero when a complete reply no longer has the line', async () => {
    const reply = loadFixture('trolley-two-items.json')
    reply.AvailableItems.shift()
    reply.TrolleyItemCount = 1
    const ctx = new FakeToolContext().on('POST', UPDATE, json(reply))
    expect(await set(ctx, 88436, 3)).toMatchObject({
      quantity: 0,
      confirmed: true,
      notices: [NOTICES.differs(0, 3)],
    })
  })

  it('reports unconfirmed when the line may be hidden in a part of the reply it cannot read', async () => {
    const reply = loadFixture('trolley-two-items.json')
    reply.AvailableItems.shift()
    reply.ExceededAtpLimitItems = [{ Stockcode: 'unknown' }]
    const ctx = new FakeToolContext().on('POST', UPDATE, json(reply))
    const result = await set(ctx, 88436, 3)
    expect(result).toMatchObject({ quantity: null, confirmed: false, notices: [NOTICES.lineUnreadable] })
    expect(result.cart?.notices).toEqual([NOTICES.incomplete])
  })

  it('reports a blocked write as blocked-by-site', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json({}, 403))
    const error = await set(ctx, 88436, 2).catch((e: unknown) => e)
    expect(error).toEqual(new ValetError('tool-run', 'blocked-by-site'))
  })

  it('bounds the quantity to 0..20 whole units', () => {
    const parse = (input: unknown) => setCartQuantity.input.safeParse(input)
    expect(parse({ stockcode: 1, quantity: 0 }).success).toBe(true)
    expect(parse({ stockcode: 1, quantity: 20 }).success).toBe(true)
    expect(parse({ stockcode: 1, quantity: 21 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: -1 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: 2.5 }).success).toBe(false)
    expect(parse({ stockcode: 1 }).success).toBe(false)
  })
})

describe('remove_from_cart', () => {
  it('sets the quantity to zero with one write, and confirms it from the reply', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json(loadFixture('trolley-empty.json')))
    const result = await removeFromCart.run(ctx, removeFromCart.input.parse({ stockcode: 88436 }))
    expect(ctx.events).toEqual(['ensure', 'POST /api/v3/ui/trolley/update'])
    expect(ctx.fetches[0]?.json).toEqual({ items: [{ stockcode: 88436, quantity: 0 }] })
    expect(result).toMatchObject({
      stockcode: 88436,
      removed: true,
      quantity: 0,
      confirmed: true,
      cart: { items: [] },
      notices: [],
    })
    expect(removeFromCart.output.parse(result)).toEqual(result)
  })

  it('reports removed: false when the reply still has the line', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json(loadFixture('trolley-two-items.json')))
    const result = await removeFromCart.run(ctx, removeFromCart.input.parse({ stockcode: 88436 }))
    expect(result).toMatchObject({ removed: false, quantity: 2, notices: [NOTICES.differs(2, 0)] })
  })

  it('reports removed: null when the reply does not say', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json({ Success: true }))
    const result = await removeFromCart.run(ctx, removeFromCart.input.parse({ stockcode: 88436 }))
    expect(result).toMatchObject({ removed: null, confirmed: false, cart: null })
  })
})

describe('cart tools without a login', () => {
  const cases = [
    { name: 'get_cart', run: (ctx: FakeToolContext) => getCart.run(ctx, {}) },
    {
      name: 'add_to_cart',
      run: (ctx: FakeToolContext) => addToCart.run(ctx, { stockcode: 88436, quantity: 1 }),
    },
    {
      name: 'set_cart_quantity',
      run: (ctx: FakeToolContext) => setCartQuantity.run(ctx, { stockcode: 88436, quantity: 1 }),
    },
    {
      name: 'remove_from_cart',
      run: (ctx: FakeToolContext) => removeFromCart.run(ctx, { stockcode: 88436 }),
    },
  ]

  for (const { name, run } of cases) {
    it(`${name} makes no request to the anonymous trolley when the person must log in`, async () => {
      const ctx = new FakeToolContext()
        .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
        .on('POST', UPDATE, json({}))
      ctx.ensureResult = { status: 'needsUser', reason: 'captcha' }
      const error = await run(ctx).catch((e: unknown) => e)
      expect(error).toEqual(new NeedsUserError('captcha'))
      expect(error).toBeInstanceOf(NeedsUserError)
      expect(ctx.fetches).toEqual([])
    })

    it(`${name} makes no request when the login failed`, async () => {
      const ctx = new FakeToolContext()
        .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
        .on('POST', UPDATE, json({}))
      ctx.ensureResult = { status: 'failed', stage: 'credential', errorClass: 'locked' }
      const error = await run(ctx).catch((e: unknown) => e)
      expect(error).toEqual(new ValetError('credential', 'locked'))
      expect(ctx.fetches).toEqual([])
    })
  }
})

describe('update_cart', () => {
  it('adds and sets many lines with one trolley read and one update, reporting each line', async () => {
    const reply = loadFixture('trolley-two-items.json')
    reply.AvailableItems[0].QuantityInTrolley = 5
    reply.AvailableItems.pop()
    reply.TrolleyItemCount = 1
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
      .on('POST', UPDATE, json(reply))
    const input = updateCart.input.parse({
      items: [
        { stockcode: 88436, quantity: 3 },
        { stockcode: 888137, quantity: 0, mode: 'set' },
      ],
    })
    const result = await updateCart.run(ctx, input)
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley', 'POST /api/v3/ui/trolley/update'])
    expect(ctx.fetches.at(-1)?.json).toEqual({
      items: [
        { stockcode: 88436, quantity: 5 },
        { stockcode: 888137, quantity: 0 },
      ],
    })
    expect(result.items).toEqual([
      {
        stockcode: 88436,
        mode: 'add',
        previousQuantity: 2,
        requestedQuantity: 5,
        quantity: 5,
        confirmed: true,
        notices: [],
      },
      {
        stockcode: 888137,
        mode: 'set',
        previousQuantity: null,
        requestedQuantity: 0,
        quantity: 0,
        confirmed: true,
        notices: [],
      },
    ])
    expect(result.cart?.items.map((i) => i.stockcode)).toEqual([88436])
    expect(updateCart.output.parse(result)).toEqual(result)
  })

  it('reads nothing when every line sets, and says which line the site stored differently', async () => {
    const reply = loadFixture('trolley-two-items.json')
    reply.AvailableItems[0].QuantityInTrolley = 12
    const ctx = new FakeToolContext().on('POST', UPDATE, json(reply))
    const result = await updateCart.run(
      ctx,
      updateCart.input.parse({ items: [{ stockcode: 88436, quantity: 20, mode: 'set' }] }),
    )
    expect(ctx.events).toEqual(['ensure', 'POST /api/v3/ui/trolley/update'])
    expect(result.items[0]).toMatchObject({
      quantity: 12,
      confirmed: true,
      notices: [NOTICES.differs(12, 20)],
    })
  })

  it('reports every line unconfirmed when the reply is not the trolley', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
      .on('POST', UPDATE, json({}))
    const result = await updateCart.run(
      ctx,
      updateCart.input.parse({ items: [{ stockcode: 64746 }, { stockcode: 88436, quantity: 2 }] }),
    )
    expect(result.items.map((i) => [i.requestedQuantity, i.confirmed])).toEqual([
      [1, false],
      [2, false],
    ])
    expect(result).toMatchObject({ cart: null, notices: [NOTICES.unconfirmed] })
  })

  it('refuses a product twice, an empty or over-long list, and an add of nothing', () => {
    const line = (stockcode: number) => ({ stockcode })
    expect(() => updateCart.input.parse({ items: [line(1), line(1)] })).toThrow()
    expect(() => updateCart.input.parse({ items: [] })).toThrow()
    expect(() =>
      updateCart.input.parse({ items: Array.from({ length: 31 }, (_, i) => line(i + 1)) }),
    ).toThrow()
    expect(() => updateCart.input.parse({ items: [{ stockcode: 1, quantity: 0 }] })).toThrow()
    expect(updateCart.input.parse({ items: [{ stockcode: 1, quantity: 0, mode: 'set' }] })).toBeTruthy()
  })

  it('writes nothing past the per-line cap, or over a trolley line it cannot read', async () => {
    const full = loadFixture('trolley-two-items.json')
    full.AvailableItems[0].QuantityInTrolley = 19
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(full))
    await expect(
      updateCart.run(ctx, updateCart.input.parse({ items: [{ stockcode: 88436, quantity: 2 }] })),
    ).rejects.toMatchObject({ stage: 'tool-input', errorClass: 'invalid' })
    const unreadable = loadFixture('trolley-two-items.json')
    unreadable.BundleItems = [{ Stockcode: 1 }]
    const other = new FakeToolContext().on('GET', TROLLEY, json(unreadable))
    await expect(
      updateCart.run(other, updateCart.input.parse({ items: [{ stockcode: 88436 }] })),
    ).rejects.toMatchObject({ errorClass: 'site-changed' })
    expect(ctx.events.concat(other.events).filter((e) => e.startsWith('POST'))).toEqual([])
  })
})
