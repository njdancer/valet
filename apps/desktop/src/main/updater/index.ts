export { classifyUpdateError, UPDATE_ERROR_REASONS, type UpdateErrorReason, type UpdatePhase } from './errors'
export { type FeedUrlOptions, MAX_FEED_URL_LENGTH, validateFeedUrl } from './feed-url'
export {
  type AutoUpdaterLike,
  CHECK_INTERVAL_MS,
  CHECK_JITTER_MS,
  createUpdater,
  FEED_CHANNELS,
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
