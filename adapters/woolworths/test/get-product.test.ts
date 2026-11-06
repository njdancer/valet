import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { getProduct } from '../src/products'
import { FakeToolContext, json, loadFixture } from './fake-context'

const DETAIL = '/apis/ui/product/detail/88436'

function run(ctx: FakeToolContext, input: unknown) {
  return getProduct.run(ctx, getProduct.input.parse(input))
}

describe('get_product mapping', () => {
  it('maps the captured milk detail', async () => {
    const ctx = new FakeToolContext().on('GET', DETAIL, json(loadFixture('product-detail-88436.json')))
    const result = await run(ctx, { stockcode: 88436 })
    expect(result).toMatchObject({
      stockcode: 88436,
      name: 'Dairy Farmers Full Cream Milk 2L',
      brand: 'Dairy Farmers',
      size: '2L',
      price: 4.2,
      wasPrice: 4.7,
      onSpecial: true,
      ingredients: 'Milk.',
      allergens: {
        contains: ['Milk'],
        mayBePresent: [],
        statement: 'Egg Free,Fish Free,Gluten Free,Soy Free,Wheat Free',
      },
      dietary: ['Gluten Free', 'Low Salt', 'Source of Protein', 'Vegetarian'],
      healthStarRating: 4,
      countryOfOrigin: 'Product of Australia',
      category: { department: 'dairy', aisle: 'full cream milk' },
    })
    expect(getProduct.output.parse(result)).toEqual(result)
  })

  it('turns the HTML description into plain text with line breaks', async () => {
    const ctx = new FakeToolContext().on('GET', DETAIL, json(loadFixture('product-detail-88436.json')))
    const result = await run(ctx, { stockcode: 88436 })
    expect(result.description).toMatch(
      /^Dairy Farmers Full Cream Milk 2L is Australian owned, made and loved\.\n\n/,
    )
    expect(result.description).not.toContain('<br>')
  })

  it('takes the per-100 column of the nutrition panel, skipping blanks and the sub-row dash', async () => {
    const ctx = new FakeToolContext().on('GET', DETAIL, json(loadFixture('product-detail-88436.json')))
    const result = await run(ctx, { stockcode: 88436 })
    expect(result.nutrition).toEqual({
      servingSize: '250.0 ML',
      servingsPerPack: '8.0',
      per100: [
        { nutrient: 'Energy', amount: '259.0kJ' },
        { nutrient: 'Protein', amount: '3.4g' },
        { nutrient: 'Fat, Total', amount: '3.4g' },
        { nutrient: 'Saturated', amount: '2.3g' },
        { nutrient: 'Carbohydrate', amount: '4.4g' },
        { nutrient: 'Sugars', amount: '4.4g' },
        { nutrient: 'Sodium', amount: '44.0mg' },
      ],
    })
  })

  it('reads the allergen lists when the site fills them', async () => {
    const body = loadFixture('product-detail-88436.json')
    body.AdditionalAttributes.allergencontains = 'Milk, Soy'
    body.AdditionalAttributes.allergenmaybepresent = 'Peanut,,Tree Nuts '
    const ctx = new FakeToolContext().on('GET', DETAIL, json(body))
    const result = await run(ctx, { stockcode: 88436 })
    expect(result.allergens.contains).toEqual(['Milk', 'Soy'])
    expect(result.allergens.mayBePresent).toEqual(['Peanut', 'Tree Nuts'])
  })

  it('reports no nutrition when the panel is missing', async () => {
    const body = loadFixture('product-detail-88436.json')
    body.NutritionalInformation = null
    const ctx = new FakeToolContext().on('GET', DETAIL, json(body))
    expect((await run(ctx, { stockcode: 88436 })).nutrition).toBeNull()
  })

  it('reports no nutrition when the panel has no per-100 column', async () => {
    const body = loadFixture('product-detail-88436.json')
    for (const row of body.NutritionalInformation) delete row.Values['Quantity Per 100g / 100mL']
    body.NutritionalInformation[1].Values = null
    const ctx = new FakeToolContext().on('GET', DETAIL, json(body))
    expect((await run(ctx, { stockcode: 88436 })).nutrition).toBeNull()
  })

  it('maps missing attributes, category and origin to empty values', async () => {
    const body = loadFixture('product-detail-88436.json')
    body.AdditionalAttributes = null
    body.PrimaryCategory = null
    body.CountryOfOriginLabel = null
    const ctx = new FakeToolContext().on('GET', DETAIL, json(body))
    const result = await run(ctx, { stockcode: 88436 })
    expect(result).toMatchObject({
      description: null,
      ingredients: null,
      allergens: { contains: [], mayBePresent: [], statement: null },
      dietary: [],
      healthStarRating: null,
      countryOfOrigin: null,
      category: null,
    })
  })

  it('maps an unreadable health star rating to null', async () => {
    const body = loadFixture('product-detail-88436.json')
    body.AdditionalAttributes.healthstarrating = 'n/a'
    const ctx = new FakeToolContext().on('GET', DETAIL, json(body))
    expect((await run(ctx, { stockcode: 88436 })).healthStarRating).toBeNull()
  })

  it('reports an empty product as not-found', async () => {
    const body = loadFixture('product-detail-88436.json')
    body.Product = null
    const ctx = new FakeToolContext().on('GET', DETAIL, json(body))
    const error = await run(ctx, { stockcode: 88436 }).catch((e: unknown) => e)
    expect(error).toEqual(new SiteAdapterError('tool-run', 'not-found'))
  })

  it('reports a 404 as not-found', async () => {
    const ctx = new FakeToolContext().on('GET', '/apis/ui/product/detail/1', json({}, 404))
    const error = await run(ctx, { stockcode: 1 }).catch((e: unknown) => e)
    expect(error).toEqual(new SiteAdapterError('tool-run', 'not-found'))
  })
})

describe('get_product request', () => {
  it('makes exactly one GET for the stockcode, without a login', async () => {
    const ctx = new FakeToolContext().on('GET', DETAIL, json(loadFixture('product-detail-88436.json')))
    await run(ctx, { stockcode: 88436 })
    expect(ctx.events).toEqual(['GET /apis/ui/product/detail/88436'])
  })
})

describe('get_product input', () => {
  const parse = (input: unknown) => getProduct.input.safeParse(input)

  it('accepts a positive integer stockcode', () => {
    expect(parse({ stockcode: 88436 }).success).toBe(true)
  })

  it('refuses anything that could become more than one path segment', () => {
    expect(parse({ stockcode: '../../checkout' }).success).toBe(false)
    expect(parse({ stockcode: '88436/../../checkout' }).success).toBe(false)
    expect(parse({ stockcode: '88436' }).success).toBe(false)
  })

  it('refuses zero, negatives, fractions and out-of-range numbers', () => {
    expect(parse({ stockcode: 0 }).success).toBe(false)
    expect(parse({ stockcode: -1 }).success).toBe(false)
    expect(parse({ stockcode: 1.5 }).success).toBe(false)
    expect(parse({ stockcode: 1e21 }).success).toBe(false)
    expect(parse({ stockcode: Number.NaN }).success).toBe(false)
  })
})
