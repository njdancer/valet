// Why an update didn't happen, as a fixed code. electron-updater's error messages carry feed URLs,
// file names and server responses, so they never leave this module: the code is decided from the
// error's `code` or `statusCode` and the phase it happened in, never from its text.

export const UPDATE_ERROR_REASONS = [
  /** The feed couldn't be reached, or answered with an HTTP error, while checking. */
  'feed-unreachable',
  /** The channel file was missing pieces, unparseable, or named something we won't install. */
  'feed-invalid',
  /** The feed offered a version that isn't newer than this install, or than any it has run. */
  'downgrade-refused',
  /** The stable channel offered a prerelease. */
  'channel-mismatch',
  /** The zip couldn't be fetched. */
  'download-failed',
  /** The zip's SHA-512 didn't match the feed's. */
  'checksum-mismatch',
  /** Squirrel.Mac refused the update (for example, a signature that doesn't meet our requirement). */
  'install-failed',
  'internal',
] as const
export type UpdateErrorReason = (typeof UPDATE_ERROR_REASONS)[number]

export type UpdatePhase = 'check' | 'download' | 'install'

const FEED_INVALID_CODES = new Set([
  'ERR_UPDATER_INVALID_UPDATE_INFO',
  'ERR_UPDATER_INVALID_VERSION',
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  'ERR_UPDATER_NO_FILES_PROVIDED',
  'ERR_UPDATER_NO_CHECKSUM',
  'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
  'ERR_UPDATER_INVALID_RELEASE_FEED',
  'ERR_UPDATER_ASSET_NOT_FOUND',
])

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_NOT_FINISHED',
  // A missing channel file is a 404 from the feed: unreachable, from the person's point of view.
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
])

function field(error: unknown, name: 'code' | 'statusCode'): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  try {
    return (error as Record<string, unknown>)[name]
  } catch {
    // A hostile getter is still just an internal error.
    return undefined
  }
}

/** Classifies an electron-updater or Squirrel.Mac failure by its code and the phase it happened in. */
export function classifyUpdateError(error: unknown, phase: UpdatePhase): UpdateErrorReason {
  if (phase === 'install') return 'install-failed'
  const code = field(error, 'code')
  if (code === 'ERR_CHECKSUM_MISMATCH') return 'checksum-mismatch'
  if (typeof code === 'string' && FEED_INVALID_CODES.has(code)) return 'feed-invalid'
  const network =
    (typeof code === 'string' && NETWORK_CODES.has(code)) || typeof field(error, 'statusCode') === 'number'
  if (network) return phase === 'check' ? 'feed-unreachable' : 'download-failed'
  return 'internal'
}
