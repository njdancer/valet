import { createAdapter } from './adapter'

export { createAdapter } from './adapter'
export { type Cart, cartSchema } from './cart'
export { createManifest, LOGIN_PATH, type ManifestOptions, REAL_ORIGIN, SELECTORS } from './manifest'
export {
  type ProductDetail,
  type ProductSummary,
  productDetailSchema,
  productSummarySchema,
} from './products'

export default createAdapter()
