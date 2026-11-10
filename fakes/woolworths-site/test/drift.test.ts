import { describe, expect, it } from 'vitest'
import { applyShapeDrift } from '../src/drift'
import { startFakeWoolworths } from '../src/server'
import { Client } from './support/client'

describe('applyShapeDrift', () => {
  const body = { Products: [{ Products: [{ Stockcode: 7, Price: 2, Name: 'x' }] }], Price: 9 }

  it('renames Price on product objects only', () => {
    expect(applyShapeDrift(body, 'renamed-field')).toEqual({
      Products: [{ Products: [{ Stockcode: 7, CurrentPrice: 2, Name: 'x' }] }],
      Price: 9,
    })
  })

  it('turns Stockcode into a string on product objects', () => {
    expect(applyShapeDrift(body, 'changed-type')).toEqual({
      Products: [{ Products: [{ Stockcode: '7', Price: 2, Name: 'x' }] }],
      Price: 9,
    })
  })

  it('leaves the input alone', () => {
    const copy = structuredClone(body)
    applyShapeDrift(body, 'changed-type')
    expect(body).toEqual(copy)
  })
})

describe('setShapeDrift', () => {
  it('drifts product responses while on, and only them', async () => {
    const site = await startFakeWoolworths()
    try {
      const client = new Client(site.origin)
      await client.visit('/')
      const get = async (path: string) => JSON.parse((await client.get(path)).text)
      expect((await get('/apis/ui/product/detail/88436')).Product.Stockcode).toBe(88436)
      site.setShapeDrift('changed-type')
      expect((await get('/apis/ui/product/detail/88436')).Product.Stockcode).toBe('88436')
      expect(await get('/api/ui/v2/bootstrap')).toEqual({
        ShopperDetails: { IsLoggedIn: false, FirstName: null },
      })
      site.setShapeDrift(null)
      expect((await get('/apis/ui/product/detail/88436')).Product.Stockcode).toBe(88436)
      expect(() => site.setShapeDrift('other' as never)).toThrow(/shape drift/)
    } finally {
      await site.close()
    }
  })
})
