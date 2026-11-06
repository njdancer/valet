// @vitest-environment node
// Whether a build updates itself, the feed a build compiles in, the bundle's signature, the
// controller as the service sees it, and the versions this install has run.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { feedDefines } from '../../src/main/core/feed-defines'
import {
  controllerUpdates,
  disabledUpdates,
  parseSignature,
  updatesDecision,
  VersionStore,
} from '../../src/main/core/updates'
import type { UpdaterStatus } from '../../src/main/updater'

const KEY =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----'
const URL = 'https://updates.example.com/mac/'

describe('feedDefines', () => {
  const readKey = (path: string) => {
    if (path !== '/keys/feed.pub') throw new Error('no such file')
    return `${KEY}\n`
  }

  it('compiles in the feed for a plain build that names both', () => {
    expect(
      feedDefines(
        { SITEADAPTER_UPDATE_URL: URL, SITEADAPTER_FEED_PUBLIC_KEY_FILE: '/keys/feed.pub' },
        true,
        readKey,
      ),
    ).toEqual({ url: URL, publicKey: `${KEY}\n` })
  })

  it('compiles in nothing for a dev or demo build, or with neither set', () => {
    const both = { SITEADAPTER_UPDATE_URL: URL, SITEADAPTER_FEED_PUBLIC_KEY_FILE: '/keys/feed.pub' }
    expect(feedDefines(both, false, readKey)).toEqual({ url: '', publicKey: '' })
    expect(feedDefines({}, true, readKey)).toEqual({ url: '', publicKey: '' })
    expect(feedDefines({ SITEADAPTER_UPDATE_URL: '', SITEADAPTER_FEED_PUBLIC_KEY_FILE: '' }, true)).toEqual({
      url: '',
      publicKey: '',
    })
  })

  it('fails the build for half a feed, a feed that isn’t public https, or a key that isn’t one', () => {
    expect(() => feedDefines({ SITEADAPTER_UPDATE_URL: URL }, true, readKey)).toThrow(/both/)
    expect(() => feedDefines({ SITEADAPTER_FEED_PUBLIC_KEY_FILE: '/keys/feed.pub' }, true, readKey)).toThrow(
      /both/,
    )
    for (const url of [
      'http://updates.example.com/mac/',
      'https://127.0.0.1/mac/',
      'https://updates.example.com/mac',
    ])
      expect(() =>
        feedDefines(
          { SITEADAPTER_UPDATE_URL: url, SITEADAPTER_FEED_PUBLIC_KEY_FILE: '/keys/feed.pub' },
          true,
          readKey,
        ),
      ).toThrow(/https directory/)
    expect(() =>
      feedDefines(
        { SITEADAPTER_UPDATE_URL: URL, SITEADAPTER_FEED_PUBLIC_KEY_FILE: '/keys/feed.pub' },
        true,
        () => KEY.replace('PUBLIC', 'PRIVATE'),
      ),
    ).toThrow(/SPKI/)
    expect(() =>
      feedDefines(
        { SITEADAPTER_UPDATE_URL: URL, SITEADAPTER_FEED_PUBLIC_KEY_FILE: '/keys/feed.pub' },
        true,
        () => `${KEY}\n${KEY}`,
      ),
    ).toThrow(/SPKI/)
  })

  it('reads the key file from disk by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-feed-'))
    try {
      writeFileSync(join(dir, 'feed.pub'), KEY)
      expect(
        feedDefines(
          { SITEADAPTER_UPDATE_URL: URL, SITEADAPTER_FEED_PUBLIC_KEY_FILE: join(dir, 'feed.pub') },
          true,
        ).publicKey,
      ).toBe(`${KEY}\n`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parseSignature', () => {
  it('takes a Developer ID Application leaf with a Team ID', () => {
    const report = [
      'Executable=/Applications/siteadapter.app/Contents/MacOS/siteadapter',
      'Identifier=me.dncr.siteadapter',
      'Authority=Developer ID Application: Nick Dancer (ABCDE12345)',
      'Authority=Developer ID Certification Authority',
      'Authority=Apple Root CA',
      'TeamIdentifier=ABCDE12345',
    ].join('\n')
    expect(parseSignature(report)).toBe('developer-id')
  })

  it('refuses ad hoc, Apple Development, no team, and nothing at all', () => {
    expect(parseSignature('Signature=adhoc\nTeamIdentifier=not set')).toBe('other')
    expect(parseSignature('Authority=Apple Development: Nick (XYZ)\nTeamIdentifier=ABCDE12345')).toBe('other')
    expect(
      parseSignature('Authority=Developer ID Application: Nick (ABCDE12345)\nTeamIdentifier=not set'),
    ).toBe('other')
    expect(parseSignature('code object is not signed at all')).toBe('other')
    expect(parseSignature('')).toBe('other')
  })
})

describe('updatesDecision', () => {
  const feed = { url: URL, publicKey: KEY }
  const release = { feed, packaged: true, demo: false, signature: 'developer-id' } as const

  it('updates only a packaged, Developer ID build with a feed compiled in', () => {
    expect(updatesDecision(release)).toEqual({ enabled: true, feed })
  })

  it('says which condition is missing, the feed first', () => {
    expect(updatesDecision({ ...release, feed: { url: '', publicKey: '' } })).toEqual({
      enabled: false,
      reason: 'not-configured',
    })
    expect(updatesDecision({ ...release, feed: { url: URL, publicKey: '' } })).toMatchObject({
      reason: 'not-configured',
    })
    expect(updatesDecision({ ...release, packaged: false })).toMatchObject({ reason: 'development' })
    expect(updatesDecision({ ...release, demo: true })).toMatchObject({ reason: 'development' })
    expect(updatesDecision({ ...release, signature: 'other' })).toMatchObject({ reason: 'unsigned' })
  })
})

describe('the updates the service holds', () => {
  it('a disabled one says why and does nothing', async () => {
    const off = disabledUpdates('0.1.0', 'unsigned', false)
    expect(off.status()).toEqual({
      current: '0.1.0',
      state: 'disabled',
      available: null,
      checkedAt: null,
      signed: false,
      disabledReason: 'unsigned',
    })
    await off.check()
    off.start()
    off.stop()
    expect(off.status().state).toBe('disabled')
  })

  it('a controller one maps the status, and tells each ready update once', async () => {
    const base: UpdaterStatus = {
      state: 'idle',
      current: '1.0.0',
      available: null,
      checkedAt: null,
      channel: 'stable',
      progress: null,
      reason: null,
    }
    let status = base
    const listeners: ((s: UpdaterStatus) => void)[] = []
    const calls: string[] = []
    const updater = {
      status: () => status,
      onStatus: (listener: (s: UpdaterStatus) => void) => {
        listeners.push(listener)
        return () => {}
      },
      checkNow: async () => {
        calls.push('check')
        return status
      },
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
    }
    const downloaded: [string, string][] = []
    let changes = 0
    const port = controllerUpdates(updater, true, {
      downloaded: (from, to) => downloaded.push([from, to]),
      changed: () => changes++,
    })
    expect(port.status()).toMatchObject({ state: 'not-checked', signed: true, disabledReason: null })
    const emit = (next: Partial<UpdaterStatus>) => {
      status = { ...status, ...next }
      for (const listener of listeners) listener(status)
    }
    emit({ state: 'downloading', available: '1.1.0' })
    emit({ state: 'ready' })
    emit({ state: 'installing' })
    // The install waited and was cancelled: ready again, but the same download.
    emit({ state: 'ready' })
    emit({ state: 'ready', available: '1.2.0' })
    expect(downloaded).toEqual([
      ['1.0.0', '1.1.0'],
      ['1.0.0', '1.2.0'],
    ])
    expect(changes).toBe(5)
    expect(port.status()).toMatchObject({ state: 'ready', available: '1.2.0' })
    await port.check()
    port.start()
    port.stop()
    expect(calls).toEqual(['check', 'start', 'stop'])
  })
})

describe('VersionStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const store = () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-versions-'))
    dirs.push(dir)
    return { path: join(dir, 'versions.json'), store: new VersionStore(join(dir, 'versions.json')) }
  }

  it('says updated only on the first launch of a newer version, and keeps the highest run', async () => {
    const { store: versions } = store()
    expect(await versions.recordLaunch('1.0.0')).toEqual({ highestRun: '1.0.0', updatedFrom: null })
    expect(await versions.recordLaunch('1.0.0')).toEqual({ highestRun: '1.0.0', updatedFrom: null })
    expect(await versions.recordLaunch('1.1.0')).toEqual({ highestRun: '1.1.0', updatedFrom: '1.0.0' })
    expect(await versions.recordLaunch('1.1.0')).toEqual({ highestRun: '1.1.0', updatedFrom: null })
    // Rolled back by hand: no update, and the highest stays.
    expect(await versions.recordLaunch('1.0.5')).toEqual({ highestRun: '1.1.0', updatedFrom: null })
    expect(await versions.recordLaunch('1.1.0')).toEqual({ highestRun: '1.1.0', updatedFrom: '1.0.5' })
  })

  it('reads an unreadable file as nothing recorded, and a version it can’t parse as no update', async () => {
    const { path, store: versions } = store()
    writeFileSync(path, '{"lastRun": 7}')
    expect(await versions.recordLaunch('1.0.0')).toEqual({ highestRun: '1.0.0', updatedFrom: null })
    expect(await versions.recordLaunch('not-a-version')).toEqual({
      highestRun: 'not-a-version',
      updatedFrom: null,
    })
    writeFileSync(path, JSON.stringify({ lastRun: 'x', highestRun: 'y' }))
    expect(await versions.recordLaunch('1.0.1')).toEqual({ highestRun: '1.0.1', updatedFrom: null })
  })
})
