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
  /** Unverified for trolley items: the anonymous capture had an empty trolley. */
  QuantityInTrolley: z.number().nullish(),
})
export type ProductTileWire = z.infer<typeof productTileWire>

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
export const supplyLimitGroupWire = z.object({ Items: z.array(productTileWire) })

/** GET /apis/ui/Trolley. Verified shape for an empty, anonymous trolley; item shape assumed. */
export const trolleyWire = z.object({
  AvailableItems: z.array(productTileWire),
  UnavailableItems: z.array(productTileWire),
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
  Description: z.string().nullish(),
  Street1: z.string().nullish(),
  Suburb: z.string().nullish(),
  State: z.string().nullish(),
  Postcode: z.string().nullish(),
})
export type PickupStoreWire = z.infer<typeof pickupStoreWire>
export const pickupStoresWire = z.array(z.unknown())

/** POST /api/v3/ui/fulfilment. Assumed: a reply that says whether the choice was taken. */
export const fulfilmentWire = z.object({
  IsSuccessful: z.boolean().nullish(),
  AddressId: z.number().nullish(),
})
