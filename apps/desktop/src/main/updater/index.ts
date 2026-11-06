export { classifyUpdateError, UPDATE_ERROR_REASONS, type UpdateErrorReason, type UpdatePhase } from './errors'
export {
  canonicalEnvelope,
  ENVELOPE_KEYS,
  type FeedChannel,
  type FeedEnvelope,
  type FeedRefusal,
  type FeedVerdict,
  loadFeedPublicKey,
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_BYTES,
  MAX_ENVELOPE_VALIDITY_MS,
  MAX_YML_BYTES,
  type VerifyFeedInput,
  type VerifyFeedOptions,
  verifyFeed,
} from './feed-envelope'
export {
  FEED_REFUSAL_CODES,
  FeedRefusedError,
  type SignedFeedDeps,
  type SignedFeedProviderClass,
  signedFeedProvider,
} from './feed-provider'
export { type FeedUrlOptions, isPublicHostname, MAX_FEED_URL_LENGTH, validateFeedUrl } from './feed-url'
export {
  confineUpdaterSession,
  type FeedRequestGuard,
  isUnderFeedBase,
  type SessionLike,
  UPDATER_PARTITION,
} from './request-guard'
export {
  type AutoUpdaterLike,
  CHECK_INTERVAL_MS,
  CHECK_JITTER_MS,
  createUpdater,
  FEED_CHANNELS,
  type SignedFeedConfig,
  STAGING_ID_HEADER_VALUE,
  toUpdateStatus,
  type UpdateChannelSetting,
  type Updater,
  type UpdaterClock,
  type UpdaterLogEntry,
  type UpdaterOptions,
  type UpdaterState,
  type UpdaterStatus,
} from './updater'
export { compareVersions, formatVersion, MAX_VERSION_LENGTH, parseVersion, type Version } from './version'
