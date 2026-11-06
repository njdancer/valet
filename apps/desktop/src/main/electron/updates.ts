// The updater's Electron side: the bundle's signature, electron-updater's autoUpdater, and the guard
// on its session partition. What decides whether a build updates is core/updates.ts; the policy of
// a check is updater/updater.ts.

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { app, session } from 'electron'
import { type FeedDefines, feedNeedsLoopback } from '../core/feed-defines'
import {
  type BundleSignature,
  controllerUpdates,
  disabledUpdates,
  parseSignature,
  type UpdatesHooks,
  type UpdatesPort,
  updatesDecision,
} from '../core/updates'
import { confineUpdaterSession, createUpdater, UPDATER_PARTITION } from '../updater'

/** The system default PATH: electron-updater runs `uname` and `sysctl` by name. */
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** What codesign says the running bundle is signed with. Unpackaged, or unreadable: 'other'. */
export function bundleSignature(): Promise<BundleSignature> {
  if (!app.isPackaged) return Promise.resolve('other')
  // .../siteadapter.app/Contents/MacOS/siteadapter → .../siteadapter.app
  const bundle = resolve(app.getPath('exe'), '../../..')
  return new Promise((done) => {
    execFile(
      '/usr/bin/codesign',
      ['-dv', '--verbose=2', bundle],
      { timeout: 5_000, env: { PATH: SYSTEM_PATH } },
      // codesign -dv reports on stderr, and exits non-zero for an unsigned bundle.
      (_error, _stdout, stderr) => done(parseSignature(String(stderr))),
    )
  })
}

export interface UpdatesContext {
  readonly feed: FeedDefines
  readonly demo: boolean
  readonly signature: BundleSignature
  readonly log: (line: string) => void
}

/** The service's `updates` dependency: an updater for a build that may update, otherwise none. */
export function electronUpdates(context: UpdatesContext): (hooks: UpdatesHooks) => Promise<UpdatesPort> {
  return async (hooks) => {
    const signed = context.signature === 'developer-id'
    const decision = updatesDecision({
      feed: context.feed,
      packaged: app.isPackaged,
      demo: context.demo,
      signature: context.signature,
    })
    if (!decision.enabled) return disabledUpdates(app.getVersion(), decision.reason, signed)
    process.env['PATH'] = SYSTEM_PATH
    // Every request electron-updater makes, redirect hops included, goes through this partition:
    // confined to the feed base before the first check.
    const guard = confineUpdaterSession(
      session.fromPartition(UPDATER_PARTITION, { cache: false }),
      decision.feed.url,
    )
    const { autoUpdater } = await import('electron-updater')
    const updater = createUpdater({
      autoUpdater,
      enabled: true,
      currentVersion: app.getVersion(),
      channel: hooks.channel,
      autoInstallOnQuit: hooks.autoInstallOnQuit,
      highestVersionRun: hooks.highestVersionRun,
      whenIdle: hooks.whenIdle,
      feed: decision.feed,
      // A non-release build's loopback feed (the updater end-to-end build); never a release's.
      allowLoopbackFeed: feedNeedsLoopback(decision.feed.url),
      requestGuard: guard,
      clock: {
        now: () => Date.now(),
        setTimeout: (run, ms) => setTimeout(run, ms),
        clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      },
      random: Math.random,
      // States, versions and reason codes only (UpdaterLogEntry); never a URL or a message.
      log: (entry) =>
        context.log(
          `updater: ${entry.state} ${entry.current}${entry.available === null ? '' : ` -> ${entry.available}`}` +
            `${entry.reason === null ? '' : ` (${entry.reason})`}${entry.refused === null ? '' : ` refused ${entry.refused}`}`,
        ),
    })
    return controllerUpdates(updater, signed, hooks)
  }
}
