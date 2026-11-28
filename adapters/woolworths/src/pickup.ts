// Pick-up times: list a store's times, and reserve one for the cart. Reserving a time is what the
// site's own "Reserve time" button does; it places no order and takes no payment. The order is still
// placed by the person, in their own browser, from the cart page.
//
// Seen live (2026-11-28, signed out, and the site's own scripts): a store's times come from
// GET /api/v3/ui/fulfilment/windows?areaId=&fulfilmentMethod=, by the store's AreaId from the store
// list. The site reserves one with the same POST /apis/ui/Fulfilment that chooses a store, with
// { fulfilmentMethod, addressId, timeslotId, windowDate } where windowDate is the day's Date exactly
// as the times list sent it. What it answers signed in is unseen; choosing a store signed in
// answered a bare 200, so a bare 200 is taken as done here too, and said so.
//
// The agent names the store by postcode and name, as the person would ("Bracken Ridge, 4017"),
// because tool code never sees which store the person chose in Valet.

import { tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { withLogin } from './login'
import { getJson, PATHS, postJsonOrEmpty } from './site'
import { htmlToText } from './text'
import {
  fulfilmentWire,
  type PickupStoreWire,
  type PickupWindowsWire,
  pickupStoresWire,
  pickupStoreWire,
  pickupWindowsWire,
} from './wire'

/** Days of times listed, from today. The site sends about a week. */
export const MAX_PICKUP_DAYS = 7
/** Times listed for one day. The site sends at most 14 a day for a store (live, 2026-11-28). */
export const MAX_TIMES_PER_DAY = 24

/** Fixed notes, so no page text reaches the client through them. */
export const PICKUP_NOTICES = {
  noBody:
    'The site took the request without saying anything back, as it does when a store is chosen. Check the time on the Woolworths site.',
  storeNotFound:
    'No store in this postcode has that name. storesInPostcode lists the ones that do; call again with one of them.',
} as const

const postcodeSchema = z
  .string()
  .regex(/^\d{4}$/)
  .describe('The store’s four-digit postcode, e.g. "4017".')
const storeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe('The store’s name, e.g. "Bracken Ridge". "Woolworths" in front is optional.')

interface Store {
  readonly name: string
  readonly addressId: number
  readonly areaId: number
  readonly method: string
}

/** A store's name, compared without case, spaces or a leading "Woolworths". */
function comparable(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^woolworths\s+/, '')
}

/** Site text for the client: tags and entities removed, one line, at most `max` characters. */
function line(value: unknown, max: number): string | null {
  const plain = htmlToText(value)?.replace(/\s+/g, ' ').trim() ?? ''
  return plain.length === 0 ? null : plain.slice(0, max)
}

/** The postcode's stores with what the times need: a name, an AreaId and a method. */
async function storesIn(ctx: Parameters<typeof getJson>[0], postcode: string): Promise<Store[]> {
  const raw = await getJson(ctx, `${PATHS.pickupStores}?postcode=${postcode}`, pickupStoresWire)
  const stores: Store[] = []
  for (const element of raw) {
    const parsed = pickupStoreWire.safeParse(element)
    if (!parsed.success) continue
    const store: PickupStoreWire = parsed.data
    const name = line(store.Description, 80)
    if (name === null || store.AreaId == null) continue
    const method = store.FulfilmentMethod === 'DriveUp' ? 'DriveUp' : 'Pickup'
    stores.push({ name, addressId: store.AddressId, areaId: store.AreaId, method })
  }
  return stores
}

function matching(stores: readonly Store[], name: string): Store | null {
  const wanted = comparable(name)
  const found = stores.filter((store) => comparable(store.name) === wanted)
  return found.length === 1 ? (found[0] as Store) : null
}

const DATE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/

interface Time {
  readonly id: number
  readonly date: string
  readonly start: string
  readonly end: string
  readonly label: string | null
  readonly available: boolean
  readonly price: number | null
  /** The day's Date exactly as the site sent it: what reserving the time takes back. */
  readonly windowDate: string
}

/** The times, by day, in the site's order. A time the adapter can't read is left out. */
function readTimes(body: PickupWindowsWire): { date: string; available: boolean; times: Time[] }[] {
  const days = []
  for (const day of body.Days.slice(0, MAX_PICKUP_DAYS)) {
    const date = DATE.exec(day.Date)?.[1]
    if (date === undefined) continue
    const times: Time[] = []
    for (const time of day.Times) {
      // Express and "direct to boot now" (from 30 minutes) aren't times to reserve ahead.
      if (time.IsExpress === true || time.IsDirectToBootNow === true) continue
      const start = DATE.exec(time.StartDateTime)
      const end = DATE.exec(time.EndDateTime)
      if (start === null || end === null) continue
      times.push({
        id: time.Id,
        date: start[1] as string,
        start: start[2] as string,
        end: end[2] as string,
        label: line(time.TimeWindow, 40),
        available: time.Available === true,
        price: time.SalePrice ?? null,
        windowDate: day.Date,
      })
      if (times.length === MAX_TIMES_PER_DAY) break
    }
    days.push({ date, available: day.Available === true && times.some((t) => t.available), times })
  }
  return days
}

async function timesFor(ctx: Parameters<typeof getJson>[0], store: Store) {
  const query = `areaId=${store.areaId}&fulfilmentMethod=${store.method}`
  return readTimes(await getJson(ctx, `${PATHS.pickupWindows}?${query}`, pickupWindowsWire))
}

const timeSchema = z.object({
  id: z.number().int().describe('What choose_pickup_time takes as timeId.'),
  start: z.string().describe('Store local time, 24-hour, e.g. "13:00".'),
  end: z.string(),
  label: z.string().nullable().describe('The site’s own label, e.g. "1pm - 2pm".'),
  available: z.boolean().describe('False when the time is full or closed.'),
  price: z.number().nullable().describe('The pick-up fee in dollars, usually 0.'),
})
const storeSchema = z.object({
  name: z.string(),
  method: z.enum(['Pickup', 'DriveUp']).describe('DriveUp is direct to boot.'),
})

export const listPickupTimes = tool({
  input: z.object({ postcode: postcodeSchema, store: storeNameSchema }).strict(),
  output: z.object({
    store: storeSchema.nullable().describe('The store the times are for; null when none matched.'),
    storesInPostcode: z.array(z.string()).describe('The names of the stores in the postcode.'),
    days: z.array(
      z.object({
        date: z.string().describe('YYYY-MM-DD, the store’s date.'),
        available: z.boolean().describe('Whether any time that day can be chosen.'),
        times: z.array(timeSchema),
      }),
    ),
    notices: z.array(z.string()),
  }),
  async run(ctx, input) {
    const stores = await storesIn(ctx, input.postcode)
    const storesInPostcode = stores.map((s) => s.name)
    const store = matching(stores, input.store)
    if (store === null) {
      return { store: null, storesInPostcode, days: [], notices: [PICKUP_NOTICES.storeNotFound] }
    }
    const days = (await timesFor(ctx, store)).map((day) => ({
      date: day.date,
      available: day.available,
      times: day.times.map(({ id, start, end, label, available, price }) => ({
        id,
        start,
        end,
        label,
        available,
        price,
      })),
    }))
    return {
      store: { name: store.name, method: store.method as 'Pickup' | 'DriveUp' },
      storesInPostcode,
      days,
      notices: [],
    }
  },
})

export const choosePickupTime = tool({
  input: z
    .object({
      postcode: postcodeSchema,
      store: storeNameSchema,
      timeId: z
        .number()
        .int()
        .min(1)
        .max(999_999_999)
        .describe('A time’s id, as list_pickup_times gives it. It must be available.'),
    })
    .strict(),
  output: z.object({
    store: storeSchema,
    date: z.string(),
    start: z.string(),
    end: z.string(),
    label: z.string().nullable(),
    price: z.number().nullable(),
    confirmed: z
      .boolean()
      .describe('True when the site said the time was reserved; false when it took it without a word.'),
    notices: z.array(z.string()),
  }),
  async run(ctx, input) {
    return withLogin(ctx, async () => {
      const store = matching(await storesIn(ctx, input.postcode), input.store)
      if (store === null) {
        throw new ValetError('tool-input', 'invalid', { path: ['store'], reason: 'not-accepted' })
      }
      const time = (await timesFor(ctx, store)).flatMap((day) => day.times).find((t) => t.id === input.timeId)
      // A time that isn't listed, or is full, is refused before anything is sent.
      if (time === undefined || !time.available) {
        throw new ValetError('tool-input', 'invalid', { path: ['timeId'], reason: 'not-accepted' })
      }
      const reply = await postJsonOrEmpty(
        ctx,
        PATHS.fulfilment,
        {
          fulfilmentMethod: store.method,
          addressId: store.addressId,
          timeslotId: time.id,
          windowDate: time.windowDate,
        },
        fulfilmentWire,
      )
      if (reply !== null && reply.IsSuccessful === false) throw new ValetError('tool-run', 'unavailable')
      const confirmed = reply !== null && reply.IsSuccessful === true
      return {
        store: { name: store.name, method: store.method as 'Pickup' | 'DriveUp' },
        date: time.date,
        start: time.start,
        end: time.end,
        label: time.label,
        price: time.price,
        confirmed,
        notices: confirmed ? [] : [PICKUP_NOTICES.noBody],
      }
    })
  },
})
