// The fake's product catalogue. The live probe only captured a handful of products, so each
// catalogue row is cloned from a real product object and only the fields that differ between
// products are replaced. Field names and types therefore stay exactly as the site sends them.

import {
  type CatalogueEntry,
  catalogueEntries,
  type Product,
  regularProductTemplate,
  specialProductTemplate,
} from './fixtures'

const IMAGE_BASE = 'https://cdn0.woolworths.media/content/wowproductimages'

export function money(amount: number): string {
  return `$${amount.toFixed(2)}`
}

export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100
}

export function buildProduct(entry: CatalogueEntry, tileId: number): Product {
  const onSpecial = entry.wasPrice > entry.price
  const product = onSpecial ? specialProductTemplate() : regularProductTemplate()
  const regular = regularProductTemplate()
  const savings = roundMoney(entry.wasPrice - entry.price)
  const cupString = `${money(entry.cupPrice)} / ${entry.cupMeasure}`
  // Image files are named by the zero-padded stockcode, as on the real CDN.
  const imageName = `${String(entry.stockcode).padStart(6, '0')}.jpg`
  const urlFriendly = entry.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  Object.assign(product, {
    TileID: tileId,
    Stockcode: entry.stockcode,
    Barcode: `9300000${String(entry.stockcode).padStart(6, '0')}`,
    Name: entry.name,
    DisplayName: entry.displayName,
    UrlFriendlyName: urlFriendly,
    Description: ` ${entry.displayName}`,
    SmallFormatDescription: entry.name,
    FullDescription: entry.name,
    Brand: entry.brand,
    Variety: entry.variety,
    PackageSize: entry.packageSize,
    Price: entry.price,
    InstorePrice: entry.price,
    WasPrice: entry.wasPrice,
    InstoreWasPrice: entry.wasPrice,
    SavingsAmount: savings,
    InstoreSavingsAmount: savings,
    IsOnSpecial: onSpecial,
    InstoreIsOnSpecial: onSpecial,
    IsHalfPrice: onSpecial && roundMoney(entry.price * 2) === entry.wasPrice,
    CupPrice: entry.cupPrice,
    InstoreCupPrice: entry.cupPrice,
    CupMeasure: entry.cupMeasure,
    CupString: cupString,
    InstoreCupString: cupString,
    IsAvailable: entry.available,
    InstoreIsAvailable: entry.available,
    IsPurchasable: entry.available,
    InstoreIsPurchasable: entry.available,
    IsInStock: entry.available,
    SmallImageFile: `${IMAGE_BASE}/small/${imageName}`,
    MediumImageFile: `${IMAGE_BASE}/medium/${imageName}`,
    LargeImageFile: `${IMAGE_BASE}/large/${imageName}`,
    DetailsImagePaths: [`${IMAGE_BASE}/large/${imageName}`],
    SupplyLimitMessage: product.SupplyLimitMessage.replace(`'${product.Name}'`, `'${entry.name}'`),
    // The captured special was a sponsored placement with a milk-only promotion. Normalise both
    // away so every product looks like an organic search hit.
    Source: 'SearchServiceSearchProducts',
    IsSponsoredAd: false,
    AdID: null,
    AdIndex: null,
    AdStatus: null,
    OfferId: null,
    CentreTag: regular.CentreTag,
    IsCentreTag: false,
  })

  Object.assign(product.AdditionalAttributes, {
    brand: entry.brand.toLowerCase(),
    description: entry.displayName,
    productimages: imageName,
  })

  if (onSpecial) {
    const label = `Save ${money(savings)}`
    if (product.HeaderTag !== null) Object.assign(product.HeaderTag, { Content: label })
    product.Tags = product.Tags.filter((tag) => tag.Content.Type !== 'PromotionInformation')
    for (const tag of product.Tags) {
      if (tag.Content.Type === 'Label') Object.assign(tag.Content.Attributes, { Text: label })
    }
  } else {
    Object.assign(product.ImageTag, { TagContent: null, FallbackText: '' })
    product.Tags = []
  }

  return product as unknown as Product
}

/** Placement data that the detail endpoint reports alongside each product. */
export interface Placement {
  readonly department: string
  readonly aisle: string
}

const entries = catalogueEntries()

/** Every product the fake sells, in relevance order. */
export const catalogue: readonly Product[] = entries.map((entry, index) => buildProduct(entry, index + 1))

const byStockcode = new Map(catalogue.map((product) => [product.Stockcode, product]))
const placements = new Map(entries.map((e) => [e.stockcode, { department: e.department, aisle: e.aisle }]))

/** A fresh copy of the product, or null when the stockcode isn't sold. */
export function findProduct(stockcode: number): Product | null {
  const product = byStockcode.get(stockcode)
  return product === undefined ? null : structuredClone(product)
}

export function placementOf(stockcode: number): Placement | null {
  return placements.get(stockcode) ?? null
}
