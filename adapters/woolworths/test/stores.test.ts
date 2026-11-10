// The store setting's two tools (D69). The site's shapes here are assumptions (stores.ts), so the
// tests pin what the adapter does with them: what reaches the person, and when it refuses to go on.

import { settingChoicesSchema, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { applyStore, findStores } from '../src/stores'
import { FakeToolContext, json } from './fake-context'

const STORES = '/api/v3/ui/fulfilment/stores'
const FULFILMENT = '/api/v3/ui/fulfilment'

const TOWN_HALL = {
  FulfilmentStoreId: 1201,
  AddressId: 9001201,
  Description: 'Woolworths Town Hall',
  Street1: 'Cnr Park & George Streets',
  Suburb: 'Sydney',
  State: 'NSW',
  Postcode: '2000',
}

const find = (ctx: FakeToolContext, query: string) => findStores.run(ctx, { query })
const apply = (ctx: FakeToolContext, value: string) => applyStore.run(ctx, applyStore.input.parse({ value }))

describe('find_stores', () => {
  it('lists a postcode’s stores as choices: address id, name, and address', async () => {
    const ctx = new FakeToolContext().on('GET', STORES, json([TOWN_HALL]))
    const result = await find(ctx, ' 2000 ')
    expect(result).toEqual({
      choices: [
        {
          value: '9001201',
          label: 'Woolworths Town Hall',
          detail: 'Cnr Park & George Streets, Sydney, NSW, 2000',
        },
      ],
    })
    expect(ctx.fetches.map((f) => f.url)).toEqual([
      'https://www.woolworths.test/api/v3/ui/fulfilment/stores?postcode=2000',
    ])
    expect(settingChoicesSchema.parse(result)).toEqual(result)
  })

  it.each(['', 'sydney', '200', '20000', '2000&x=1', '../2000', '２０００'])(
    'finds nothing for %j without calling the site',
    async (query) => {
      const ctx = new FakeToolContext()
      expect(await find(ctx, query)).toEqual({ choices: [] })
      expect(ctx.fetches).toEqual([])
    },
  )

  it('strips markup from the site’s text and keeps it to one line', async () => {
    const ctx = new FakeToolContext().on(
      'GET',
      STORES,
      json([
        {
          AddressId: 5,
          Description: '<img src=x onerror=alert(1)>Metro\n<b>Wynyard</b>',
          Street1: '301 George&nbsp;St<br>Level 1',
        },
      ]),
    )
    expect(await find(ctx, '2000')).toEqual({
      choices: [{ value: '5', label: 'Metro Wynyard', detail: '301 George St Level 1' }],
    })
  })

  it('leaves out a store it cannot read or name, and gives no detail without an address', async () => {
    const ctx = new FakeToolContext().on(
      'GET',
      STORES,
      json([
        { Description: 'No address id' },
        { AddressId: 'x', Description: 'Wrong type' },
        { AddressId: 7, Description: '   ' },
        'not a store',
        { AddressId: 8, Description: 'Harbourside' },
      ]),
    )
    expect(await find(ctx, '2000')).toEqual({ choices: [{ value: '8', label: 'Harbourside' }] })
  })

  it('offers at most fifty, each within the lengths the runtime accepts', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      AddressId: i + 1,
      Description: 'S'.repeat(300),
      Street1: 'A'.repeat(300),
      Suburb: 'B'.repeat(300),
      State: 'C'.repeat(300),
    }))
    const result = await find(new FakeToolContext().on('GET', STORES, json(many)), '2000')
    expect(result.choices).toHaveLength(50)
    expect(settingChoicesSchema.safeParse(result).success).toBe(true)
  })

  it('reports a list in another shape as a changed site', async () => {
    const ctx = new FakeToolContext().on('GET', STORES, json({ Stores: [TOWN_HALL] }))
    await expect(find(ctx, '2000')).rejects.toEqual(new ValetError('tool-run', 'site-changed'))
  })

  it('reports a block page as blocked by the site', async () => {
    const ctx = new FakeToolContext().on('GET', STORES, {
      status: 403,
      contentType: 'text/html',
      body: '<html>Access Denied</html>',
    })
    await expect(find(ctx, '2000')).rejects.toEqual(new ValetError('tool-run', 'blocked-by-site'))
  })
})

describe('apply_store', () => {
  it('chooses the store for pick-up with one write', async () => {
    const ctx = new FakeToolContext().on(
      'POST',
      FULFILMENT,
      json({ IsSuccessful: true, AddressId: 9001201, FulfilmentMethod: 'Pickup' }),
    )
    expect(await apply(ctx, '9001201')).toEqual({})
    expect(ctx.fetches).toHaveLength(1)
    expect(ctx.fetches[0]).toMatchObject({
      method: 'POST',
      path: FULFILMENT,
      json: { addressId: 9001201, fulfilmentMethod: 'Pickup' },
    })
  })

  it.each(['', '0', '-1', '1.5', '9001201 ', 'abc', '1e3', '1234567890123'])(
    'does not accept %j as a store',
    (value) => {
      expect(applyStore.input.safeParse({ value }).success).toBe(false)
    },
  )

  it('fails when the site says the choice was not taken', async () => {
    const ctx = new FakeToolContext().on('POST', FULFILMENT, json({ IsSuccessful: false }))
    await expect(apply(ctx, '9001201')).rejects.toEqual(new ValetError('tool-run', 'unavailable'))
  })

  it('fails when the site answers with another store', async () => {
    const ctx = new FakeToolContext().on('POST', FULFILMENT, json({ IsSuccessful: true, AddressId: 42 }))
    await expect(apply(ctx, '9001201')).rejects.toEqual(new ValetError('tool-run', 'site-changed'))
  })

  it('fails on a refusal, and never retries the write', async () => {
    const ctx = new FakeToolContext().on(
      'POST',
      FULFILMENT,
      json({ Message: 'The request is invalid.' }, 400),
    )
    await expect(apply(ctx, '9001201')).rejects.toEqual(new ValetError('tool-run', 'unavailable'))
    expect(ctx.fetches).toHaveLength(1)
  })

  it('makes no call once the run is cancelled', async () => {
    const ctx = new FakeToolContext()
    ctx.controller.abort()
    await expect(apply(ctx, '9001201')).rejects.toEqual(new ValetError('tool-run', 'aborted'))
    expect(ctx.fetches).toEqual([])
  })
})
