import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { addToCart, getCart, removeFromCart, setCartQuantity } from '../src/cart'
import { FakeToolContext, json, loadFixture } from './fake-context'

const TROLLEY = '/apis/ui/Trolley'
const UPDATE = '/api/v3/ui/trolley/update'

describe('get_cart', () => {
  it('ensures the login before reading the trolley', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
    await getCart.run(ctx, {})
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley'])
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
    })
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
      },
    ])
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

  it('reports a trolley in an unexpected shape as invalid', async () => {
    const body = loadFixture('trolley-empty.json')
    delete body.Totals
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body))
    const error = await getCart.run(ctx, {}).catch((e: unknown) => e)
    expect(error).toEqual(new SiteAdapterError('tool-run', 'invalid'))
  })

  it('reports a 401 partway through as not-logged-in, so the runtime can log in again', async () => {
    const ctx = new FakeToolContext().on('GET', TROLLEY, json({}, 401))
    const error = await getCart.run(ctx, {}).catch((e: unknown) => e)
    expect(error).toEqual(new SiteAdapterError('tool-run', 'not-logged-in'))
  })
})

describe('add_to_cart', () => {
  it('adds to the quantity already in the cart, because the update sets absolute quantities', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-two-items.json')))
      .on('POST', UPDATE, json(loadFixture('trolley-two-items.json')))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 3 }))
    expect(ctx.fetches.at(-1)?.json).toEqual({ items: [{ stockcode: 88436, quantity: 5 }] })
    expect(result).toMatchObject({ stockcode: 88436, previousQuantity: 2, quantity: 5 })
  })

  it('starts from zero for a product not in the cart, adding one by default', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
      .on('POST', UPDATE, json({}))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 64746 }))
    expect(ctx.fetches.at(-1)?.json).toEqual({ items: [{ stockcode: 64746, quantity: 1 }] })
    expect(result).toEqual({ stockcode: 64746, previousQuantity: 0, quantity: 1, cart: null })
  })

  it('counts a quantity held in the unavailable list', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.UnavailableItems = [body.AvailableItems.pop()]
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body)).on('POST', UPDATE, json({}))
    const result = await addToCart.run(ctx, addToCart.input.parse({ stockcode: 888137, quantity: 2 }))
    expect(result).toMatchObject({ previousQuantity: 1, quantity: 3 })
  })

  it('makes exactly ensure, one read and one write, in that order', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
      .on('POST', UPDATE, json({}))
    await addToCart.run(ctx, addToCart.input.parse({ stockcode: 64746 }))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley', 'POST /api/v3/ui/trolley/update'])
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
    expect(addToCart.output.parse(result)).toEqual(result)
  })

  it('refuses to push a line over 50 and makes no write', async () => {
    const body = loadFixture('trolley-two-items.json')
    body.AvailableItems[0].QuantityInTrolley = 45
    const ctx = new FakeToolContext().on('GET', TROLLEY, json(body)).on('POST', UPDATE, json({}))
    const error = await addToCart
      .run(ctx, addToCart.input.parse({ stockcode: 88436, quantity: 6 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new SiteAdapterError('tool-input', 'invalid'))
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
    expect(error).toEqual(new SiteAdapterError('tool-run', 'aborted'))
    expect(ctx.events).toEqual(['ensure', 'GET /apis/ui/Trolley'])
  })

  it('makes no write when the read is blocked by the site', async () => {
    const ctx = new FakeToolContext()
      .on('GET', TROLLEY, { status: 403, contentType: 'text/html', body: 'Access Denied' })
      .on('POST', UPDATE, json({}))
    const error = await addToCart
      .run(ctx, addToCart.input.parse({ stockcode: 64746 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new SiteAdapterError('tool-run', 'blocked-by-site'))
    expect(ctx.fetches.map((f) => f.method)).toEqual(['GET'])
  })

  it('bounds the quantity to 1..50 whole units', () => {
    const parse = (input: unknown) => addToCart.input.safeParse(input)
    expect(parse({ stockcode: 1, quantity: 50 }).success).toBe(true)
    expect(parse({ stockcode: 1, quantity: 51 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: 0 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: -3 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: 1.5 }).success).toBe(false)
    expect(parse({ stockcode: '1' }).success).toBe(false)
  })
})

describe('set_cart_quantity', () => {
  it('sets the absolute quantity with one write and no read', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json(loadFixture('trolley-two-items.json')))
    const result = await setCartQuantity.run(
      ctx,
      setCartQuantity.input.parse({ stockcode: 88436, quantity: 2 }),
    )
    expect(ctx.events).toEqual(['ensure', 'POST /api/v3/ui/trolley/update'])
    expect(ctx.fetches[0]?.json).toEqual({ items: [{ stockcode: 88436, quantity: 2 }] })
    expect(result.cart?.subtotal).toBe(11.8)
    expect(setCartQuantity.output.parse(result)).toEqual(result)
  })

  it('reports the cart as null when the update response is not a trolley', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json({ Success: true }))
    const result = await setCartQuantity.run(
      ctx,
      setCartQuantity.input.parse({ stockcode: 88436, quantity: 2 }),
    )
    expect(result).toEqual({ stockcode: 88436, quantity: 2, cart: null })
  })

  it('reports a blocked write as blocked-by-site', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json({}, 403))
    const error = await setCartQuantity
      .run(ctx, setCartQuantity.input.parse({ stockcode: 88436, quantity: 2 }))
      .catch((e: unknown) => e)
    expect(error).toEqual(new SiteAdapterError('tool-run', 'blocked-by-site'))
  })

  it('bounds the quantity to 0..50 whole units', () => {
    const parse = (input: unknown) => setCartQuantity.input.safeParse(input)
    expect(parse({ stockcode: 1, quantity: 0 }).success).toBe(true)
    expect(parse({ stockcode: 1, quantity: 50 }).success).toBe(true)
    expect(parse({ stockcode: 1, quantity: 51 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: -1 }).success).toBe(false)
    expect(parse({ stockcode: 1, quantity: 2.5 }).success).toBe(false)
    expect(parse({ stockcode: 1 }).success).toBe(false)
  })
})

describe('remove_from_cart', () => {
  it('sets the quantity to zero with one write', async () => {
    const ctx = new FakeToolContext().on('POST', UPDATE, json(loadFixture('trolley-empty.json')))
    const result = await removeFromCart.run(ctx, removeFromCart.input.parse({ stockcode: 88436 }))
    expect(ctx.events).toEqual(['ensure', 'POST /api/v3/ui/trolley/update'])
    expect(ctx.fetches[0]?.json).toEqual({ items: [{ stockcode: 88436, quantity: 0 }] })
    expect(result).toMatchObject({ stockcode: 88436, removed: true, cart: { items: [] } })
    expect(removeFromCart.output.parse(result)).toEqual(result)
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
      ctx.ensureResult = { status: 'needsUser', reason: 'CAPTCHA shown' }
      const error = await run(ctx).catch((e: unknown) => e)
      expect(error).toEqual(new SiteAdapterError('tool-run', 'not-logged-in'))
      expect(ctx.fetches).toEqual([])
    })

    it(`${name} makes no request when the login failed`, async () => {
      const ctx = new FakeToolContext()
        .on('GET', TROLLEY, json(loadFixture('trolley-empty.json')))
        .on('POST', UPDATE, json({}))
      ctx.ensureResult = { status: 'failed', stage: 'credential', errorClass: 'locked' }
      const error = await run(ctx).catch((e: unknown) => e)
      expect(error).toEqual(new SiteAdapterError('credential', 'locked'))
      expect(ctx.fetches).toEqual([])
    })
  }
})
