export { type FakeAccount, type MfaChannel, SESSION_COOKIE } from './accounts'
export { SENSOR_COOKIE } from './akamai'
export {
  AUTH_ANALYTICS_COOKIE,
  AUTH0_SESSION_COOKIE,
  type AuthHostile,
  CAPTCHA_FRAME_PATH,
  MAX_MFA_FAILURES,
  REMEMBER_DEVICE_COOKIE,
  type SentMessage,
} from './auth-server'
export { BEACON_ROUNDS_ATTRIBUTE, DEFAULT_BEACON_INTERVAL_MS, type PageBeacon } from './beacon'
export { catalogue, findProduct } from './catalogue'
export {
  type CertificateOptions,
  generateTestCertificate,
  type Spawner,
  type SpawnResult,
  spawnProcess,
  type TestCertificate,
} from './certificate'
export { applyShapeDrift, SHAPE_DRIFTS, type ShapeDrift } from './drift'
export { type ExfilSink, type ExfilSinkOptions, startExfilSink } from './exfil-sink'
export {
  FIXTURE_NAMES,
  FIXTURES_DIRECTORY,
  type FixtureName,
  fixtureFile,
  readFixtureFile,
} from './fixture-data'
export type { Product } from './fixtures'
export type { RecordedRequest, TlsOptions } from './http'
export type { RateLimit } from './rate-limit'
export {
  productDetailResponse,
  productNotFoundResponse,
  type SearchQuery,
  searchQueryFromJson,
  searchResponse,
} from './search'
export {
  BOT_MANAGER_COOKIE,
  CAPTCHA_FRAME_HOSTNAME,
  type FakeWoolworths,
  type FakeWoolworthsOptions,
  type Hostile,
  loginHref,
  parentDomainOf,
  startFakeWoolworths,
  type UnknownSensor,
} from './server'
export { type PickupStore, pickupStores } from './stores'
export { type Trolley, type TrolleyLine, trolleyResponse } from './trolley'
