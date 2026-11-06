// The scrubbed fixtures captured from woolworths.com.au (see fixtures/README.md), typed. They come
// from fixture-data.ts, which imports the JSON as modules, so a bundle carries them inline. Every
// accessor returns a fresh deep copy, so request handlers can fill one in without touching the
// shared original.

import { type FixtureName, fixtureFile } from './fixture-data'

/** A product exactly as the site's search and detail APIs return it. Most fields pass through untyped. */
export interface Product {
  readonly Stockcode: number
  readonly Name: string
  readonly DisplayName: string
  readonly Brand: string | null
  readonly Variety: string | null
  readonly Price: number
  readonly WasPrice: number
  readonly CupPrice: number
  readonly CupString: string
  readonly PackageSize: string
  readonly IsOnSpecial: boolean
  readonly IsAvailable: boolean
  readonly SupplyLimit: number
  readonly [field: string]: unknown
}

export type JsonObject = { [key: string]: unknown }

/** One synthetic catalogue row: the values a product varies by. */
export interface CatalogueEntry {
  readonly stockcode: number
  readonly displayName: string
  readonly name: string
  readonly brand: string
  readonly variety: string
  readonly packageSize: string
  readonly price: number
  readonly wasPrice: number
  readonly cupPrice: number
  readonly cupMeasure: string
  readonly department: string
  readonly aisle: string
  readonly available: boolean
}

const load = (name: FixtureName): unknown => fixtureFile(name)

// The envelope types below name only the fields the fake fills in; the rest pass through as captured.

export interface ProductTag {
  readonly Content: { readonly Type: string; readonly Attributes: JsonObject }
}

export interface ProductBody {
  Name: string
  SupplyLimitMessage: string
  AdditionalAttributes: JsonObject
  HeaderTag: JsonObject | null
  ImageTag: JsonObject
  CentreTag: unknown
  Tags: ProductTag[]
  [field: string]: unknown
}

export interface SearchBody {
  Products: unknown[]
  SearchResultsCount: number
  Corrections: unknown
  SuggestedTerm: unknown
  [field: string]: unknown
}

export interface TrolleyBody {
  AvailableItems: unknown[]
  UnavailableItems: unknown[]
  Errors: unknown[]
  Totals: JsonObject
  TotalTrolleyItemQuantity: number
  TotalWowDeliveryTrolleyItemQuantity: number
  TrolleyItemCount: number
  [field: string]: unknown
}

export interface DetailBody {
  Product: { Stockcode?: unknown; [field: string]: unknown } | null
  PrimaryCategory: JsonObject | null
  AdditionalAttributes: unknown
  DetailsImagePaths: unknown
  NutritionalInformation: unknown
  [field: string]: unknown
}

/** A real special-price product (Dairy Farmers 2L), used as the template for specials. */
export const specialProductTemplate = (): ProductBody => load('product-special.json') as ProductBody
/** A real regular-price product (Woolworths 2L), used as the template for everything else. */
export const regularProductTemplate = (): ProductBody => load('product-regular.json') as ProductBody
export const searchResponseTemplate = (): SearchBody => load('search-response.json') as SearchBody
export const emptyTrolleyTemplate = (): TrolleyBody => load('trolley-empty.json') as TrolleyBody
export const productDetailTemplate = (): DetailBody => load('product-detail.json') as DetailBody
export const catalogueEntries = (): CatalogueEntry[] => load('catalogue.json') as CatalogueEntry[]
