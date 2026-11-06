// The update controller. It wraps electron-updater's autoUpdater, injected as an interface so the
// policy is tested in plain Node without Electron. The policy, which electron-updater alone doesn't
// give us:
//
// - Only from the feed, and only what the feed key signed. electron-updater authenticates nothing
//   about versions; an enabled updater must be given the feed's Ed25519 public key, and every
//   channel file is checked against its signed envelope (feed-envelope.ts) before electron-updater
//   sees it. Requests that leave the feed base are cancelled by the session guard (request-guard.ts).
// - Only ever forward. electron-updater compares versions loosely, and setting `channel` silently
//   turns `allowDowngrade` on. Here a version is downloaded only if it parses strictly and is newer
//   than both the running version and the highest version this install has ever run.
// - Never install in the middle of something. Nothing here calls quitAndInstall except
//   installAndRestart(), which the UI triggers and which first waits until no adapter is busy.
//   Squirrel.Mac's own install-on-quit follows the "install automatically" setting.
// - Say little. electron-updater's logger prints feed URLs, file names and a per-install staging id;
//   it is switched off, and this module logs states, versions and reason codes only. The staging id
//   header, which lets a feed host count and follow installs, is overwritten with a constant.

import type { OutgoingHttpHeaders } from 'node:http'
import { SiteAdapterError } from '@siteadapter/core'
import type { IsoTime, Settings, UpdateStatus } from '../../shared/api'
import { classifyUpdateError, type UpdateErrorReason } from './errors'
import { loadFeedPublicKey } from './feed-envelope'
import { type SignedFeedProviderClass, signedFeedProvider } from './feed-provider'
import { validateFeedUrl } from './feed-url'
import type { FeedRequestGuard } from './request-guard'
import { compareVersions, formatVersion, parseVersion, type Version } from './version'

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Upward only: checks drift later, never earlier, so installs don't all hit the feed at once. */
export const CHECK_JITTER_MS = 30 * 60 * 1000

/** Sent in place of electron-updater's per-install UUID. The same for every install. */
export const STAGING_ID_HEADER_VALUE = 'none'

export type UpdateChannelSetting = Settings['updateChannel']

/** The feed's file names: the stable channel is electron-builder's "latest" (latest-mac.yml). */
export const FEED_CHANNELS: Readonly<Record<UpdateChannelSetting, 'latest' | 'beta'>> = {
  stable: 'latest',
  beta: 'beta',
}

/** The part of electron-updater's AppUpdater this module uses. Its autoUpdater satisfies it. */
export interface AutoUpdaterLike {
  channel: string | null
  allowDowngrade: boolean
  allowPrerelease: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  requestHeaders: OutgoingHttpHeaders | null
  setFeedURL(options: { provider: 'custom'; updateProvider: SignedFeedProviderClass }): void
  checkForUpdates(): Promise<{
    readonly isUpdateAvailable: boolean
    readonly updateInfo: { readonly version: string }
  } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (info: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdaterClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type UpdaterState =
  /** Unpackaged or unsigned build, or electron-updater reported itself inactive: no feed contact. */
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'downloading'
  /** Downloaded and verified against the feed's SHA-512; installAndRestart() may be offered. */
  | 'ready'
  /** installAndRestart() was called; waiting for adapters to go idle, then quitting. */
  | 'installing'
  | 'error'

export interface UpdaterStatus {
  readonly state: UpdaterState
  /** This build's version. */
  readonly current: string
  /** The version being downloaded or ready to install, in canonical form. */
  readonly available: string | null
  /** When the feed last answered (ms since the epoch). */
  readonly checkedAt: number | null
  readonly channel: UpdateChannelSetting
  /** Whole percent while downloading, otherwise null. */
  readonly progress: number | null
  /** Set when state is 'error'. */
  readonly reason: UpdateErrorReason | null
}

/** One line for the app's log: states, versions and codes only. Never a URL or a message. */
export interface UpdaterLogEntry {
  readonly state: UpdaterState
  readonly current: string
  readonly available: string | null
  readonly channel: UpdateChannelSetting
  readonly reason: UpdateErrorReason | null
  /** A version the feed offered and we refused, in canonical form. */
  readonly refused: string | null
}

/** The feed, compiled into the asar: its base URL and the public half of the offline feed key. */
export interface SignedFeedConfig {
  /** Validated with validateFeedUrl; https to a public host unless allowLoopbackFeed. */
  readonly url: string
  /** SPKI PEM of the Ed25519 key that signs the envelopes. */
  readonly publicKey: string
}

export interface UpdaterOptions {
  readonly autoUpdater: AutoUpdaterLike
  /**
   * False for a build that must not update itself: unpackaged, or not signed with the release
   * identity (Squirrel.Mac can't verify an update against an ad hoc signature).
   */
  readonly enabled: boolean
  /** app.getVersion(). */
  readonly currentVersion: string
  /** Read at every check, so a settings change applies to the next one. */
  readonly channel: () => UpdateChannelSetting
  /** Settings.autoInstallUpdates: whether Squirrel.Mac installs a downloaded update when the app quits. */
  readonly autoInstallOnQuit: () => boolean
  /**
   * The highest version this install has ever run, as recorded in userData, or null if none is
   * recorded. Nothing at or below it is downloaded. An unparseable record is ignored (the running
   * version still bounds what's accepted) rather than freezing updates.
   */
  readonly highestVersionRun?: () => string | null
  /**
   * Resolves once no adapter run or login holds a lock, and should stop new ones starting. Rejecting
   * cancels the install and leaves the update ready.
   */
  readonly whenIdle: () => Promise<void>
  /**
   * Required when enabled: an updater without the feed key would trust whatever version an
   * unsigned channel file names. Replaces app-update.yml's provider, so nothing outside the asar
   * names the feed.
   */
  readonly feed?: SignedFeedConfig
  /** Accept an http://127.0.0.1 feed. For the updater end-to-end build and tests only. */
  readonly allowLoopbackFeed?: boolean
  /**
   * confineUpdaterSession's guard on electron-updater's session partition. A check that fails after
   * the guard cancelled a request reports request-refused.
   */
  readonly requestGuard?: FeedRequestGuard
  readonly clock: UpdaterClock
  /** In [0, 1); scales the jitter. */
  readonly random: () => number
  readonly log: (entry: UpdaterLogEntry) => void
  /** Delay before the first check after start(). Default 0. */
  readonly startDelayMs?: number
  readonly intervalMs?: number
  readonly jitterMs?: number
}

export interface Updater {
  /** Checks now (after startDelayMs) and then every intervalMs plus jitter. Idempotent. */
  start(): void
  /** Stops scheduling checks. A check already running finishes. */
  stop(): void
  /**
   * Checks the feed and, if a newer version is offered, downloads it. Resolves with the status
   * afterwards. While an update is downloading, ready or installing, returns the status unchanged.
   */
  checkNow(): Promise<UpdaterStatus>
  status(): UpdaterStatus
  /** Called on every change of status. Returns the unsubscribe. */
  onStatus(listener: (status: UpdaterStatus) => void): () => void
  /**
   * Waits until no adapter is busy, then hands the downloaded update to quitAndInstall. Resolves true
   * once it is handed over, false if nothing was ready, the install was cancelled, or it failed at
   * once. Handed over is not yet quitting: with install-on-quit off, Squirrel.Mac only starts
   * fetching the update from electron-updater's local proxy at this point, and the app quits once it
   * has it. If Squirrel.Mac refuses it instead, an error event moves the status to install-failed
   * and scheduled checks resume.
   */
  installAndRestart(): Promise<boolean>
}

const PENDING_STATES: ReadonlySet<UpdaterState> = new Set(['downloading', 'ready', 'installing'])

function delayOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function createUpdater(options: UpdaterOptions): Updater {
  const parsedCurrent = parseVersion(options.currentVersion)
  if (parsedCurrent === null) throw new SiteAdapterError('config', 'invalid')
  const current: Version = parsedCurrent
  const autoUpdater = options.autoUpdater
  const intervalMs = delayOrDefault(options.intervalMs, CHECK_INTERVAL_MS)
  const jitterMs = delayOrDefault(options.jitterMs, CHECK_JITTER_MS)
  const startDelayMs = delayOrDefault(options.startDelayMs, 0)

  // Before anything can make a request: no logging of URLs, and the signed feed from the asar.
  autoUpdater.logger = null
  autoUpdater.autoDownload = false
  if (options.enabled && options.feed === undefined) throw new SiteAdapterError('config', 'invalid')
  if (options.feed !== undefined) {
    const loopback = options.allowLoopbackFeed === true
    const url = validateFeedUrl(options.feed.url, {
      allowLoopbackHttp: loopback,
      requirePublicHost: !loopback,
    })
    if (url === null) throw new SiteAdapterError('config', 'invalid')
    let publicKey: ReturnType<typeof loadFeedPublicKey>
    try {
      publicKey = loadFeedPublicKey(options.feed.publicKey)
    } catch {
      throw new SiteAdapterError('config', 'invalid')
    }
    autoUpdater.setFeedURL({
      provider: 'custom',
      updateProvider: signedFeedProvider({
        baseUrl: url,
        publicKey,
        now: () => options.clock.now(),
        stagingId: STAGING_ID_HEADER_VALUE,
      }),
    })
  }

  let status: UpdaterStatus = {
    state: options.enabled ? 'idle' : 'disabled',
    current: formatVersion(current),
    available: null,
    checkedAt: null,
    channel: options.channel(),
    progress: null,
    reason: null,
  }
  const listeners = new Set<(status: UpdaterStatus) => void>()
  let running = false
  /** Set by an error event while downloading; see check(). */
  let errorWhileDownloading = false
  let timer: unknown = null
  let inFlight: Promise<UpdaterStatus> | null = null

  function set(patch: Partial<UpdaterStatus>, refused: Version | null = null): UpdaterStatus {
    const before = status
    status = { ...status, ...patch }
    const transition =
      before.state !== status.state ||
      before.reason !== status.reason ||
      before.available !== status.available ||
      refused !== null
    if (transition) {
      options.log({
        state: status.state,
        current: status.current,
        available: status.available,
        channel: status.channel,
        reason: status.reason,
        refused: refused === null ? null : formatVersion(refused),
      })
    }
    if (transition || before.progress !== status.progress || before.checkedAt !== status.checkedAt) {
      for (const listener of [...listeners]) {
        try {
          listener(status)
        } catch {
          // A listener's failure is the listener's problem, not the updater's.
        }
      }
    }
    return status
  }

  /** Read through a call so the compiler doesn't keep a narrowing across an await. */
  function stateNow(): UpdaterState {
    return status.state
  }

  function fail(
    reason: UpdateErrorReason,
    extra: Partial<UpdaterStatus> = {},
    refused: Version | null = null,
  ) {
    return set({ ...extra, state: 'error', reason, available: null, progress: null }, refused)
  }

  function configure(channel: UpdateChannelSetting): void {
    autoUpdater.autoDownload = false
    autoUpdater.channel = FEED_CHANNELS[channel]
    // electron-updater's channel setter turns allowDowngrade on; turn it straight back off.
    autoUpdater.allowDowngrade = false
    autoUpdater.allowPrerelease = false
    autoUpdater.autoInstallOnAppQuit = options.autoInstallOnQuit() === true
    autoUpdater.requestHeaders = { 'x-user-staging-id': STAGING_ID_HEADER_VALUE }
    autoUpdater.logger = null
  }

  /** Null if the offered version may be installed, else why not. */
  function judge(offered: Version, channel: UpdateChannelSetting): UpdateErrorReason | null {
    if (channel === 'stable' && offered.prerelease.length > 0) return 'channel-mismatch'
    if (compareVersions(offered, current) <= 0) return 'downgrade-refused'
    const floor = parseVersion(options.highestVersionRun?.() ?? null)
    if (floor !== null && compareVersions(offered, floor) <= 0) return 'downgrade-refused'
    return null
  }

  function refusals(): number {
    try {
      const count = options.requestGuard?.refusals() ?? 0
      return Number.isFinite(count) ? count : 0
    } catch {
      return 0
    }
  }

  async function check(): Promise<UpdaterStatus> {
    const channel = options.channel()
    configure(channel)
    const refusedBefore = refusals()
    /** A failure after the guard cancelled a request is the guard's doing, whatever the error says. */
    const classify = (error: unknown, phase: 'check' | 'download') =>
      refusals() > refusedBefore ? 'request-refused' : classifyUpdateError(error, phase)
    set({ state: 'checking', channel, reason: null, progress: null })
    let result: Awaited<ReturnType<AutoUpdaterLike['checkForUpdates']>>
    try {
      result = await autoUpdater.checkForUpdates()
    } catch (error) {
      return fail(classify(error, 'check'))
    }
    const checkedAt = options.clock.now()
    if (result === null) return set({ state: 'disabled', available: null, checkedAt })
    if (!result.isUpdateAvailable) return set({ state: 'up-to-date', available: null, checkedAt })
    const offered = parseVersion(result.updateInfo?.version)
    if (offered === null) return fail('feed-invalid', { checkedAt })
    const refusal = judge(offered, channel)
    if (refusal !== null) return fail(refusal, { checkedAt }, offered)

    errorWhileDownloading = false
    set({ state: 'downloading', available: formatVersion(offered), checkedAt, progress: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      return fail(classify(error, 'download'))
    }
    if (stateNow() !== 'downloading') return status
    // With install-on-quit on, electron-updater resolves the download once Squirrel.Mac has been
    // sent the zip, before Squirrel.Mac has checked its signature, and Squirrel.Mac's refusal then
    // arrives as an error event. A download failure rejects as well as emitting one, so an error
    // event followed by a resolved download is Squirrel.Mac refusing the update.
    if (errorWhileDownloading) return fail('install-failed')
    return set({ state: 'ready', progress: null })
  }

  function schedule(delay: number): void {
    if (timer !== null) options.clock.clearTimeout(timer)
    timer = options.clock.setTimeout(() => {
      timer = null
      void runCheck().then(() => {
        // runCheck reschedules after a check it ran; this covers the ones it skipped.
        if (running && timer === null) schedule(nextDelay())
      })
    }, delay)
  }

  function nextDelay(): number {
    const random = options.random()
    const fraction = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0
    return intervalMs + Math.floor(fraction * jitterMs)
  }

  function runCheck(): Promise<UpdaterStatus> {
    if (!options.enabled || status.state === 'disabled') return Promise.resolve(status)
    if (inFlight !== null) return inFlight
    if (PENDING_STATES.has(status.state)) return Promise.resolve(status)
    inFlight = check()
      .catch(() => fail('internal'))
      .finally(() => {
        inFlight = null
        if (running) schedule(nextDelay())
      })
    return inFlight
  }

  autoUpdater.on('download-progress', (info) => {
    if (status.state !== 'downloading') return
    const percent = typeof info?.percent === 'number' && Number.isFinite(info.percent) ? info.percent : 0
    set({ progress: Math.min(Math.max(Math.floor(percent), 0), 100) })
  })

  /**
   * Whether the schedule was running when installAndRestart() stopped it for the hand-off, or null
   * if it hasn't. Put back if the install fails, so a refused update doesn't end checking.
   */
  let runningBeforeInstall: boolean | null = null

  function installFailed(): void {
    fail('install-failed')
    if (runningBeforeInstall !== null) {
      running = runningBeforeInstall
      runningBeforeInstall = null
    }
    if (running && timer === null && inFlight === null) schedule(nextDelay())
  }

  autoUpdater.on('error', () => {
    // Check and download failures arrive as rejections and are handled there. An error event while
    // an update is ready or installing is Squirrel.Mac refusing it; while downloading, see check().
    if (status.state === 'downloading') errorWhileDownloading = true
    else if (status.state === 'installing') installFailed()
    else if (status.state === 'ready') fail('install-failed')
  })

  return {
    start() {
      if (!options.enabled || running) return
      running = true
      schedule(startDelayMs)
    },
    stop() {
      running = false
      if (timer !== null) options.clock.clearTimeout(timer)
      timer = null
    },
    checkNow: runCheck,
    status: () => status,
    onStatus(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async installAndRestart() {
      if (status.state !== 'ready') return false
      set({ state: 'installing' })
      try {
        await options.whenIdle()
      } catch {
        if (stateNow() === 'installing') set({ state: 'ready' })
        return false
      }
      // An error event (Squirrel.Mac refusing the update) may have arrived while we waited.
      if (stateNow() !== 'installing') return false
      runningBeforeInstall = running
      running = false
      if (timer !== null) options.clock.clearTimeout(timer)
      timer = null
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch {
        installFailed()
        return false
      }
      return stateNow() === 'installing'
    },
  }
}

/**
 * The renderer's view of the updater (src/shared/api.ts). `idle` (started, nothing checked yet) is
 * 'not-checked', never "up to date". The controller itself goes 'disabled' only when
 * electron-updater reports itself inactive (checkForUpdates returns null), which is the build
 * being unpackaged as far as it can tell: 'development'.
 */
export function toUpdateStatus(status: UpdaterStatus, signed: boolean): UpdateStatus {
  const state: UpdateStatus['state'] =
    status.state === 'checking' ||
    status.state === 'error' ||
    status.state === 'downloading' ||
    status.state === 'disabled' ||
    status.state === 'up-to-date'
      ? status.state
      : status.state === 'ready' || status.state === 'installing'
        ? 'ready'
        : 'not-checked'
  const checkedAt: IsoTime | null =
    status.checkedAt === null ? null : new Date(status.checkedAt).toISOString()
  return {
    current: status.current,
    state,
    available: status.available,
    checkedAt,
    signed,
    disabledReason: state === 'disabled' ? 'development' : null,
  }
}
