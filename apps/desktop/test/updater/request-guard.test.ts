// @vitest-environment node
// The session guard on electron-updater's partition: every request, redirect hops included, must
// stay under the feed base. feed-server.test.ts drives it with electron-updater's real executor.

import { describe, expect, it } from 'vitest'
import {
  confineUpdaterSession,
  isUnderFeedBase,
  type SessionLike,
  UPDATER_PARTITION,
} from '../../src/main/updater'

const BASE = 'https://updates.example.com/mac/'

/** A Session whose webRequest records the listener, as Electron's does. */
function fakeSession() {
  let listener: Parameters<SessionLike['webRequest']['onBeforeRequest']>[0] | null = null
  const session: SessionLike = {
    webRequest: {
      onBeforeRequest(registered) {
        listener = registered
      },
    },
  }
  const request = (url: string, method?: string): boolean => {
    let cancelled: boolean | null = null
    listener?.({ url, ...(method === undefined ? {} : { method }) }, (response) => {
      cancelled = response.cancel
    })
    if (cancelled === null) throw new Error('listener did not answer')
    return !cancelled
  }
  return { session, request }
}

describe('isUnderFeedBase', () => {
  it('accepts the channel files and zips under the base, with or without a cache-busting query', () => {
    for (const url of [
      `${BASE}latest-mac.yml`,
      `${BASE}latest-mac.yml?noCache=1abc`,
      `${BASE}siteadapter-1.2.0-arm64.zip`,
      `${BASE}sub/dir/file.zip`,
      `${BASE}a/../latest-mac.yml`,
    ]) {
      expect(isUnderFeedBase(url, BASE), url).toBe(true)
    }
  })

  it('refuses another scheme, host, port, path, credentials or the base itself', () => {
    for (const url of [
      'http://updates.example.com/mac/latest-mac.yml',
      'https://updates.example.com:8443/mac/latest-mac.yml',
      'https://evil.example.com/mac/latest-mac.yml',
      'https://updates.example.com.evil.example/mac/latest-mac.yml',
      'https://updates.example.com/macx/latest-mac.yml',
      'https://updates.example.com/latest-mac.yml',
      `${BASE}../latest-mac.yml`,
      `${BASE}%2e%2e/latest-mac.yml`,
      `${BASE}a%2fb.zip`,
      `${BASE}a%5cb.zip`,
      'https://user:pw@updates.example.com/mac/latest-mac.yml',
      BASE,
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isUnderFeedBase(url, BASE), url).toBe(false)
    }
  })

  it('refuses everything when the base is not a directory URL', () => {
    expect(
      isUnderFeedBase('https://updates.example.com/mac/latest-mac.yml', 'https://updates.example.com/mac'),
    ).toBe(false)
    expect(isUnderFeedBase('https://updates.example.com/mac/latest-mac.yml', 'nonsense')).toBe(false)
  })
})

describe('confineUpdaterSession', () => {
  it('names electron-updater’s own partition', () => {
    expect(UPDATER_PARTITION).toBe('electron-updater')
  })

  it('lets GETs under the base through and cancels everything else, counting what it cancels', () => {
    const { session, request } = fakeSession()
    const guard = confineUpdaterSession(session, BASE)
    expect(guard.refusals()).toBe(0)
    expect(request(`${BASE}latest-mac.yml`)).toBe(true)
    expect(request(`${BASE}siteadapter-1.2.0-arm64.zip`, 'GET')).toBe(true)
    expect(request(`${BASE}siteadapter-1.2.0-arm64.zip.blockmap`, 'HEAD')).toBe(true)
    expect(guard.refusals()).toBe(0)

    // A redirect hop is a new request in the partition: to plain http, and to another host.
    expect(request('http://updates.example.com/mac/siteadapter-1.2.0-arm64.zip')).toBe(false)
    expect(request('https://cdn.evil.example/siteadapter-1.2.0-arm64.zip')).toBe(false)
    expect(request(`${BASE}latest-mac.yml`, 'POST')).toBe(false)
    expect(guard.refusals()).toBe(3)
  })
})
