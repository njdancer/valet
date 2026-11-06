// The update feed a build compiles in (FEED_BASE_URL and FEED_PUBLIC_KEY in electron/app.ts),
// read from the build's environment by electron.vite.config.ts. Kept apart from updates.ts so the
// build config loads only this and the URL check.

import { readFileSync } from 'node:fs'
import { validateFeedUrl } from '../updater/feed-url'

/** The build environment variables the feed comes from. */
export interface FeedBuildEnv {
  /** The feed's base URL: https, a public host, a directory. The same one electron-builder publishes. */
  readonly SITEADAPTER_UPDATE_URL?: string
  /** Path to the SPKI PEM public half of the offline feed key. */
  readonly SITEADAPTER_FEED_PUBLIC_KEY_FILE?: string
  readonly [name: string]: string | undefined
}

export interface FeedDefines {
  readonly url: string
  readonly publicKey: string
}

/**
 * The feed a build compiles in, from its environment. Only a plain build (what packaging uses) gets
 * one; dev and demo builds never do. Neither set: no feed, and the updater is off. One without the
 * other, or a URL that isn't an https directory on a public host, fails the build rather than
 * shipping an updater that can't verify what it fetches or contacts the wrong host.
 */
export function feedDefines(
  env: FeedBuildEnv,
  plainBuild: boolean,
  readKey: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): FeedDefines {
  const none = { url: '', publicKey: '' }
  if (!plainBuild) return none
  const rawUrl = env.SITEADAPTER_UPDATE_URL ?? ''
  const keyFile = env.SITEADAPTER_FEED_PUBLIC_KEY_FILE ?? ''
  if (rawUrl === '' && keyFile === '') return none
  if (rawUrl === '' || keyFile === '')
    throw new Error('set both SITEADAPTER_UPDATE_URL and SITEADAPTER_FEED_PUBLIC_KEY_FILE, or neither')
  const url = validateFeedUrl(rawUrl, { allowLoopbackHttp: false, requirePublicHost: true })
  if (url === null)
    throw new Error('SITEADAPTER_UPDATE_URL must be an https directory URL on a public host name')
  const publicKey = readKey(keyFile).trim()
  if (!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----$/.test(publicKey))
    throw new Error('SITEADAPTER_FEED_PUBLIC_KEY_FILE must hold one SPKI PEM public key')
  return { url, publicKey: `${publicKey}\n` }
}
