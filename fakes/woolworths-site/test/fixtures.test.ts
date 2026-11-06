// Guards on the committed fixtures themselves: they must stay scrubbed, and they must keep the real
// shapes the fake's responses are built from.

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  catalogueEntries,
  emptyTrolleyTemplate,
  productDetailTemplate,
  regularProductTemplate,
  searchResponseTemplate,
  specialProductTemplate,
} from '../src/fixtures'

const fixturesDir = new URL('../fixtures/', import.meta.url)
const fixtureFiles = readdirSync(fixturesDir).filter((name) => name.endsWith('.json'))
const fixtureText = (name: string): string => readFileSync(new URL(name, fixturesDir), 'utf8')

describe('committed fixtures', () => {
  it('include every file the fake loads', () => {
    expect(fixtureFiles.sort()).toEqual([
      'catalogue.json',
      'product-detail.json',
      'product-regular.json',
      'product-special.json',
      'search-response.json',
      'trolley-empty.json',
    ])
  })

  it.each(fixtureFiles)('%s carries no cookie names from the live session', (name) => {
    const text = fixtureText(name)
    for (const cookie of [
      '_abck',
      'bm_sz',
      'bm_sv',
      'bm_so',
      'ak_bmsc',
      'wow-auth-token',
      'prodwow-auth-token',
    ]) {
      expect(text).not.toContain(cookie)
    }
    expect(text.toLowerCase()).not.toContain('set-cookie')
  })

  it.each(fixtureFiles)('%s carries no live per-impression ad identifier', (name) => {
    expect(fixtureText(name)).not.toMatch(/"AdID": "display_(?!fake")/)
  })

  it('trim the huge fields the fake never uses', () => {
    for (const name of fixtureFiles) expect(fixtureText(name).length).toBeLessThan(40_000)
  })
})

describe('fixture shapes', () => {
  it('keep the real search response keys', () => {
    expect(Object.keys(searchResponseTemplate())).toEqual([
      'Products',
      'Corrections',
      'SearchResultsCount',
      'VisualShoppingAisleResponse',
      'Aggregations',
      'HasTobaccoItems',
      'Passes',
      'SuggestedTerm',
      'FacetFilters',
      'AttributionToken',
      'AttributionTokenRef',
    ])
  })

  it('keep the real search group shape', () => {
    const [group] = searchResponseTemplate().Products as Record<string, unknown>[]
    expect(Object.keys(group ?? {})).toEqual(['Products', 'Name', 'DisplayName'])
  })

  it('keep the real trolley keys', () => {
    expect(Object.keys(emptyTrolleyTemplate())).toEqual(
      expect.arrayContaining([
        'AvailableItems',
        'UnavailableItems',
        'Totals',
        'TotalTrolleyItemQuantity',
        'TrolleyItemCount',
        'Errors',
      ]),
    )
    expect(Object.keys(emptyTrolleyTemplate())).toHaveLength(29)
  })

  it('keep the real product detail keys', () => {
    expect(Object.keys(productDetailTemplate())).toEqual([
      'Product',
      'Nutrition',
      'VideoUrl',
      'PrimaryCategory',
      'AdditionalAttributes',
      'TgaAttributes',
      'DetailsImagePaths',
      'NutritionalInformation',
      'RichRelevancePlacements',
      'Variants',
      'VariantOptionGroups',
      'IsTobacco',
      'CountryOfOriginLabel',
      'DiagnosticsData',
    ])
  })

  it('keep both product templates with identical field names', () => {
    expect(Object.keys(specialProductTemplate())).toEqual(Object.keys(regularProductTemplate()))
    expect(Object.keys(regularProductTemplate()).length).toBeGreaterThan(100)
  })

  it('hand out independent copies', () => {
    const first = emptyTrolleyTemplate()
    first.AvailableItems.push('changed')
    expect(emptyTrolleyTemplate().AvailableItems).toEqual([])
  })

  it('have a catalogue row for every real product in the search capture', () => {
    const codes = catalogueEntries().map((entry) => entry.stockcode)
    expect(codes).toEqual(expect.arrayContaining([88436, 64746, 204746, 888140, 888137]))
  })
})
