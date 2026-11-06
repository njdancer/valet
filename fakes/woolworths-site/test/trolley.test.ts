import { describe, expect, it } from 'vitest'
import { applyTrolleyUpdate, type Trolley, trolleyLines, trolleyResponse } from '../src/trolley'

type Item = { Stockcode: number; Quantity: number; QuantityInTrolley: number; IsInTrolley: boolean }

describe('applyTrolleyUpdate', () => {
  it('adds items with the quantity given', () => {
    const trolley: Trolley = new Map()
    expect(applyTrolleyUpdate(trolley, { items: [{ stockcode: 88436, quantity: 2 }] })).toEqual({ ok: true })
    expect(trolleyLines(trolley)).toEqual([{ stockcode: 88436, quantity: 2 }])
  })

  it('sets rather than increments an existing quantity', () => {
    const trolley: Trolley = new Map([[88436, 5]])
    applyTrolleyUpdate(trolley, { items: [{ stockcode: 88436, quantity: 1 }] })
    expect(trolleyLines(trolley)).toEqual([{ stockcode: 88436, quantity: 1 }])
  })

  it('removes an item set to quantity 0', () => {
    const trolley: Trolley = new Map([
      [88436, 5],
      [900601, 1],
    ])
    applyTrolleyUpdate(trolley, { items: [{ stockcode: 88436, quantity: 0 }] })
    expect(trolleyLines(trolley)).toEqual([{ stockcode: 900601, quantity: 1 }])
  })

  it('applies several items at once and ignores extra fields the site sends', () => {
    const trolley: Trolley = new Map()
    const body = {
      items: [
        { stockcode: 88436, quantity: 1, source: 'ProductDetail', diagnostics: '0', searchTerm: null },
        { stockcode: 900201, quantity: 3, evaluateRewardPoints: false },
      ],
    }
    expect(applyTrolleyUpdate(trolley, body)).toEqual({ ok: true })
    expect(trolleyLines(trolley)).toEqual([
      { stockcode: 88436, quantity: 1 },
      { stockcode: 900201, quantity: 3 },
    ])
  })

  it('reduces a quantity above the supply limit to the limit', () => {
    const trolley: Trolley = new Map()
    applyTrolleyUpdate(trolley, { items: [{ stockcode: 88436, quantity: 500 }] })
    expect(trolley.get(88436)).toBe(36)
  })

  it('accepts an unavailable product, which then shows as unavailable', () => {
    const trolley: Trolley = new Map()
    expect(applyTrolleyUpdate(trolley, { items: [{ stockcode: 900303, quantity: 1 }] })).toEqual({ ok: true })
    expect(trolley.get(900303)).toBe(1)
  })

  it('rejects an unknown stockcode and changes nothing, even if other items were valid', () => {
    const trolley: Trolley = new Map([[88436, 1]])
    const body = {
      items: [
        { stockcode: 900201, quantity: 2 },
        { stockcode: 1, quantity: 1 },
      ],
    }
    expect(applyTrolleyUpdate(trolley, body)).toEqual({ ok: false, reason: 'unknown-product' })
    expect(trolleyLines(trolley)).toEqual([{ stockcode: 88436, quantity: 1 }])
  })

  it('rejects a stockcode given as a string', () => {
    expect(applyTrolleyUpdate(new Map(), { items: [{ stockcode: '88436', quantity: 1 }] })).toEqual({
      ok: false,
      reason: 'stockcode',
    })
  })

  it('rejects negative, fractional and missing quantities', () => {
    for (const quantity of [-1, 1.5, undefined, '2']) {
      expect(applyTrolleyUpdate(new Map(), { items: [{ stockcode: 88436, quantity }] })).toEqual({
        ok: false,
        reason: 'quantity',
      })
    }
  })

  it('rejects bodies that are not an items list', () => {
    expect(applyTrolleyUpdate(new Map(), null)).toEqual({ ok: false, reason: 'body' })
    expect(applyTrolleyUpdate(new Map(), { items: [] })).toEqual({ ok: false, reason: 'items' })
    expect(applyTrolleyUpdate(new Map(), { Items: [{ stockcode: 88436, quantity: 1 }] })).toEqual({
      ok: false,
      reason: 'items',
    })
    expect(applyTrolleyUpdate(new Map(), { items: [null] })).toEqual({ ok: false, reason: 'item' })
  })
})

describe('trolleyResponse', () => {
  it('matches the captured anonymous empty trolley exactly when empty', () => {
    const response = trolleyResponse(new Map())
    expect(response).toMatchObject({
      AvailableItems: [],
      UnavailableItems: [],
      TotalTrolleyItemQuantity: 0,
      TrolleyItemCount: 0,
      Totals: { SubTotal: 0, Total: 0, TotalSavings: 0, MarketTotal: 0 },
      Errors: [
        {
          Type: 'InvalidSubtotal',
          Message: 'Pick up has a $50 minimum spend. Add $50.00 of Woolworths items to continue.',
          ErrorCode: null,
        },
      ],
    })
  })

  it('lists items with their quantity and totals the trolley', () => {
    const response = trolleyResponse(
      new Map([
        [88436, 2],
        [888137, 1],
      ]),
    )
    const items = response.AvailableItems as Item[]
    expect(items.map((i) => [i.Stockcode, i.Quantity, i.QuantityInTrolley, i.IsInTrolley])).toEqual([
      [88436, 2, 2, true],
      [888137, 1, 1, true],
    ])
    expect(response.Totals).toMatchObject({
      SubTotal: 11.8,
      Total: 11.8,
      TotalSavings: 1,
      WoolworthsTotal: 11.8,
    })
    expect(response.TotalTrolleyItemQuantity).toBe(3)
    expect(response.TrolleyItemCount).toBe(2)
    expect(response.Errors).toEqual([
      {
        Type: 'InvalidSubtotal',
        Message: 'Pick up has a $50 minimum spend. Add $38.20 of Woolworths items to continue.',
        ErrorCode: null,
      },
    ])
  })

  it('drops the minimum spend error once the subtotal reaches $50', () => {
    expect(trolleyResponse(new Map([[900602, 2]])).Errors).toEqual([])
  })

  it('puts unavailable items in UnavailableItems and leaves them out of the totals', () => {
    const response = trolleyResponse(
      new Map([
        [900303, 2],
        [888137, 1],
      ]),
    )
    expect((response.UnavailableItems as Item[]).map((i) => i.Stockcode)).toEqual([900303])
    expect((response.AvailableItems as Item[]).map((i) => i.Stockcode)).toEqual([888137])
    expect(response.Totals).toMatchObject({ SubTotal: 3.4 })
    expect(response.TotalTrolleyItemQuantity).toBe(3)
    expect(response.TrolleyItemCount).toBe(2)
  })
})
