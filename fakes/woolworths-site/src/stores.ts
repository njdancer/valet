// Pick-up stores and the two fulfilment endpoints' bodies. Nothing here was captured: the container
// the fake is built in can't reach the live site, and choosing a store was not part of the
// anonymous probe. The paths and shapes are what the site is believed to use, to be confirmed in a
// live session (adapters/woolworths/README.md, "Store").

export interface PickupStore {
  readonly FulfilmentStoreId: number
  /** What `POST /api/v3/ui/fulfilment` takes to choose this store. */
  readonly AddressId: number
  readonly Description: string
  readonly Street1: string
  readonly Suburb: string
  readonly State: string
  readonly Postcode: string
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
  },
  {
    FulfilmentStoreId: 1245,
    AddressId: 9001245,
    Description: 'Woolworths Metro Wynyard',
    Street1: '301 George Street',
    Suburb: 'Sydney',
    State: 'NSW',
    Postcode: '2000',
  },
  {
    FulfilmentStoreId: 1310,
    AddressId: 9001310,
    Description: 'Woolworths Surry Hills',
    Street1: '2-4 Baptist Street',
    Suburb: 'Surry Hills',
    State: 'NSW',
    Postcode: '2010',
  },
  {
    FulfilmentStoreId: 3105,
    AddressId: 9003105,
    Description: 'Woolworths QV',
    Street1: '210 Lonsdale Street',
    Suburb: 'Melbourne',
    State: 'VIC',
    Postcode: '3000',
  },
  {
    FulfilmentStoreId: 4002,
    AddressId: 9004002,
    Description: 'Woolworths Brisbane CBD',
    Street1: '<b>Macarthur Central</b>, 255 Queen Street',
    Suburb: 'Brisbane City',
    State: 'QLD',
    Postcode: '4000',
  },
]

/** The `GET /api/v3/ui/fulfilment/stores?postcode=` body, or null for a postcode that isn't one. */
export function storesForPostcode(postcode: string | null): readonly PickupStore[] | null {
  if (postcode === null || !/^\d{4}$/.test(postcode)) return null
  return pickupStores.filter((store) => store.Postcode === postcode)
}

/** The store a `POST /api/v3/ui/fulfilment` body chooses, or null when the body isn't a valid choice. */
export function storeChosenBy(body: unknown): PickupStore | null {
  if (typeof body !== 'object' || body === null) return null
  const { addressId, fulfilmentMethod } = body as { addressId?: unknown; fulfilmentMethod?: unknown }
  if (fulfilmentMethod !== 'Pickup' || typeof addressId !== 'number') return null
  return pickupStores.find((store) => store.AddressId === addressId) ?? null
}

export function fulfilmentResponse(store: PickupStore): Record<string, unknown> {
  return {
    IsSuccessful: true,
    FulfilmentMethod: 'Pickup',
    AddressId: store.AddressId,
    FulfilmentStoreId: store.FulfilmentStoreId,
  }
}
