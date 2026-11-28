// Woolworths response shapes, as captured from the live site on 2026-11-07. Only the fields the
// tools read are declared; zod strips the rest, so nothing else can leak into tool output. Fields
// are nullish because the site sends null for many of them on some products.

import { z } from 'zod'

/** A product as the site sends it in search results, product detail and (assumed) the trolley. */
export const productTileWire = z.object({
  Stockcode: z.number().int(),
  Name: z.string().nullish(),
  DisplayName: z.string().nullish(),
  Brand: z.string().nullish(),
  PackageSize: z.string().nullish(),
  Price: z.number().nullish(),
  WasPrice: z.number().nullish(),
  CupString: z.string().nullish(),
  IsOnSpecial: z.boolean().nullish(),
  IsAvailable: z.boolean().nullish(),
  MediumImageFile: z.string().nullish(),
  /** The line's quantity in the trolley (live, 2026-11-27). */
  QuantityInTrolley: z.number().nullish(),
})
export type ProductTileWire = z.infer<typeof productTileWire>

/**
 * A trolley line, signed in (live, 2026-11-27): a product tile without Price, and with the price of
 * one unit (UnitSalePrice) and of the whole line (SalePrice), in dollars.
 */
export const trolleyLineWire = productTileWire.omit({ Price: true }).extend({
  UnitSalePrice: z.number().nullish(),
  SalePrice: z.number().nullish(),
})
export type TrolleyLineWire = z.infer<typeof trolleyLineWire>

/** POST /apis/ui/Search/products. Results come in groups of variants, each with its own products. */
export const searchWire = z.object({
  SearchResultsCount: z.number().int().nullish(),
  SuggestedTerm: z.string().nullish(),
  Products: z.array(z.object({ Products: z.array(productTileWire).nullish() })).nullish(),
})

export const nutrientWire = z.object({
  Name: z.string(),
  Values: z.record(z.string(), z.string().nullable()).nullish(),
  ServingSize: z.string().nullish(),
  ServingsPerPack: z.string().nullish(),
})

/** GET /apis/ui/product/detail/:stockcode */
export const productDetailWire = z.object({
  Product: productTileWire.nullish(),
  PrimaryCategory: z.object({ Department: z.string().nullish(), Aisle: z.string().nullish() }).nullish(),
  /** Free-form attribute strings; the mapper tolerates any type, so these stay unknown. */
  AdditionalAttributes: z
    .object({
      description: z.unknown(),
      ingredients: z.unknown(),
      allergencontains: z.unknown(),
      allergenmaybepresent: z.unknown(),
      allergystatement: z.unknown(),
      lifestyleanddietarystatement: z.unknown(),
      healthstarrating: z.unknown(),
    })
    .nullish(),
  NutritionalInformation: z.array(nutrientWire).nullish(),
  CountryOfOriginLabel: z.object({ AltText: z.string().nullish() }).nullish(),
})
export type ProductDetailWire = z.infer<typeof productDetailWire>

/**
 * The trolley's other buckets. The captured trolley had every one of them empty, so the item shape
 * is unconfirmed: elements stay unknown here and are parsed one by one, so an item in an unexpected
 * shape is counted as unreadable instead of failing the whole trolley.
 */
const unconfirmedBucket = z.array(z.unknown()).nullish()

/** Assumed, not seen live: a supply-limit group holds its products under Items. */
export const supplyLimitGroupWire = z.object({ Items: z.array(trolleyLineWire) })

/** GET /apis/ui/Trolley. Verified shape for an empty, anonymous trolley; item shape assumed. */
export const trolleyWire = z.object({
  AvailableItems: z.array(trolleyLineWire),
  UnavailableItems: z.array(trolleyLineWire),
  ExceededSupplyLimitGroups: unconfirmedBucket,
  ExceededAtpLimitItems: unconfirmedBucket,
  ConflictedItems: unconfirmedBucket,
  RestrictedItems: unconfirmedBucket,
  RestrictedByCrowdDeliveryItems: unconfirmedBucket,
  RestrictedByDeliPlattersItems: unconfirmedBucket,
  RestrictedByDeliveryMethodItems: unconfirmedBucket,
  RestrictedByIdVerificationItems: unconfirmedBucket,
  RestrictedBySellerDeliverabilityItems: unconfirmedBucket,
  BundleItems: unconfirmedBucket,
  Totals: z.object({ SubTotal: z.number(), TotalSavings: z.number() }),
  TotalTrolleyItemQuantity: z.number().int(),
  TrolleyItemCount: z.number().int(),
  Errors: z.array(z.object({ Message: z.string().nullish() })).nullish(),
})
export type TrolleyWire = z.infer<typeof trolleyWire>

/**
 * POST /api/v3/ui/trolley/update, as the live site answers it (2026-11-27): not the trolley, but the
 * lines the update changed, with totals. A line set to 0 is left out of UpdatedItems.
 */
export const trolleyUpdateWire = z.object({
  UpdatedItems: z.array(trolleyLineWire),
})
export type TrolleyUpdateWire = z.infer<typeof trolleyUpdateWire>

/**
 * The status fields an update reply may carry when it is not a trolley. Assumed, from the shape
 * other Woolworths endpoints use for errors; never seen live for this endpoint.
 */
export const updateStatusWire = z.object({
  Success: z.boolean().nullish(),
  Errors: z.array(z.unknown()).nullish(),
})

/**
 * GET /api/v3/ui/fulfilment/stores?postcode=. Assumed, never seen live: the path, that it answers
 * with an array, and every field name. Only AddressId is needed; a store without it is unusable.
 */
export const pickupStoreWire = z.object({
  AddressId: z.number().int().positive(),
  /** What the store's pick-up times are listed by (live, 2026-11-28). */
  AreaId: z.number().int().positive().nullish(),
  /** "Pickup", or "DriveUp" for a direct-to-boot store such as Bracken Ridge (live, 2026-11-28). */
  FulfilmentMethod: z.string().nullish(),
  Description: z.string().nullish(),
  Street1: z.string().nullish(),
  Suburb: z.string().nullish(),
  State: z.string().nullish(),
  Postcode: z.string().nullish(),
})
export type PickupStoreWire = z.infer<typeof pickupStoreWire>
export const pickupStoresWire = z.array(z.unknown())

/**
 * GET /api/v3/ui/fulfilment/windows?areaId=&fulfilmentMethod=, a store's pick-up times by day, as
 * the live site sends them signed out (2026-11-28). Times are the store's local time, without an
 * offset. Only the fields the tools read are declared.
 */
export const pickupTimeWire = z.object({
  Id: z.number().int().positive(),
  Available: z.boolean().nullish(),
  TimeWindow: z.string().nullish(),
  StartDateTime: z.string(),
  EndDateTime: z.string(),
  SalePrice: z.number().nullish(),
  IsExpress: z.boolean().nullish(),
  /** "From 30 minutes": direct to boot now, which isn't a time to reserve ahead. */
  IsDirectToBootNow: z.boolean().nullish(),
})
export const pickupWindowsWire = z.object({
  Days: z.array(
    z.object({
      Date: z.string(),
      Available: z.boolean().nullish(),
      Times: z.array(pickupTimeWire),
    }),
  ),
})
export type PickupWindowsWire = z.infer<typeof pickupWindowsWire>

/** POST /apis/ui/Fulfilment. The site's scripts read IsSuccessful; AddressId is an assumption. */
export const fulfilmentWire = z.object({
  IsSuccessful: z.boolean().nullish(),
  AddressId: z.number().nullish(),
})
