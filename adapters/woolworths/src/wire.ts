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

/** GET /apis/ui/Trolley. Verified shape for an empty, anonymous trolley; item shape assumed. */
export const trolleyWire = z.object({
  AvailableItems: z.array(productTileWire),
  UnavailableItems: z.array(productTileWire),
  Totals: z.object({ SubTotal: z.number(), TotalSavings: z.number() }),
  TotalTrolleyItemQuantity: z.number().int(),
  TrolleyItemCount: z.number().int(),
  Errors: z.array(z.object({ Message: z.string().nullish() })).nullish(),
})
export type TrolleyWire = z.infer<typeof trolleyWire>
