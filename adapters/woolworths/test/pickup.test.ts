// Pick-up times (pickup.ts). The times list is a live capture (Bracken Ridge, signed out,
// 2026-11-28, cut to two days); what the site answers to a reservation signed in is unseen, so the
// tests pin both answers it might give.

import { ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { choosePickupTime, listPickupTimes, PICKUP_NOTICES } from '../src/pickup'
import { FakeToolContext, json, loadFixture } from './fake-context'

const STORES = '/api/v3/ui/fulfilment/stores'
const WINDOWS = '/api/v3/ui/fulfilment/windows'
const FULFILMENT = '/apis/ui/Fulfilment'

const BRACKEN_RIDGE = {
  Description: 'Bracken Ridge',
  Distance: 1.2,
  FulfilmentMethod: 'DriveUp',
  AddressId: 12929425,
  Street1: 'Cnr Barrett & Gawain Rds',
  Suburb: 'BRACKEN RIDGE',
  Postcode: '4017',
  AreaId: 4147,
  FulfilmentStoreId: 4224,
  FulfilmentDeliveryMethods: ['DriveUp', 'DTBNow'],
}
const SANDGATE = {
  ...BRACKEN_RIDGE,
  Description: 'Sandgate',
  AddressId: 5,
  AreaId: 6,
  FulfilmentMethod: 'Pickup',
}

function site(): FakeToolContext {
  return new FakeToolContext()
    .on('GET', STORES, json([SANDGATE, BRACKEN_RIDGE]))
    .on('GET', WINDOWS, json(loadFixture('pickup-windows-bracken-ridge.json')))
}

describe('list_pickup_times', () => {
  const list = (ctx: FakeToolContext, store: string) =>
    listPickupTimes.run(ctx, listPickupTimes.input.parse({ postcode: '4017', store }))

  it('lists the store’s times by day, by its AreaId and its own method, leaving out "from 30 minutes"', async () => {
    const ctx = site()
    const result = await list(ctx, 'Bracken Ridge')
    expect(ctx.fetches.map((f) => f.url)).toEqual([
      'https://www.woolworths.test/api/v3/ui/fulfilment/stores?postcode=4017',
      'https://www.woolworths.test/api/v3/ui/fulfilment/windows?areaId=4147&fulfilmentMethod=DriveUp',
    ])
    expect(result.store).toEqual({ name: 'Bracken Ridge', method: 'DriveUp' })
    expect(result.storesInPostcode).toEqual(['Sandgate', 'Bracken Ridge'])
    expect(result.days.map((d) => d.date)).toEqual(['2026-11-28', '2026-11-29'])
    expect(result.days[0]?.times).toEqual([
      { id: 1116912, start: '13:00', end: '14:00', label: '1pm - 2pm', available: true, price: 0 },
      { id: 1116925, start: '14:00', end: '15:00', label: '2pm - 3pm', available: true, price: 0 },
    ])
    expect(result.notices).toEqual([])
    expect(listPickupTimes.output.parse(result)).toEqual(result)
  })

  it('matches the name without case or a leading "Woolworths"', async () => {
    expect((await list(site(), 'woolworths  BRACKEN ridge')).store?.name).toBe('Bracken Ridge')
  })

  it('names the postcode’s stores, and lists nothing, when none matches', async () => {
    const ctx = site()
    expect(await list(ctx, 'Chermside')).toEqual({
      store: null,
      storesInPostcode: ['Sandgate', 'Bracken Ridge'],
      days: [],
      notices: [PICKUP_NOTICES.storeNotFound],
    })
    expect(ctx.fetches).toHaveLength(1)
  })

  it('marks a full time unavailable, and a day with none left unavailable', async () => {
    const body = loadFixture('pickup-windows-bracken-ridge.json')
    for (const time of body.Days[1].Times) time.Available = false
    const ctx = new FakeToolContext().on('GET', STORES, json([BRACKEN_RIDGE])).on('GET', WINDOWS, json(body))
    const result = await list(ctx, 'Bracken Ridge')
    expect(result.days[1]).toMatchObject({ available: false })
    expect(result.days[1]?.times.every((t) => !t.available)).toBe(true)
  })

  it('reports a times list in another shape as site-changed', async () => {
    const ctx = new FakeToolContext()
      .on('GET', STORES, json([BRACKEN_RIDGE]))
      .on('GET', WINDOWS, json({ Windows: [] }))
    await expect(list(ctx, 'Bracken Ridge')).rejects.toMatchObject({ errorClass: 'site-changed' })
  })

  it('refuses a postcode that isn’t four digits before calling the site', () => {
    expect(() => listPickupTimes.input.parse({ postcode: '4017&x=1', store: 'Bracken Ridge' })).toThrow()
  })
})

describe('choose_pickup_time', () => {
  const choose = (ctx: FakeToolContext, timeId: number, store = 'Bracken Ridge') =>
    choosePickupTime.run(ctx, choosePickupTime.input.parse({ postcode: '4017', store, timeId }))

  it('logs in first, then reserves the time as the site’s own button does', async () => {
    const ctx = site().on('POST', FULFILMENT, json({ IsSuccessful: true }))
    const result = await choose(ctx, 1164028)
    expect(ctx.events[0]).toBe('ensure')
    expect(ctx.fetches.at(-1)?.json).toEqual({
      fulfilmentMethod: 'DriveUp',
      addressId: 12929425,
      timeslotId: 1164028,
      windowDate: '2026-11-29T00:00:00.0000000',
    })
    expect(result).toEqual({
      store: { name: 'Bracken Ridge', method: 'DriveUp' },
      date: '2026-11-29',
      start: '08:00',
      end: '09:00',
      label: '8am - 9am',
      price: 0,
      confirmed: true,
      notices: [],
    })
    expect(choosePickupTime.output.parse(result)).toEqual(result)
  })

  it('takes a bare 200 as done, unconfirmed, and says so', async () => {
    const ctx = site().on('POST', FULFILMENT, { status: 200, contentType: '', body: '' })
    expect(await choose(ctx, 1116912)).toMatchObject({ confirmed: false, notices: [PICKUP_NOTICES.noBody] })
  })

  it('reports the site refusing the time as unavailable', async () => {
    const ctx = site().on('POST', FULFILMENT, json({ IsSuccessful: false }))
    await expect(choose(ctx, 1116912)).rejects.toMatchObject({ stage: 'tool-run', errorClass: 'unavailable' })
  })

  it.each([
    ['a time the list doesn’t have', 999],
    ['"from 30 minutes", which isn’t reserved ahead', 829525],
  ])('refuses %s, sending nothing', async (_, timeId) => {
    const ctx = site()
    const error = await choose(ctx, timeId).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValetError)
    expect(error).toMatchObject({ stage: 'tool-input', issue: { path: ['timeId'], reason: 'not-accepted' } })
    expect(ctx.fetches.map((f) => f.method)).toEqual(['GET', 'GET'])
  })

  it('refuses a full time, sending nothing', async () => {
    const body = loadFixture('pickup-windows-bracken-ridge.json')
    body.Days[0].Times[1].Available = false
    const ctx = new FakeToolContext().on('GET', STORES, json([BRACKEN_RIDGE])).on('GET', WINDOWS, json(body))
    await expect(choose(ctx, 1116912)).rejects.toMatchObject({ stage: 'tool-input' })
    expect(ctx.fetches.every((f) => f.method === 'GET')).toBe(true)
  })

  it('refuses a store the postcode doesn’t have, on store', async () => {
    const ctx = site()
    await expect(choose(ctx, 1116912, 'Chermside')).rejects.toMatchObject({
      stage: 'tool-input',
      issue: { path: ['store'], reason: 'not-accepted' },
    })
    expect(ctx.fetches).toHaveLength(1)
  })
})
