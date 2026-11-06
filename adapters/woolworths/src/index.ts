import { createAdapter } from './adapter'

export { createAdapter } from './adapter'
export { type Cart, cartSchema } from './cart'
export {
  AUTH_PATHS,
  createManifest,
  loginUrl,
  type ManifestOptions,
  MESSAGES_SENDER,
  REAL_AUTH_ORIGIN,
  REAL_ORIGIN,
  SELECTORS,
} from './manifest'
export {
  type ProductDetail,
  type ProductSummary,
  productDetailSchema,
  productSummarySchema,
} from './products'

export default createAdapter()
