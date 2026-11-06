// The update feed a build compiles in (FEED_BASE_URL and FEED_PUBLIC_KEY in electron/app.ts),
// read from the build's environment by electron.vite.config.ts. Kept apart from updates.ts so the
// build config loads only this and the URL check.

import { readFileSync } from 'node:fs'
import { validateFeedUrl } from '../updater/feed-url'

/** The build environment variables the feed comes from. */
export interface FeedBuildEnv {
  /**
   * The feed's base URL: an https directory, the same one electron-builder publishes. On a public
   * host for a release; outside one, http on loopback is allowed too (the updater end-to-end build).
   */
  readonly SITEADAPTER_UPDATE_URL?: string
  /** Path to the SPKI PEM public half of the offline feed key. */
  readonly SITEADAPTER_FEED_PUBLIC_KEY_FILE?: string
  /** 1 for a release: the feed is then required, and must be public https. */
  readonly SITEADAPTER_RELEASE?: string
  readonly [name: string]: string | undefined
}

export interface FeedDefines {
  readonly url: string
  readonly publicKey: string
}

/**
 * The feed a build compiles in, from its environment. Only a plain build (what packaging uses) gets
 * one; dev, demo and smoke builds never do. Neither set: no feed, and the updater is off. One
 * without the other, or a URL the rule for this build refuses, fails the build rather than shipping
 * an updater that can't verify what it fetches or contacts the wrong host. The rule is the one
 * electron-builder.config.ts applies to the same variable: for a release (SITEADAPTER_RELEASE=1)
 * https on a public host, and the feed is required; otherwise https to any host, or http on
 * loopback.
 */
export function feedDefines(
  env: FeedBuildEnv,
  plainBuild: boolean,
  readKey: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): FeedDefines {
  const none = { url: '', publicKey: '' }
  const release = env.SITEADAPTER_RELEASE === '1'
  if (release && !plainBuild)
    throw new Error('a release is a plain `electron-vite build`: not dev, demo or smoke')
  if (!plainBuild) return none
  const rawUrl = env.SITEADAPTER_UPDATE_URL ?? ''
  const keyFile = env.SITEADAPTER_FEED_PUBLIC_KEY_FILE ?? ''
  if (release && (rawUrl === '' || keyFile === ''))
    throw new Error('a release build needs SITEADAPTER_UPDATE_URL and SITEADAPTER_FEED_PUBLIC_KEY_FILE')
  if (rawUrl === '' && keyFile === '') return none
  if (rawUrl === '' || keyFile === '')
    throw new Error('set both SITEADAPTER_UPDATE_URL and SITEADAPTER_FEED_PUBLIC_KEY_FILE, or neither')
  const url = validateFeedUrl(rawUrl, { allowLoopbackHttp: !release, requirePublicHost: release })
  if (url === null)
    throw new Error(
      release
        ? 'SITEADAPTER_UPDATE_URL must be an https directory URL on a public host name'
        : 'SITEADAPTER_UPDATE_URL must be an https directory URL, or http on loopback',
    )
  const publicKey = readKey(keyFile).trim()
  if (!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----$/.test(publicKey))
    throw new Error('SITEADAPTER_FEED_PUBLIC_KEY_FILE must hold one SPKI PEM public key')
  return { url, publicKey: `${publicKey}\n` }
}

/**
 * Whether the updater may take a compiled-in feed that isn't https on a public host. Only a build
 * that wasn't a release can have one (feedDefines refuses it for a release, and the release
 * packaging checks the bundle holds the release feed), so it was compiled in on purpose: a loopback
 * feed for the updater end-to-end build.
 */
export function feedNeedsLoopback(url: string): boolean {
  return url !== '' && validateFeedUrl(url, { requirePublicHost: true }) === null
}
