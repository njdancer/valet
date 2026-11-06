import { describe, expect, it } from 'vitest'
import { buildProduct, catalogue, findProduct, money, placementOf, roundMoney } from '../src/catalogue'
import { regularProductTemplate, specialProductTemplate } from '../src/fixtures'

const regularEntry = {
  stockcode: 123456,
  displayName: 'Test Brand Plain Flour 1kg',
  name: 'Test Brand Plain Flour',
  brand: 'Test Brand',
  variety: 'Plain Flour',
  packageSize: '1kg',
  price: 2.5,
  wasPrice: 2.5,
  cupPrice: 0.25,
  cupMeasure: '100G',
  department: 'pantry',
  aisle: 'baking',
  available: true,
}

describe('the catalogue', () => {
  it('has about thirty products with unique stockcodes', () => {
    expect(catalogue.length).toBeGreaterThanOrEqual(28)
    expect(catalogue.length).toBeLessThanOrEqual(35)
    expect(new Set(catalogue.map((p) => p.Stockcode)).size).toBe(catalogue.length)
  })

  it('covers the staples tests search for', () => {
    for (const word of ['milk', 'bread', 'eggs', 'bananas', 'cheese', 'coffee']) {
      expect(catalogue.some((p) => p.DisplayName.toLowerCase().includes(word))).toBe(true)
    }
  })

  it('includes specials, regular-price products and exactly one unavailable product', () => {
    expect(catalogue.filter((p) => p.IsOnSpecial).length).toBeGreaterThanOrEqual(5)
    expect(catalogue.filter((p) => !p.IsOnSpecial).length).toBeGreaterThanOrEqual(5)
    expect(catalogue.filter((p) => !p.IsAvailable).map((p) => p.Stockcode)).toEqual([900303])
  })

  it('keeps the five real products from the live capture with their real prices', () => {
    expect(findProduct(88436)).toMatchObject({ DisplayName: 'Dairy Farmers Full Cream Milk 2L', Price: 4.2 })
    expect(findProduct(64746)).toMatchObject({ DisplayName: 'Dairy Farmers Full Cream Milk 3L', Price: 6 })
    expect(findProduct(204746)).toMatchObject({ DisplayName: 'Pauls Smarter White Low Fat Milk 2L' })
    expect(findProduct(888140)).toMatchObject({ DisplayName: 'Woolworths Full Cream Milk 3L', Price: 4.95 })
    expect(findProduct(888137)).toMatchObject({ DisplayName: 'Woolworths Full Cream Milk 2L', Price: 3.4 })
  })

  it('gives every product exactly the field names of the real product object', () => {
    const realKeys = Object.keys(regularProductTemplate()).sort()
    for (const product of catalogue) expect(Object.keys(product).sort()).toEqual(realKeys)
  })

  it('numbers tiles from 1 in catalogue order', () => {
    expect(catalogue.map((p) => p['TileID'])).toEqual(catalogue.map((_, i) => i + 1))
  })
})

describe('buildProduct', () => {
  it('fills a regular-price product from the regular template', () => {
    const product = buildProduct(regularEntry, 7)
    expect(product).toMatchObject({
      TileID: 7,
      Stockcode: 123456,
      Name: 'Test Brand Plain Flour',
      DisplayName: 'Test Brand Plain Flour 1kg',
      UrlFriendlyName: 'test-brand-plain-flour',
      Brand: 'Test Brand',
      Variety: 'Plain Flour',
      PackageSize: '1kg',
      Price: 2.5,
      InstorePrice: 2.5,
      WasPrice: 2.5,
      SavingsAmount: 0,
      IsOnSpecial: false,
      IsHalfPrice: false,
      CupString: '$0.25 / 100G',
      InstoreCupString: '$0.25 / 100G',
      IsAvailable: true,
      IsPurchasable: true,
      IsInStock: true,
      HeaderTag: null,
      HasHeaderTag: false,
      Tags: [],
      SmallImageFile: 'https://cdn0.woolworths.media/content/wowproductimages/small/123456.jpg',
      LargeImageFile: 'https://cdn0.woolworths.media/content/wowproductimages/large/123456.jpg',
    })
  })

  it('pads image names to six digits like the real CDN', () => {
    const product = buildProduct({ ...regularEntry, stockcode: 4321 }, 1)
    expect(product['MediumImageFile']).toBe(
      'https://cdn0.woolworths.media/content/wowproductimages/medium/004321.jpg',
    )
  })

  it('builds a special from the special template with the saving in its tags', () => {
    const product = buildProduct({ ...regularEntry, price: 2, wasPrice: 2.5 }, 1)
    expect(product).toMatchObject({
      IsOnSpecial: true,
      InstoreIsOnSpecial: true,
      SavingsAmount: 0.5,
      WasPrice: 2.5,
    })
    expect(product['HeaderTag']).toMatchObject({ Content: 'Save $0.50', Promotion: 'Special' })
    const tags = product['Tags'] as { Content: { Type: string; Attributes: Record<string, unknown> } }[]
    expect(tags.map((t) => t.Content.Type)).toEqual(['Label', 'Roundel'])
    expect(tags[0]?.Content.Attributes['Text']).toBe('Save $0.50')
  })

  it('drops the captured milk-only promotion and sponsored-ad identifiers from specials', () => {
    const product = buildProduct({ ...regularEntry, price: 2, wasPrice: 2.5 }, 1)
    expect(specialProductTemplate()['IsSponsoredAd']).toBe(true)
    expect(product).toMatchObject({
      IsSponsoredAd: false,
      AdID: null,
      AdStatus: null,
      IsCentreTag: false,
      Source: 'SearchServiceSearchProducts',
    })
    expect(JSON.stringify(product)).not.toContain('Container credit')
  })

  it('marks half-price specials', () => {
    expect(buildProduct({ ...regularEntry, price: 1.25, wasPrice: 2.5 }, 1)['IsHalfPrice']).toBe(true)
    expect(buildProduct({ ...regularEntry, price: 1.3, wasPrice: 2.5 }, 1)['IsHalfPrice']).toBe(false)
  })

  it('marks an unavailable product as not purchasable and not in stock', () => {
    const product = buildProduct({ ...regularEntry, available: false }, 1)
    expect(product).toMatchObject({
      IsAvailable: false,
      InstoreIsAvailable: false,
      IsPurchasable: false,
      IsInStock: false,
    })
  })

  it('names the product in its supply limit message', () => {
    const product = buildProduct(regularEntry, 1)
    expect(product['SupplyLimitMessage']).toMatch(/^'Test Brand Plain Flour' has a supply limit of 36\./)
  })

  it('varies brand and description inside AdditionalAttributes', () => {
    const attributes = buildProduct(regularEntry, 1)['AdditionalAttributes'] as Record<string, unknown>
    expect(attributes['brand']).toBe('test brand')
    expect(attributes['description']).toBe('Test Brand Plain Flour 1kg')
    expect(attributes['productimages']).toBe('123456.jpg')
  })
})

describe('findProduct', () => {
  it('returns null for a stockcode that is not sold', () => {
    expect(findProduct(1)).toBeNull()
  })

  it('returns a copy, so a caller cannot change the catalogue', () => {
    const product = findProduct(88436) as unknown as Record<string, unknown>
    product['Price'] = 0.01
    expect(findProduct(88436)?.Price).toBe(4.2)
  })
})

describe('placementOf', () => {
  it('reports the department and aisle', () => {
    expect(placementOf(900601)).toEqual({ department: 'pantry', aisle: 'coffee' })
    expect(placementOf(1)).toBeNull()
  })
})

describe('money', () => {
  it('formats dollars with two decimals', () => {
    expect(money(4)).toBe('$4.00')
    expect(money(0.5)).toBe('$0.50')
  })

  it('rounds to cents', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3)
    expect(roundMoney(4.2 * 3)).toBe(12.6)
  })
})
