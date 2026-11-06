// Whether this build updates itself, what the renderer is told about it, and the versions this
// install has run. The controller is src/main/updater (createUpdater); electron/app.ts builds it
// only when this module says the build may update.
//
// A build may update only when all of these hold, and otherwise says which one doesn't:
// - the feed URL and its public key were compiled in (FEED_BASE_URL, FEED_PUBLIC_KEY: electron-vite
//   defines from the build's environment; never in a dev or demo build): 'not-configured';
// - it is packaged and not a demo launch: 'development';
// - it is signed with a Developer ID (Squirrel.Mac checks an update against the running app's
//   signature, and an ad hoc one can't be matched): 'unsigned'.

import { z } from 'zod'
import type { UpdateStatus } from '../../shared/api'
import type { Updater } from '../updater/updater'
import { toUpdateStatus } from '../updater/updater'
import { compareVersions, formatVersion, parseVersion } from '../updater/version'
import type { FeedDefines } from './feed-defines'
import { JsonDocument } from './files'

export type UpdatesDisabledReason = NonNullable<UpdateStatus['disabledReason']>

// ---------- Launch time ----------

/** What `codesign -dv --verbose=2` says about the running bundle, as far as updates care. */
export type BundleSignature = 'developer-id' | 'other'

/**
 * Reads `codesign -dv --verbose=2`'s report (it writes to stderr). Developer ID only when the leaf
 * authority is a Developer ID Application certificate and a Team ID is named; ad hoc, Apple
 * Development, or anything unreadable is 'other'.
 */
export function parseSignature(report: string): BundleSignature {
  const lines = report.split('\n').map((line) => line.trim())
  if (lines.includes('Signature=adhoc')) return 'other'
  const leaf = lines.find((line) => line.startsWith('Authority='))
  const team = lines.find((line) => line.startsWith('TeamIdentifier='))?.slice('TeamIdentifier='.length)
  const developerId = leaf?.startsWith('Authority=Developer ID Application: ') === true
  return developerId && team !== undefined && /^[A-Z0-9]{10}$/.test(team) ? 'developer-id' : 'other'
}

export interface UpdatesContext {
  readonly feed: FeedDefines
  readonly packaged: boolean
  readonly demo: boolean
  readonly signature: BundleSignature
}

export type UpdatesDecision =
  | { readonly enabled: true; readonly feed: FeedDefines }
  | { readonly enabled: false; readonly reason: UpdatesDisabledReason }

export function updatesDecision(context: UpdatesContext): UpdatesDecision {
  if (context.feed.url === '' || context.feed.publicKey === '')
    return { enabled: false, reason: 'not-configured' }
  if (!context.packaged || context.demo) return { enabled: false, reason: 'development' }
  if (context.signature !== 'developer-id') return { enabled: false, reason: 'unsigned' }
  return { enabled: true, feed: context.feed }
}

// ---------- What the service holds ----------

/** The updates as the service sees them: the renderer's status, a check, and change notices. */
export interface UpdatesPort {
  status(): UpdateStatus
  check(): Promise<void>
  /** Starts scheduled checks (an enabled updater only). */
  start(): void
  stop(): void
}

/** What the service gives the updater it builds: settings and versions, read at every check. */
export interface UpdatesHooks {
  readonly channel: () => 'stable' | 'beta'
  readonly autoInstallOnQuit: () => boolean
  readonly highestVersionRun: () => string | null
  readonly whenIdle: () => Promise<void>
  /** A verified update finished downloading: from the running version to `to`. */
  readonly downloaded: (from: string, to: string) => void
  /** The status changed; the windows refetch it. */
  readonly changed: () => void
}

/** A build that doesn't update itself: it says why, and never contacts a feed. */
export function disabledUpdates(
  current: string,
  reason: UpdatesDisabledReason,
  signed: boolean,
): UpdatesPort {
  const status: UpdateStatus = {
    current,
    state: 'disabled',
    available: null,
    checkedAt: null,
    signed,
    disabledReason: reason,
  }
  return {
    status: () => status,
    check: async () => {},
    start: () => {},
    stop: () => {},
  }
}

/**
 * An enabled updater (createUpdater) as the service sees it. Each update that becomes ready is told
 * to `downloaded` once (for the audit log), and every status change to `changed`.
 */
export function controllerUpdates(
  updater: Pick<Updater, 'status' | 'onStatus' | 'checkNow' | 'start' | 'stop'>,
  signed: boolean,
  hooks: Pick<UpdatesHooks, 'downloaded' | 'changed'>,
): UpdatesPort {
  let announced: string | null = null
  updater.onStatus((status) => {
    if (status.state === 'ready' && status.available !== null && status.available !== announced) {
      announced = status.available
      hooks.downloaded(status.current, status.available)
    }
    hooks.changed()
  })
  return {
    status: () => toUpdateStatus(updater.status(), signed),
    check: async () => {
      await updater.checkNow()
    },
    start: () => updater.start(),
    stop: () => updater.stop(),
  }
}

// ---------- Versions this install has run ----------

const versionsSchema = z
  .object({
    /** The version the last launch ran. */
    lastRun: z.string().max(64),
    /** The highest version any launch has run: the updater never takes anything at or below it. */
    highestRun: z.string().max(64),
  })
  .strict()

export type VersionRecord = z.infer<typeof versionsSchema>

export interface LaunchVersions {
  /** The highest version this install has run, this launch included. */
  readonly highestRun: string
  /** Set on the first launch of a newer version than the last one: what it was updated from. */
  readonly updatedFrom: string | null
}

/**
 * versions.json in userData. Read and rewritten once per launch. An unreadable file reads as
 * nothing recorded: the running version still bounds what the updater accepts.
 */
export class VersionStore {
  private readonly document: JsonDocument<VersionRecord | null>

  constructor(path: string) {
    this.document = new JsonDocument<VersionRecord | null>(path, versionsSchema.nullable(), () => null, true)
  }

  async recordLaunch(current: string): Promise<LaunchVersions> {
    const running = parseVersion(current)
    if (running === null) return { highestRun: current, updatedFrom: null }
    let updatedFrom: string | null = null
    let highestRun = formatVersion(running)
    await this.document.update((previous) => {
      const last = parseVersion(previous?.lastRun ?? null)
      const highest = parseVersion(previous?.highestRun ?? null)
      updatedFrom = last !== null && compareVersions(running, last) > 0 ? formatVersion(last) : null
      highestRun = formatVersion(
        highest !== null && compareVersions(highest, running) > 0 ? highest : running,
      )
      return { lastRun: formatVersion(running), highestRun }
    })
    return { highestRun, updatedFrom }
  }
}
