// Product tools: search and detail. Both work anonymously, so neither calls session.ensure().

import { SiteAdapterError, tool } from '@siteadapter/core'
import { z } from 'zod'
import { getJson, PATHS, postJson } from './site'
import { htmlToText, httpsUrl, list, text } from './text'
import { type ProductDetailWire, type ProductTileWire, productDetailWire, searchWire } from './wire'

/** Woolworths stockcodes are positive integers; the bound keeps them a plain path segment. */
export const stockcodeSchema = z.number().int().min(1).max(999_999_999)

export const productSummarySchema = z.object({
  stockcode: z.number().int(),
  name: z.string(),
  brand: z.string().nullable(),
  /** Pack size as printed, e.g. "2L". */
  size: z.string().nullable(),
  price: z.number().nullable(),
  /** Unit price as printed, e.g. "$2.10 / 1L". */
  cupPrice: z.string().nullable(),
  /** The pre-special price, only when the product is on special. */
  wasPrice: z.number().nullable(),
  onSpecial: z.boolean(),
  available: z.boolean(),
  imageUrl: z.string().nullable(),
})
export type ProductSummary = z.infer<typeof productSummarySchema>

export function productName(tile: ProductTileWire): string {
  return text(tile.DisplayName) ?? text(tile.Name) ?? `Product ${tile.Stockcode}`
}

export function toProductSummary(tile: ProductTileWire): ProductSummary {
  const price = tile.Price ?? null
  const onSpecial = tile.IsOnSpecial === true
  // The site sends WasPrice equal to Price for products that aren't on special.
  const wasPrice =
    onSpecial && tile.WasPrice != null && (price === null || tile.WasPrice > price) ? tile.WasPrice : null
  return {
    stockcode: tile.Stockcode,
    name: productName(tile),
    brand: text(tile.Brand),
    size: text(tile.PackageSize),
    price,
    cupPrice: text(tile.CupString),
    wasPrice,
    onSpecial,
    available: tile.IsAvailable === true,
    imageUrl: httpsUrl(tile.MediumImageFile),
  }
}

export const MAX_PAGE_SIZE = 36

export const searchProducts = tool({
  input: z.object({
    query: z.string().trim().min(1).max(100),
    page: z.number().int().min(1).max(50).default(1),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(12),
    specialsOnly: z.boolean().default(false),
  }),
  output: z.object({
    /** The number of matches the site reports across all pages. */
    total: z.number().int(),
    /** The site's spelling suggestion, when it made one. */
    suggestedQuery: z.string().nullable(),
    products: z.array(productSummarySchema),
  }),
  async run(ctx, input) {
    const body = await postJson(
      ctx,
      PATHS.search,
      {
        SearchTerm: input.query,
        PageSize: input.pageSize,
        PageNumber: input.page,
        SortType: 'TraderRelevance',
        // Assumed, not seen live: the filter the site's own "specials" toggle sends.
        IsSpecial: input.specialsOnly,
      },
      searchWire,
    )
    const tiles = (body.Products ?? []).flatMap((group) => group.Products ?? [])
    let products = tiles.map(toProductSummary)
    // Filtered here as well, so the answer is right even if the site ignores IsSpecial.
    if (input.specialsOnly) products = products.filter((product) => product.onSpecial)
    return {
      total: body.SearchResultsCount ?? products.length,
      suggestedQuery: text(body.SuggestedTerm),
      products,
    }
  },
})

const nutrientSchema = z.object({ nutrient: z.string(), amount: z.string() })

export const productDetailSchema = productSummarySchema.extend({
  description: z.string().nullable(),
  ingredients: z.string().nullable(),
  allergens: z.object({
    contains: z.array(z.string()),
    mayBePresent: z.array(z.string()),
    /** The site's free-text allergy statement, e.g. "Egg Free,Gluten Free". */
    statement: z.string().nullable(),
  }),
  dietary: z.array(z.string()),
  healthStarRating: z.number().nullable(),
  countryOfOrigin: z.string().nullable(),
  category: z.object({ department: z.string().nullable(), aisle: z.string().nullable() }).nullable(),
  nutrition: z
    .object({
      servingSize: z.string().nullable(),
      servingsPerPack: z.string().nullable(),
      /** Per 100 g or 100 mL, whichever the label uses. */
      per100: z.array(nutrientSchema),
    })
    .nullable(),
})
export type ProductDetail = z.infer<typeof productDetailSchema>

export const getProduct = tool({
  input: z.object({ stockcode: stockcodeSchema }),
  output: productDetailSchema,
  async run(ctx, input) {
    const body = await getJson(ctx, PATHS.productDetail(input.stockcode), productDetailWire)
    if (body.Product == null) throw new SiteAdapterError('tool-run', 'not-found')
    return toProductDetail(body.Product, body)
  },
})

export function toProductDetail(product: ProductTileWire, body: ProductDetailWire): ProductDetail {
  const attributes = body.AdditionalAttributes
  const rating = Number.parseFloat(text(attributes?.healthstarrating) ?? '')
  const category = body.PrimaryCategory
  return {
    ...toProductSummary(product),
    description: htmlToText(attributes?.description),
    ingredients: htmlToText(attributes?.ingredients),
    allergens: {
      contains: list(attributes?.allergencontains),
      mayBePresent: list(attributes?.allergenmaybepresent),
      statement: text(attributes?.allergystatement),
    },
    dietary: list(attributes?.lifestyleanddietarystatement),
    healthStarRating: Number.isFinite(rating) ? rating : null,
    countryOfOrigin: text(body.CountryOfOriginLabel?.AltText),
    category:
      category == null ? null : { department: text(category.Department), aisle: text(category.Aisle) },
    nutrition: toNutrition(body.NutritionalInformation ?? []),
  }
}

/** The per-100 column of the nutrition panel, or null when the product has no panel. */
function toNutrition(
  rows: NonNullable<ProductDetailWire['NutritionalInformation']>,
): ProductDetail['nutrition'] {
  const per100: { nutrient: string; amount: string }[] = []
  for (const row of rows) {
    const key = Object.keys(row.Values ?? {}).find((name) => name.startsWith('Quantity Per 100'))
    const amount = key === undefined ? null : text(row.Values?.[key])
    // "-" means the label leaves the nutrient blank.
    if (amount === null || amount === '-') continue
    // Sub-rows are printed as "– Saturated"; the dash is layout, not part of the name.
    per100.push({ nutrient: row.Name.replace(/^[\s–-]+/, '').trim(), amount })
  }
  if (per100.length === 0) return null
  const first = rows[0]
  return {
    servingSize: text(first?.ServingSize),
    servingsPerPack: text(first?.ServingsPerPack),
    per100,
  }
}
