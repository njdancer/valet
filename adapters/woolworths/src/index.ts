import { createAdapter } from './adapter'

export { createAdapter } from './adapter'
export { type Cart, cartSchema } from './cart'
export {
  checkResponse,
  DRIFT_ENDPOINTS,
  type DriftEndpoint,
  firstStockcode,
  SMOKE_PLAN,
  type SmokeRequest,
} from './drift'
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

export { runSmoke, type SmokeOptions, type SmokeResult, type SmokeStep, type SmokeStop } from './smoke'

export default createAdapter()
