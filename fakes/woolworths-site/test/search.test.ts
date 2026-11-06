import { describe, expect, it } from 'vitest'
import {
  productDetailResponse,
  productNotFoundResponse,
  type SearchQuery,
  searchCatalogue,
  searchQueryFromJson,
  searchQueryFromParams,
  searchResponse,
} from '../src/search'

const milk: SearchQuery = {
  term: 'milk',
  pageSize: 36,
  pageNumber: 1,
  sort: 'TraderRelevance',
  specialsOnly: false,
}

type Group = {
  Products: { Stockcode: number; QuantityInTrolley: number; IsInTrolley: boolean }[]
  Name: string
}

describe('searchQueryFromJson', () => {
  it('reads the body the site itself sends', () => {
    const body = {
      SearchTerm: 'milk',
      PageSize: 3,
      PageNumber: 2,
      SortType: 'PriceAsc',
      Location: '/shop/search/products?searchTerm=milk',
      Filters: [],
      IsSpecial: true,
    }
    expect(searchQueryFromJson(body)).toEqual({
      term: 'milk',
      pageSize: 3,
      pageNumber: 2,
      sort: 'PriceAsc',
      specialsOnly: true,
    })
  })

  it('defaults paging, sort and specials', () => {
    expect(searchQueryFromJson({ SearchTerm: 'milk' })).toEqual(milk)
  })

  it('clamps a page size above the site maximum', () => {
    expect(searchQueryFromJson({ SearchTerm: 'milk', PageSize: 500 })?.pageSize).toBe(36)
    expect(searchQueryFromJson({ SearchTerm: 'milk', PageSize: 0 })?.pageSize).toBe(1)
  })

  it('ignores a non-integer page number', () => {
    expect(searchQueryFromJson({ SearchTerm: 'milk', PageNumber: 1.5 })?.pageNumber).toBe(1)
    expect(searchQueryFromJson({ SearchTerm: 'milk', PageNumber: 'two' })?.pageNumber).toBe(1)
  })

  it('falls back to relevance for an unknown sort', () => {
    expect(searchQueryFromJson({ SearchTerm: 'milk', SortType: 'Cheapest' })?.sort).toBe('TraderRelevance')
  })

  it('only treats IsSpecial true as true', () => {
    expect(searchQueryFromJson({ SearchTerm: 'milk', IsSpecial: 'true' })?.specialsOnly).toBe(false)
  })

  it('rejects a body without a string SearchTerm', () => {
    expect(searchQueryFromJson({ searchTerm: 'milk' })).toBeNull()
    expect(searchQueryFromJson({ SearchTerm: 3 })).toBeNull()
    expect(searchQueryFromJson('milk')).toBeNull()
    expect(searchQueryFromJson(null)).toBeNull()
  })
})

describe('searchQueryFromParams', () => {
  it('reads the GET form with case-insensitive keys', () => {
    const params = new URLSearchParams(
      'SearchTerm=eggs&pageSize=2&PageNumber=3&sortType=PriceDesc&isSpecial=True',
    )
    expect(searchQueryFromParams(params)).toEqual({
      term: 'eggs',
      pageSize: 2,
      pageNumber: 3,
      sort: 'PriceDesc',
      specialsOnly: true,
    })
  })

  it('defaults everything but the term', () => {
    expect(searchQueryFromParams(new URLSearchParams('searchTerm=milk'))).toEqual(milk)
  })

  it('rejects a query without searchTerm', () => {
    expect(searchQueryFromParams(new URLSearchParams('q=milk'))).toBeNull()
  })
})

describe('searchCatalogue', () => {
  it('matches every word of the term, case-insensitively', () => {
    const found = searchCatalogue({ ...milk, term: 'FULL cream' })
    expect(found.map((p) => p.Stockcode)).toEqual([88436, 64746, 888140, 888137])
  })

  it('matches brand, variety and aisle as well as the name', () => {
    expect(searchCatalogue({ ...milk, term: 'vittoria' }).map((p) => p.Stockcode)).toEqual([900602])
    expect(searchCatalogue({ ...milk, term: 'plant based' }).map((p) => p.Stockcode)).toEqual([
      900102, 900103,
    ])
  })

  it('finds nothing for an empty or unknown term', () => {
    expect(searchCatalogue({ ...milk, term: '   ' })).toEqual([])
    expect(searchCatalogue({ ...milk, term: 'caviar' })).toEqual([])
  })

  it('filters to specials', () => {
    const found = searchCatalogue({ ...milk, specialsOnly: true })
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((p) => p.IsOnSpecial)).toBe(true)
  })

  it('sorts by price both ways', () => {
    const asc = searchCatalogue({ ...milk, sort: 'PriceAsc' }).map((p) => p.Price)
    expect(asc).toEqual([...asc].sort((a, b) => a - b))
    const desc = searchCatalogue({ ...milk, sort: 'PriceDesc' }).map((p) => p.Price)
    expect(desc).toEqual([...desc].sort((a, b) => b - a))
  })

  it('sorts by cup price both ways', () => {
    const asc = searchCatalogue({ ...milk, sort: 'CUPAsc' }).map((p) => p.CupPrice)
    expect(asc).toEqual([...asc].sort((a, b) => a - b))
    const desc = searchCatalogue({ ...milk, sort: 'CUPDesc' }).map((p) => p.CupPrice)
    expect(desc).toEqual([...desc].sort((a, b) => b - a))
  })

  it('sorts by name', () => {
    const names = searchCatalogue({ ...milk, sort: 'Name' }).map((p) => p.DisplayName)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})

describe('searchResponse', () => {
  it('wraps each product in its own group, as the site does', () => {
    const response = searchResponse({ ...milk, term: 'tim tam' }, new Map())
    expect(response.SearchResultsCount).toBe(1)
    const groups = response.Products as Group[]
    expect(groups).toHaveLength(1)
    expect(groups[0]?.Name).toBe("Arnott's Tim Tam Original Chocolate Biscuits")
    expect(groups[0]?.Products.map((p) => p.Stockcode)).toEqual([900801])
  })

  it('pages results but reports the total count', () => {
    const first = searchResponse({ ...milk, pageSize: 3, pageNumber: 1 }, new Map())
    const second = searchResponse({ ...milk, pageSize: 3, pageNumber: 2 }, new Map())
    const all = searchCatalogue(milk).map((p) => p.Stockcode)
    const codes = (r: typeof first) => (r.Products as Group[]).map((g) => g.Products[0]?.Stockcode)
    expect(first.SearchResultsCount).toBe(all.length)
    expect(codes(first)).toEqual(all.slice(0, 3))
    expect(codes(second)).toEqual(all.slice(3, 6))
  })

  it('returns an empty page past the end', () => {
    const response = searchResponse({ ...milk, pageNumber: 50 }, new Map())
    expect(response.Products).toEqual([])
    expect(response.SearchResultsCount).toBeGreaterThan(0)
  })

  it('reports no corrections or suggestions', () => {
    const response = searchResponse({ ...milk, term: 'zzz' }, new Map())
    expect(response).toMatchObject({
      SearchResultsCount: 0,
      Products: [],
      Corrections: null,
      SuggestedTerm: null,
    })
  })

  it("marks products already in the visitor's trolley", () => {
    const response = searchResponse({ ...milk, term: 'woolworths full cream' }, new Map([[888137, 2]]))
    const products = (response.Products as Group[]).map((g) => g.Products[0])
    expect(products.find((p) => p?.Stockcode === 888137)).toMatchObject({
      QuantityInTrolley: 2,
      IsInTrolley: true,
    })
    expect(products.find((p) => p?.Stockcode === 888140)).toMatchObject({
      QuantityInTrolley: 0,
      IsInTrolley: false,
    })
  })
})

describe('productDetailResponse', () => {
  it('returns the product with its category placement', () => {
    const detail = productDetailResponse(900601, new Map())
    expect(detail?.Product).toMatchObject({
      Stockcode: 900601,
      DisplayName: expect.stringContaining('Moccona'),
    })
    expect(detail?.PrimaryCategory).toMatchObject({ Department: 'pantry', Aisle: 'coffee' })
    expect(detail?.DetailsImagePaths).toEqual([
      'https://cdn0.woolworths.media/content/wowproductimages/large/900601.jpg',
    ])
    expect(detail?.AdditionalAttributes).toMatchObject({ brand: 'moccona' })
  })

  it('keeps the captured nutrition panel only for the captured product', () => {
    expect(
      (productDetailResponse(88436, new Map())?.NutritionalInformation as unknown[] | undefined)?.length,
    ).toBeGreaterThan(0)
    expect(productDetailResponse(900601, new Map())?.NutritionalInformation).toEqual([])
  })

  it('carries the trolley quantity', () => {
    expect(productDetailResponse(88436, new Map([[88436, 4]]))?.Product).toMatchObject({
      QuantityInTrolley: 4,
    })
  })

  it('returns null for an unknown stockcode', () => {
    expect(productDetailResponse(42, new Map())).toBeNull()
  })

  it('has a not-found body with every envelope field empty', () => {
    const body = productNotFoundResponse()
    expect(body.Product).toBeNull()
    expect(Object.values(body).every((value) => value === null)).toBe(true)
  })
})
