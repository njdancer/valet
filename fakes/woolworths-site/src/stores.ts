// Pick-up stores and the two fulfilment endpoints' bodies. Nothing here was captured: the container
// the fake is built in can't reach the live site, and choosing a store was not part of the
// anonymous probe. The paths and shapes are what the site is believed to use, to be confirmed in a
// live session (adapters/woolworths/README.md, "Store").

export interface PickupStore {
  readonly FulfilmentStoreId: number
  /** What `POST /apis/ui/Fulfilment` takes to choose this store. */
  readonly AddressId: number
  readonly Description: string
  readonly Street1: string
  readonly Suburb: string
  readonly State: string
  readonly Postcode: string
  /** What the store's pick-up times are listed by (live, 2026-11-28). */
  readonly AreaId: number
  /** "Pickup", or "DriveUp" for a direct-to-boot store (live: Bracken Ridge). */
  readonly FulfilmentMethod: 'Pickup' | 'DriveUp'
}

export const pickupStores: readonly PickupStore[] = [
  {
    FulfilmentStoreId: 1201,
    AddressId: 9001201,
    Description: 'Woolworths Town Hall',
    Street1: 'Cnr Park & George Streets',
    Suburb: 'Sydney',
    State: 'NSW',
    Postcode: '2000',
    AreaId: 11201,
    FulfilmentMethod: 'Pickup',
  },
  {
    FulfilmentStoreId: 1245,
    AddressId: 9001245,
    Description: 'Woolworths Metro Wynyard',
    Street1: '301 George Street',
    Suburb: 'Sydney',
    State: 'NSW',
    Postcode: '2000',
    AreaId: 11245,
    FulfilmentMethod: 'Pickup',
  },
  {
    FulfilmentStoreId: 1310,
    AddressId: 9001310,
    Description: 'Woolworths Surry Hills',
    Street1: '2-4 Baptist Street',
    Suburb: 'Surry Hills',
    State: 'NSW',
    Postcode: '2010',
    AreaId: 11310,
    FulfilmentMethod: 'Pickup',
  },
  {
    FulfilmentStoreId: 3105,
    AddressId: 9003105,
    Description: 'Woolworths QV',
    Street1: '210 Lonsdale Street',
    Suburb: 'Melbourne',
    State: 'VIC',
    Postcode: '3000',
    AreaId: 13105,
    FulfilmentMethod: 'Pickup',
  },
  {
    FulfilmentStoreId: 4002,
    AddressId: 9004002,
    Description: 'Woolworths Brisbane CBD',
    Street1: '<b>Macarthur Central</b>, 255 Queen Street',
    Suburb: 'Brisbane City',
    State: 'QLD',
    Postcode: '4000',
    AreaId: 14002,
    FulfilmentMethod: 'Pickup',
  },
  {
    FulfilmentStoreId: 4224,
    AddressId: 9004224,
    Description: 'Bracken Ridge',
    Street1: 'Cnr Barrett & Gawain Roads',
    Suburb: 'Bracken Ridge',
    State: 'QLD',
    Postcode: '4017',
    AreaId: 14224,
    FulfilmentMethod: 'DriveUp',
  },
]

/** The `GET /api/v3/ui/fulfilment/stores?postcode=` body, or null for a postcode that isn't one. */
export function storesForPostcode(postcode: string | null): readonly PickupStore[] | null {
  if (postcode === null || !/^\d{4}$/.test(postcode)) return null
  return pickupStores.filter((store) => store.Postcode === postcode)
}

/** What a `POST /apis/ui/Fulfilment` body chooses: a store, and a pick-up time when it names one. */
export interface FulfilmentChoice {
  readonly store: PickupStore
  readonly timeslotId: number | null
}

/**
 * The choice a `POST /apis/ui/Fulfilment` body makes, or null when the body isn't a valid one. Any
 * store takes "Pickup"; a direct-to-boot store also takes "DriveUp". A body with a timeslotId
 * reserves that time: it must be one of the store's available times, with its day's Date as
 * windowDate, as the site's own "Reserve time" button sends it (the site's scripts, 2026-11-28).
 */
export function fulfilmentChosenBy(body: unknown): FulfilmentChoice | null {
  if (typeof body !== 'object' || body === null) return null
  const { addressId, fulfilmentMethod, timeslotId, windowDate } = body as Record<string, unknown>
  if (typeof addressId !== 'number') return null
  const store = pickupStores.find((s) => s.AddressId === addressId)
  if (store === undefined) return null
  if (
    fulfilmentMethod !== 'Pickup' &&
    !(fulfilmentMethod === 'DriveUp' && store.FulfilmentMethod === 'DriveUp')
  )
    return null
  if (timeslotId === undefined || timeslotId === null) return { store, timeslotId: null }
  const day = pickupWindows(store.AreaId)?.Days.find((d) => d.Date === windowDate)
  const time = day?.Times.find((t) => t.Id === timeslotId)
  if (time === undefined || !time.Available || time.IsDirectToBootNow) return null
  return { store, timeslotId: time.Id }
}

/** The first day the fake lists times for. Fixed, so the times are the same in every run. */
export const FIRST_PICKUP_DAY = '2030-03-04'
const HOURS = [9, 10, 11, 13, 14]

interface PickupTime {
  readonly Id: number
  readonly Available: boolean
  readonly TimeWindow: string
  readonly StartDateTime: string
  readonly EndDateTime: string
  readonly SalePrice: number
  readonly IsExpress: boolean
  readonly IsDirectToBootNow: boolean
}

/** A 24-hour hour as the site labels it: 9 is "9am", 13 is "1pm". */
function hourLabel(hour: number): string {
  return hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`
}

/**
 * The `GET /api/v3/ui/fulfilment/windows?areaId=` body for a store, in the live shape (2026-11-28,
 * cut to the fields the adapter reads and a few more): three days, five times a day, ids from the
 * AreaId. The second time of the first day is full. A direct-to-boot store also lists "From 30
 * minutes" first, as live. Null for an AreaId no store has.
 */
export function pickupWindows(
  areaId: number,
): { Days: { Date: string; Available: boolean; Times: PickupTime[] }[] } | null {
  const store = pickupStores.find((s) => s.AreaId === areaId)
  if (store === undefined) return null
  const start = Date.parse(`${FIRST_PICKUP_DAY}T00:00:00Z`)
  const Days = [0, 1, 2].map((offset) => {
    const date = new Date(start + offset * 86_400_000).toISOString().slice(0, 10)
    const at = (hour: number) => `${date}T${String(hour).padStart(2, '0')}:00:00.0000000`
    const Times: PickupTime[] = HOURS.map((hour, slot) => ({
      Id: areaId * 100 + offset * 10 + slot,
      Available: !(offset === 0 && slot === 1),
      TimeWindow: `${hourLabel(hour)} - ${hourLabel(hour + 1)}`,
      StartDateTime: at(hour),
      EndDateTime: at(hour + 1),
      SalePrice: 0,
      IsExpress: false,
      IsDirectToBootNow: false,
    }))
    if (store.FulfilmentMethod === 'DriveUp' && offset === 0) {
      Times.unshift({
        Id: areaId * 100 + 99,
        Available: true,
        TimeWindow: 'From 30 minutes',
        StartDateTime: at(8),
        EndDateTime: at(19),
        SalePrice: 5,
        IsExpress: false,
        IsDirectToBootNow: true,
      })
    }
    return { Date: `${date}T00:00:00.0000000`, Available: true, Times }
  })
  return { Days }
}

/**
 * The `GET /apis/ui/Delivery/DeliveryInfo` body for a session: its pick-up store and reserved time.
 * Signed out it is the live shape (2026-11-28, cut). Signed in, Address's fields are unseen; the
 * fake gives AddressId, which the adapter assumes, and the store's own description.
 */
export function deliveryInfo(fulfilment: {
  readonly addressId: number | null
  readonly timeslotId: number | null
}): Record<string, unknown> {
  const store = pickupStores.find((s) => s.AddressId === fulfilment.addressId)
  const time =
    store === undefined || fulfilment.timeslotId === null
      ? undefined
      : pickupWindows(store.AreaId)
          ?.Days.flatMap((day) => day.Times)
          .find((t) => t.Id === fulfilment.timeslotId)
  return {
    DeliveryMethod: store?.FulfilmentMethod ?? null,
    Address: store === undefined ? null : { AddressId: store.AddressId, Description: store.Description },
    ReservedTime: {
      DeliveryWindowId: 0,
      Id: time?.Id ?? 0,
      TimeWindow: time?.TimeWindow ?? null,
      StartDateTime: time?.StartDateTime ?? null,
      EndDateTime: time?.EndDateTime ?? null,
    },
    FulfilmentStoreId: store?.FulfilmentStoreId ?? 1101,
    MinimumSpend: 50,
  }
}

export function fulfilmentResponse(store: PickupStore): Record<string, unknown> {
  return {
    IsSuccessful: true,
    FulfilmentMethod: 'Pickup',
    AddressId: store.AddressId,
    FulfilmentStoreId: store.FulfilmentStoreId,
  }
}
