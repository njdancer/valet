// Product search and product detail, in the captured response envelopes. Search is a plain
// case-insensitive substring match on every word of the term; the real ranking is unknowable and
// tests only need something predictable.

import { catalogue, findProduct, placementOf } from './catalogue'
import {
  type DetailBody,
  type JsonObject,
  type Product,
  productDetailTemplate,
  type SearchBody,
  searchResponseTemplate,
} from './fixtures'
import type { Trolley } from './trolley'

export const MAX_PAGE_SIZE = 36

export type SortType = 'TraderRelevance' | 'PriceAsc' | 'PriceDesc' | 'CUPAsc' | 'CUPDesc' | 'Name'

export interface SearchQuery {
  readonly term: string
  readonly pageSize: number
  readonly pageNumber: number
  readonly sort: SortType
  readonly specialsOnly: boolean
}

const SORTS: readonly SortType[] = ['TraderRelevance', 'PriceAsc', 'PriceDesc', 'CUPAsc', 'CUPDesc', 'Name']

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function sortOf(value: unknown): SortType {
  return SORTS.find((sort) => sort === value) ?? 'TraderRelevance'
}

/** Reads the JSON body of `POST /apis/ui/Search/products`. Null when it isn't a search body. */
export function searchQueryFromJson(body: unknown): SearchQuery | null {
  if (typeof body !== 'object' || body === null) return null
  const fields = body as {
    SearchTerm?: unknown
    PageSize?: unknown
    PageNumber?: unknown
    SortType?: unknown
    IsSpecial?: unknown
  }
  if (typeof fields.SearchTerm !== 'string') return null
  return {
    term: fields.SearchTerm,
    pageSize: clampInt(fields.PageSize, MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    pageNumber: clampInt(fields.PageNumber, 1, 1, 10_000),
    sort: sortOf(fields.SortType),
    specialsOnly: fields.IsSpecial === true,
  }
}

/** Reads the query of `GET /apis/ui/Search/products?searchTerm=…`. Keys are case-insensitive. */
export function searchQueryFromParams(params: URLSearchParams): SearchQuery | null {
  const lower = new Map<string, string>()
  for (const [key, value] of params) lower.set(key.toLowerCase(), value)
  const term = lower.get('searchterm')
  if (term === undefined) return null
  return {
    term,
    pageSize: clampInt(lower.get('pagesize'), MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    pageNumber: clampInt(lower.get('pagenumber'), 1, 1, 10_000),
    sort: sortOf(lower.get('sorttype')),
    specialsOnly: lower.get('isspecial')?.toLowerCase() === 'true',
  }
}

function matches(product: Product, words: readonly string[]): boolean {
  const placement = placementOf(product.Stockcode)
  const haystack = [
    product.DisplayName,
    product.Name,
    product.Brand ?? '',
    product.Variety ?? '',
    placement?.department ?? '',
    placement?.aisle ?? '',
  ]
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

const comparators: Record<SortType, ((a: Product, b: Product) => number) | null> = {
  TraderRelevance: null,
  PriceAsc: (a, b) => a.Price - b.Price,
  PriceDesc: (a, b) => b.Price - a.Price,
  CUPAsc: (a, b) => a.CupPrice - b.CupPrice,
  CUPDesc: (a, b) => b.CupPrice - a.CupPrice,
  Name: (a, b) => a.DisplayName.localeCompare(b.DisplayName),
}

/** Every product matching the query, sorted but not paged. An empty term matches nothing. */
export function searchCatalogue(query: SearchQuery): Product[] {
  const words = query.term.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const found = catalogue.filter(
    (product) => matches(product, words) && (!query.specialsOnly || product.IsOnSpecial),
  )
  const compare = comparators[query.sort]
  return compare === null ? found : [...found].sort(compare)
}

/** Marks a product with the visitor's trolley quantity, as the site does in search results. */
function withTrolley(product: Product, trolley: Trolley): JsonObject {
  const quantity = trolley.get(product.Stockcode) ?? 0
  return { ...structuredClone(product), QuantityInTrolley: quantity, IsInTrolley: quantity > 0 }
}

export function searchResponse(query: SearchQuery, trolley: Trolley): SearchBody {
  const found = searchCatalogue(query)
  const start = (query.pageNumber - 1) * query.pageSize
  const page = found.slice(start, start + query.pageSize)
  const response = searchResponseTemplate()
  response.Products = page.map((product) => ({
    Products: [withTrolley(product, trolley)],
    Name: product.Name,
    DisplayName: product.DisplayName,
  }))
  response.SearchResultsCount = found.length
  response.Corrections = null
  response.SuggestedTerm = null
  return response
}

/** The `GET /apis/ui/product/detail/<stockcode>` body, or null for an unknown stockcode. */
export function productDetailResponse(stockcode: number, trolley: Trolley): DetailBody | null {
  const product = findProduct(stockcode)
  const placement = placementOf(stockcode)
  if (product === null || placement === null) return null
  const response = productDetailTemplate()
  const captured = response.Product?.Stockcode === stockcode
  response.Product = withTrolley(product, trolley)
  response.PrimaryCategory = {
    ...response.PrimaryCategory,
    Department: placement.department,
    Aisle: placement.aisle,
  }
  const { AdditionalAttributes, DetailsImagePaths } = product as { [field: string]: unknown }
  Object.assign(response, { AdditionalAttributes, DetailsImagePaths })
  // Nutrition panels were only captured for one product; the rest report none.
  if (!captured) response.NutritionalInformation = []
  return response
}

/** The 404 body for an unknown stockcode: the detail envelope with every field empty. Assumed. */
export function productNotFoundResponse(): DetailBody {
  const response = productDetailTemplate()
  for (const key of Object.keys(response)) response[key] = null
  return response
}
