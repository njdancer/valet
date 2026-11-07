// @vitest-environment node
// The update controller's policy, against a fake autoUpdater and a manual clock. No Electron.

import { generateKeyPairSync } from 'node:crypto'
import { ValetError } from '@valet/core'
import type { AppUpdater } from 'electron-updater'
import { describe, expect, it } from 'vitest'
import {
  type AutoUpdaterLike,
  CHECK_INTERVAL_MS,
  CHECK_JITTER_MS,
  createUpdater,
  STAGING_ID_HEADER_VALUE,
  toUpdateStatus,
  type UpdateChannelSetting,
  type UpdaterLogEntry,
  type UpdaterOptions,
  type UpdaterStatus,
} from '../../src/main/updater'
import { codedError, deferred, FakeAutoUpdater, flush, ManualClock, TEST_FEED } from './fakes'

function baseOptions(fake: FakeAutoUpdater, clock: ManualClock, logs: UpdaterLogEntry[]): UpdaterOptions {
  return {
    autoUpdater: fake,
    enabled: true,
    feed: TEST_FEED,
    currentVersion: '1.0.0',
    channel: () => 'stable',
    autoInstallOnQuit: () => true,
    highestVersionRun: () => '1.0.0',
    whenIdle: async () => {},
    clock,
    random: () => 0,
    log: (entry) => logs.push(entry),
  }
}

const available = (version: string) => async () => ({ isUpdateAvailable: true, updateInfo: { version } })

describe('createUpdater: construction', () => {
  it('turns electron-updater’s own logging and automatic download off before anything runs', () => {
    const fake = new FakeAutoUpdater()
    createUpdater(baseOptions(fake, new ManualClock(), []))
    expect(fake.logger).toBeNull()
    expect(fake.autoDownload).toBe(false)
    expect(fake.checks).toEqual([])
  })

  it('refuses a current version that is not canonical SemVer', () => {
    for (const currentVersion of ['v1.0.0', '1.0', '', '1.0.0 ', '01.0.0']) {
      const fake = new FakeAutoUpdater()
      const make = () => createUpdater({ ...baseOptions(fake, new ManualClock(), []), currentVersion })
      expect(make).toThrow(ValetError)
      expect(make).toThrow('config: invalid')
    }
  })

  it('points electron-updater at the signed feed provider, replacing app-update.yml’s', () => {
    const fake = new FakeAutoUpdater()
    createUpdater(baseOptions(fake, new ManualClock(), []))
    expect(fake.feeds).toHaveLength(1)
    expect(fake.feeds[0]?.provider).toBe('custom')
    expect(typeof fake.feeds[0]?.updateProvider).toBe('function')
  })

  it('refuses to enable updates without the feed key: an unsigned feed could name any version', () => {
    const fake = new FakeAutoUpdater()
    const { feed: _feed, ...options } = baseOptions(fake, new ManualClock(), [])
    const make = () => createUpdater(options)
    expect(make).toThrow(ValetError)
    expect(make).toThrow('config: invalid')
    expect(fake.feeds).toEqual([])
    // A disabled build needs no feed: it never contacts one.
    expect(createUpdater({ ...options, enabled: false }).status().state).toBe('disabled')
  })

  it('refuses a feed key that is not an Ed25519 public key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      type: 'spki',
      format: 'pem',
    })
    const ed25519Private = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
    for (const publicKey of [String(rsa), String(ed25519Private), '', 'not a key']) {
      const fake = new FakeAutoUpdater()
      const make = () =>
        createUpdater({ ...baseOptions(fake, new ManualClock(), []), feed: { ...TEST_FEED, publicKey } })
      expect(make).toThrow('config: invalid')
      expect(fake.feeds).toEqual([])
    }
  })

  it('refuses a feed URL carrying a token, and never hands it to electron-updater', () => {
    const fake = new FakeAutoUpdater()
    const make = () =>
      createUpdater({
        ...baseOptions(fake, new ManualClock(), []),
        feed: { ...TEST_FEED, url: 'https://updates.example.com/mac/?t=x' },
      })
    expect(make).toThrow(ValetError)
    expect(fake.feeds).toEqual([])
  })

  it('refuses a feed on a host that cannot be public, unless the end-to-end build asks for loopback', () => {
    for (const url of [
      'https://localhost/mac/',
      'https://127.0.0.1/mac/',
      'https://[::1]/mac/',
      'https://10.0.0.5/mac/',
      'https://updates/mac/',
      'https://updates.internal/mac/',
    ]) {
      const fake = new FakeAutoUpdater()
      expect(() =>
        createUpdater({ ...baseOptions(fake, new ManualClock(), []), feed: { ...TEST_FEED, url } }),
      ).toThrow(ValetError)
      expect(fake.feeds).toEqual([])
    }
  })

  it('refuses a loopback http feed unless the end-to-end build asks for it', () => {
    const fake = new FakeAutoUpdater()
    const feed = { ...TEST_FEED, url: 'http://127.0.0.1:4555/' }
    expect(() => createUpdater({ ...baseOptions(fake, new ManualClock(), []), feed })).toThrow(ValetError)
    createUpdater({ ...baseOptions(fake, new ManualClock(), []), feed, allowLoopbackFeed: true })
    expect(fake.feeds).toHaveLength(1)
  })

  it('accepts electron-updater’s real AppUpdater as the injected autoUpdater (type-level)', () => {
    const accepts = (updater: AppUpdater): AutoUpdaterLike => updater
    expect(typeof accepts).toBe('function')
  })
})

describe('createUpdater: disabled builds', () => {
  it('never contacts the feed, on start or on demand', async () => {
    const fake = new FakeAutoUpdater()
    const clock = new ManualClock()
    const updater = createUpdater({ ...baseOptions(fake, clock, []), enabled: false })
    updater.start()
    const status = await updater.checkNow()
    await clock.advance(2 * CHECK_INTERVAL_MS)
    expect(fake.checks).toEqual([])
    expect(clock.pending()).toEqual([])
    expect(status.state).toBe('disabled')
  })

  it('treats electron-updater reporting itself inactive (null) as disabled, and stops checking', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = async () => null
    const clock = new ManualClock()
    const updater = createUpdater(baseOptions(fake, clock, []))
    expect((await updater.checkNow()).state).toBe('disabled')
    await updater.checkNow()
    expect(fake.checks).toHaveLength(1)
  })
})

describe('createUpdater: checking', () => {
  it('reports up to date with the time the feed answered', async () => {
    const fake = new FakeAutoUpdater()
    const clock = new ManualClock()
    const updater = createUpdater(baseOptions(fake, clock, []))
    const status = await updater.checkNow()
    expect(status).toEqual({
      state: 'up-to-date',
      current: '1.0.0',
      available: null,
      checkedAt: clock.time,
      channel: 'stable',
      progress: null,
      reason: null,
    })
  })

  it('downloads a newer version and waits, ready, without installing', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    const status = await updater.checkNow()
    expect(status.state).toBe('ready')
    expect(status.available).toBe('1.1.0')
    expect(fake.downloads).toBe(1)
    expect(fake.quitAndInstallCalls).toEqual([])
  })

  it('asks the stable channel for latest-mac.yml and the beta channel for beta-mac.yml', async () => {
    const fake = new FakeAutoUpdater()
    let channel: UpdateChannelSetting = 'stable'
    const updater = createUpdater({ ...baseOptions(fake, new ManualClock(), []), channel: () => channel })
    await updater.checkNow()
    channel = 'beta'
    const status = await updater.checkNow()
    expect(fake.checks.map((c) => c.channel)).toEqual(['latest', 'beta'])
    expect(status.channel).toBe('beta')
  })

  it('turns downgrades back off after setting the channel, which turns them on', async () => {
    const fake = new FakeAutoUpdater()
    const updater = createUpdater({ ...baseOptions(fake, new ManualClock(), []), channel: () => 'beta' })
    await updater.checkNow()
    expect(fake.checks[0]?.allowDowngrade).toBe(false)
    expect(fake.checks[0]?.allowPrerelease).toBe(false)
    expect(fake.checks[0]?.autoDownload).toBe(false)
  })

  it('overwrites the per-install staging id with a constant on every check', async () => {
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    fake.requestHeaders = { 'x-user-staging-id': 'e1d6c1d0-unique-per-install', authorization: 'Bearer x' }
    await updater.checkNow()
    expect(fake.checks[0]?.requestHeaders).toEqual({ 'x-user-staging-id': STAGING_ID_HEADER_VALUE })
  })

  it('switches electron-updater’s logger off again if something switched it back on', async () => {
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    fake.logger = console
    await updater.checkNow()
    expect(fake.checks[0]?.logger).toBeNull()
  })

  it('lets Squirrel.Mac install on quit only when the setting says so, read at each check', async () => {
    const fake = new FakeAutoUpdater()
    let autoInstall = false
    const updater = createUpdater({
      ...baseOptions(fake, new ManualClock(), []),
      autoInstallOnQuit: () => autoInstall,
    })
    await updater.checkNow()
    autoInstall = true
    await updater.checkNow()
    expect(fake.checks.map((c) => c.autoInstallOnAppQuit)).toEqual([false, true])
  })

  it('shares one check between concurrent callers', async () => {
    const fake = new FakeAutoUpdater()
    const answer = deferred<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    fake.onCheck = () => answer.promise
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    const first = updater.checkNow()
    const second = updater.checkNow()
    expect(updater.status().state).toBe('checking')
    answer.resolve({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
    expect(await first).toBe(await second)
    expect(fake.checks).toHaveLength(1)
  })

  it('does not check again while an update is ready', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    await updater.checkNow()
    const again = await updater.checkNow()
    expect(again.state).toBe('ready')
    expect(fake.checks).toHaveLength(1)
  })
})

describe('createUpdater: refusing to go backwards', () => {
  it('refuses an older version even when electron-updater calls it available', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('0.9.0')
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    const status = await updater.checkNow()
    expect(status.state).toBe('error')
    expect(status.reason).toBe('downgrade-refused')
    expect(status.available).toBeNull()
    expect(fake.downloads).toBe(0)
  })

  it('refuses the version already running', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.0.0')
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    expect((await updater.checkNow()).reason).toBe('downgrade-refused')
    expect(fake.downloads).toBe(0)
  })

  it('refuses the same version with build metadata, which SemVer ranks equal', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.0.0+evil')
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    expect((await updater.checkNow()).reason).toBe('downgrade-refused')
  })

  it('refuses anything at or below the highest version this install has run', async () => {
    for (const offered of ['1.2.0', '1.5.0', '1.5.0-beta.9']) {
      const fake = new FakeAutoUpdater()
      fake.onCheck = available(offered)
      const updater = createUpdater({
        ...baseOptions(fake, new ManualClock(), []),
        channel: () => 'beta',
        highestVersionRun: () => '1.5.0',
      })
      expect((await updater.checkNow()).reason).toBe('downgrade-refused')
      expect(fake.downloads).toBe(0)
    }
  })

  it('accepts a version above the highest run', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.5.1')
    const updater = createUpdater({
      ...baseOptions(fake, new ManualClock(), []),
      highestVersionRun: () => '1.5.0',
    })
    expect((await updater.checkNow()).state).toBe('ready')
  })

  it('ignores an unreadable highest-run record, still bounded by the running version', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const updater = createUpdater({
      ...baseOptions(fake, new ManualClock(), []),
      highestVersionRun: () => 'garbage',
    })
    expect((await updater.checkNow()).state).toBe('ready')

    const older = new FakeAutoUpdater()
    older.onCheck = available('0.9.9')
    const updater2 = createUpdater({
      ...baseOptions(older, new ManualClock(), []),
      highestVersionRun: () => null,
    })
    expect((await updater2.checkNow()).reason).toBe('downgrade-refused')
  })

  it('refuses a prerelease offered on the stable channel', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('2.0.0-beta.1')
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    const status = await updater.checkNow()
    expect(status.reason).toBe('channel-mismatch')
    expect(fake.downloads).toBe(0)
  })

  it('on beta, orders prereleases numerically (beta.10 after beta.2) and refuses an earlier one', async () => {
    const newer = new FakeAutoUpdater()
    newer.onCheck = available('1.1.0-beta.10')
    const on = {
      channel: () => 'beta' as const,
      currentVersion: '1.1.0-beta.2',
      highestVersionRun: () => null,
    }
    const updater = createUpdater({ ...baseOptions(newer, new ManualClock(), []), ...on })
    expect((await updater.checkNow()).available).toBe('1.1.0-beta.10')

    const earlier = new FakeAutoUpdater()
    earlier.onCheck = available('1.1.0-beta.1')
    const updater2 = createUpdater({ ...baseOptions(earlier, new ManualClock(), []), ...on })
    expect((await updater2.checkNow()).reason).toBe('downgrade-refused')
  })

  it('moves a beta install on to the stable release that overtakes it', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const updater = createUpdater({
      ...baseOptions(fake, new ManualClock(), []),
      currentVersion: '1.1.0-beta.2',
      highestVersionRun: () => '1.1.0-beta.2',
    })
    expect((await updater.checkNow()).state).toBe('ready')
  })

  it('refuses a version string that is not canonical, and never shows or logs it', async () => {
    for (const version of [
      'v1.2.0',
      '1.2',
      '1.2.0 ',
      '01.2.0',
      '1.2.0-',
      `1.2.${'9'.repeat(70)}`,
      '1.2.0\n',
    ]) {
      const fake = new FakeAutoUpdater()
      fake.onCheck = available(version)
      const logs: UpdaterLogEntry[] = []
      const updater = createUpdater(baseOptions(fake, new ManualClock(), logs))
      const status = await updater.checkNow()
      expect(status.reason).toBe('feed-invalid')
      expect(status.available).toBeNull()
      expect(fake.downloads).toBe(0)
      expect(logs.every((l) => l.refused === null && l.available === null)).toBe(true)
    }
  })

  it('refuses update info with no version at all', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = async () => ({ isUpdateAvailable: true, updateInfo: undefined as never })
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    expect((await updater.checkNow()).reason).toBe('feed-invalid')
  })

  it('logs the refused version, canonical, with the reason', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('0.9.0+build.7')
    const logs: UpdaterLogEntry[] = []
    const updater = createUpdater(baseOptions(fake, new ManualClock(), logs))
    await updater.checkNow()
    expect(logs.at(-1)).toEqual({
      state: 'error',
      current: '1.0.0',
      available: null,
      channel: 'stable',
      reason: 'downgrade-refused',
      refused: '0.9.0',
    })
  })
})

describe('createUpdater: failures', () => {
  const secret = 'https://updates.example/mac/latest-mac.yml?token=s3cret'

  it('classifies a check failure by code and keeps the message out of status and logs', async () => {
    const cases: Array<[unknown, string]> = [
      [codedError('ECONNREFUSED', secret), 'feed-unreachable'],
      [Object.assign(new Error(secret), { statusCode: 503 }), 'feed-unreachable'],
      [codedError('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', secret), 'feed-unreachable'],
      [codedError('ERR_UPDATER_INVALID_UPDATE_INFO', secret), 'feed-invalid'],
      [new Error(secret), 'internal'],
      [secret, 'internal'],
    ]
    for (const [error, reason] of cases) {
      const fake = new FakeAutoUpdater()
      fake.onCheck = async () => {
        throw error
      }
      const logs: UpdaterLogEntry[] = []
      const updater = createUpdater(baseOptions(fake, new ManualClock(), logs))
      const status = await updater.checkNow()
      expect(status.reason).toBe(reason)
      expect(JSON.stringify([status, logs])).not.toContain('s3cret')
      expect(JSON.stringify([status, logs])).not.toContain('updates.example')
    }
  })

  it('classifies a download failure: checksum mismatch apart from network trouble', async () => {
    const cases: Array<[unknown, string]> = [
      [codedError('ERR_CHECKSUM_MISMATCH', secret), 'checksum-mismatch'],
      [codedError('ECONNRESET', secret), 'download-failed'],
      [Object.assign(new Error(secret), { statusCode: 404 }), 'download-failed'],
      [codedError('ERR_UPDATER_ZIP_FILE_NOT_FOUND', secret), 'feed-invalid'],
    ]
    for (const [error, reason] of cases) {
      const fake = new FakeAutoUpdater()
      fake.onCheck = available('1.1.0')
      fake.onDownload = async () => {
        throw error
      }
      const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
      const status = await updater.checkNow()
      expect(status).toMatchObject({ state: 'error', reason, available: null, progress: null })
    }
  })

  it('turns a settings read that throws into an internal error, not an unhandled rejection', async () => {
    const fake = new FakeAutoUpdater()
    let calls = 0
    const updater = createUpdater({
      ...baseOptions(fake, new ManualClock(), []),
      channel: () => {
        if (calls++ > 0) throw new Error('settings file unreadable')
        return 'stable'
      },
    })
    const status = await updater.checkNow()
    expect(status).toMatchObject({ state: 'error', reason: 'internal' })
    expect(fake.checks).toEqual([])
  })

  it('reports a check that failed after the session guard cancelled a request as request-refused', async () => {
    let refused = 0
    const fake = new FakeAutoUpdater()
    fake.onCheck = async () => {
      refused++ // the guard cancelled a redirect hop; Electron's net reports it with no code
      throw new Error('net::ERR_BLOCKED_BY_CLIENT')
    }
    const logs: UpdaterLogEntry[] = []
    const updater = createUpdater({
      ...baseOptions(fake, new ManualClock(), logs),
      requestGuard: { refusals: () => refused },
    })
    expect((await updater.checkNow()).reason).toBe('request-refused')
    // Earlier refusals don't colour a later, unrelated failure.
    fake.onCheck = async () => {
      throw codedError('ECONNREFUSED')
    }
    expect((await updater.checkNow()).reason).toBe('feed-unreachable')
    expect(JSON.stringify(logs)).not.toContain('ERR_BLOCKED')
  })

  it('reports a download cancelled by the guard as request-refused', async () => {
    let refused = 0
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    fake.onDownload = async () => {
      refused++
      throw new Error('net::ERR_BLOCKED_BY_CLIENT')
    }
    const updater = createUpdater({
      ...baseOptions(fake, new ManualClock(), []),
      requestGuard: { refusals: () => refused },
    })
    expect((await updater.checkNow()).reason).toBe('request-refused')
  })

  it('survives a guard whose counter throws or is nonsense', async () => {
    for (const refusals of [
      () => {
        throw new Error('x')
      },
      () => Number.NaN,
    ]) {
      const fake = new FakeAutoUpdater()
      fake.onCheck = async () => {
        throw codedError('ECONNREFUSED')
      }
      const updater = createUpdater({
        ...baseOptions(fake, new ManualClock(), []),
        requestGuard: { refusals },
      })
      expect((await updater.checkNow()).reason).toBe('feed-unreachable')
    }
  })

  it('maps the signed feed’s refusals to their own reasons', async () => {
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    fake.onCheck = async () => {
      throw codedError('ERR_VALET_FEED_UNVERIFIED')
    }
    expect((await updater.checkNow()).reason).toBe('feed-unverified')
    fake.onCheck = async () => {
      throw codedError('ERR_VALET_FEED_EXPIRED')
    }
    expect((await updater.checkNow()).reason).toBe('feed-expired')
  })

  it('tries again on the next check after a failure', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = async () => {
      throw codedError('ECONNREFUSED')
    }
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    await updater.checkNow()
    fake.onCheck = available('1.1.0')
    expect((await updater.checkNow()).state).toBe('ready')
  })

  it('survives a throwing status listener, and stops calling one that unsubscribed', async () => {
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    const seen: string[] = []
    updater.onStatus(() => {
      throw new Error('listener bug')
    })
    const off = updater.onStatus((s) => seen.push(s.state))
    await updater.checkNow()
    off()
    await updater.checkNow()
    expect(seen).toEqual(['checking', 'up-to-date'])
  })
})

describe('createUpdater: download progress', () => {
  it('reports whole percent while downloading, clamped, and ignores progress at other times', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const download = deferred<unknown>()
    fake.onDownload = () => download.promise
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    const progress: Array<number | null> = []
    updater.onStatus((s) => progress.push(s.progress))

    fake.emit('download-progress', { percent: 50 })
    expect(updater.status().progress).toBeNull()

    const done = updater.checkNow()
    await flush()
    fake.emit('download-progress', { percent: 12.7 })
    fake.emit('download-progress', { percent: 12.9 })
    fake.emit('download-progress', { percent: 250 })
    fake.emit('download-progress', { percent: Number.NaN })
    fake.emit('download-progress', null)
    download.resolve([])
    await done
    expect(progress).toEqual([null, 0, 12, 100, 0, null])
  })

  it('does not log progress, only transitions', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const download = deferred<unknown>()
    fake.onDownload = () => download.promise
    const logs: UpdaterLogEntry[] = []
    const updater = createUpdater(baseOptions(fake, new ManualClock(), logs))
    const done = updater.checkNow()
    await flush()
    for (let p = 0; p <= 100; p += 10) fake.emit('download-progress', { percent: p })
    download.resolve([])
    await done
    expect(logs.map((l) => l.state)).toEqual(['checking', 'downloading', 'ready'])
  })
})

describe('createUpdater: scheduling', () => {
  it('checks at start, then every six hours plus upward-only jitter', async () => {
    const fake = new FakeAutoUpdater()
    const clock = new ManualClock()
    const updater = createUpdater({ ...baseOptions(fake, clock, []), random: () => 0.5 })
    updater.start()
    await clock.advance(0)
    expect(fake.checks).toHaveLength(1)
    expect(clock.pending()).toEqual([CHECK_INTERVAL_MS + CHECK_JITTER_MS / 2])

    await clock.advance(CHECK_INTERVAL_MS + CHECK_JITTER_MS / 2 - 1)
    expect(fake.checks).toHaveLength(1)
    await clock.advance(1)
    expect(fake.checks).toHaveLength(2)
  })

  it('clamps a random source that strays outside [0, 1)', async () => {
    for (const [random, expected] of [
      [2, CHECK_INTERVAL_MS + CHECK_JITTER_MS],
      [-1, CHECK_INTERVAL_MS],
      [Number.NaN, CHECK_INTERVAL_MS],
    ] as const) {
      const clock = new ManualClock()
      const updater = createUpdater({
        ...baseOptions(new FakeAutoUpdater(), clock, []),
        random: () => random,
      })
      updater.start()
      await clock.advance(0)
      expect(clock.pending()).toEqual([expected])
    }
  })

  it('honours a start delay and custom interval, and falls back on nonsense values', async () => {
    const clock = new ManualClock()
    const fake = new FakeAutoUpdater()
    const updater = createUpdater({
      ...baseOptions(fake, clock, []),
      startDelayMs: 5_000,
      intervalMs: 60_000,
      jitterMs: -5,
    })
    updater.start()
    expect(clock.pending()).toEqual([5_000])
    await clock.advance(5_000)
    expect(clock.pending()).toEqual([60_000 + 0])

    const clock2 = new ManualClock()
    const updater2 = createUpdater({
      ...baseOptions(new FakeAutoUpdater(), clock2, []),
      intervalMs: Number.NaN,
      random: () => 0.999,
    })
    updater2.start()
    await clock2.advance(0)
    expect(clock2.pending()).toEqual([CHECK_INTERVAL_MS + Math.floor(0.999 * CHECK_JITTER_MS)])
  })

  it('keeps one schedule however often start() is called', async () => {
    const clock = new ManualClock()
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, clock, []))
    updater.start()
    updater.start()
    await clock.advance(0)
    updater.start()
    expect(fake.checks).toHaveLength(1)
    expect(clock.pending()).toHaveLength(1)
  })

  it('stops scheduling on stop(), even when a check was in flight', async () => {
    const clock = new ManualClock()
    const fake = new FakeAutoUpdater()
    const answer = deferred<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    fake.onCheck = () => answer.promise
    const updater = createUpdater(baseOptions(fake, clock, []))
    updater.start()
    await clock.advance(0)
    updater.stop()
    answer.resolve({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
    await flush()
    await clock.advance(10 * CHECK_INTERVAL_MS)
    expect(fake.checks).toHaveLength(1)
    expect(clock.pending()).toEqual([])
  })

  it('restarts after stop()', async () => {
    const clock = new ManualClock()
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, clock, []))
    updater.start()
    await clock.advance(0)
    updater.stop()
    updater.start()
    await clock.advance(0)
    expect(fake.checks).toHaveLength(2)
  })

  it('counts the interval from a check made on demand', async () => {
    const clock = new ManualClock()
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, clock, []))
    updater.start()
    await clock.advance(0)
    await clock.advance(CHECK_INTERVAL_MS / 2)
    await updater.checkNow()
    expect(clock.pending()).toEqual([CHECK_INTERVAL_MS])
  })

  it('keeps the schedule alive while an update waits, without asking the feed', async () => {
    const clock = new ManualClock()
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const updater = createUpdater(baseOptions(fake, clock, []))
    updater.start()
    await clock.advance(0)
    expect(updater.status().state).toBe('ready')
    await clock.advance(3 * CHECK_INTERVAL_MS)
    expect(fake.checks).toHaveLength(1)
    expect(clock.pending()).toEqual([CHECK_INTERVAL_MS])
  })
})

describe('createUpdater: installing', () => {
  async function ready(options: Partial<UpdaterOptions> = {}) {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const clock = new ManualClock()
    const updater = createUpdater({ ...baseOptions(fake, clock, []), ...options })
    updater.start()
    await clock.advance(0)
    expect(updater.status().state).toBe('ready')
    return { fake, clock, updater }
  }

  it('does nothing when no update is ready', async () => {
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    expect(await updater.installAndRestart()).toBe(false)
    await updater.checkNow()
    expect(await updater.installAndRestart()).toBe(false)
    expect(fake.quitAndInstallCalls).toEqual([])
  })

  it('waits until no adapter is busy, then quits and installs, and schedules nothing more', async () => {
    const idle = deferred<void>()
    const { fake, clock, updater } = await ready({ whenIdle: () => idle.promise })
    const result = updater.installAndRestart()
    await flush()
    expect(updater.status().state).toBe('installing')
    expect(fake.quitAndInstallCalls).toEqual([])

    idle.resolve()
    expect(await result).toBe(true)
    expect(fake.quitAndInstallCalls).toEqual([[false, true]])
    expect(clock.pending()).toEqual([])
  })

  it('goes back to ready when waiting for idle is cancelled', async () => {
    const { fake, updater } = await ready({
      whenIdle: async () => {
        throw new Error('cancelled')
      },
    })
    expect(await updater.installAndRestart()).toBe(false)
    expect(updater.status().state).toBe('ready')
    expect(fake.quitAndInstallCalls).toEqual([])
  })

  it('treats Squirrel.Mac refusing the update as an install failure and does not quit', async () => {
    const idle = deferred<void>()
    const { fake, updater } = await ready({ whenIdle: () => idle.promise })
    const result = updater.installAndRestart()
    await flush()
    fake.emit('error', new Error('Code signature at URL file:///… did not pass validation'))
    idle.resolve()
    expect(await result).toBe(false)
    expect(updater.status()).toMatchObject({ state: 'error', reason: 'install-failed', available: null })
    expect(fake.quitAndInstallCalls).toEqual([])
  })

  it('treats an error event while ready (install-on-quit hand-off) as an install failure', async () => {
    const { fake, updater } = await ready()
    fake.emit('error', new Error('x'))
    expect(updater.status().reason).toBe('install-failed')
  })

  it('ignores error events outside ready and installing: the promise carries them', async () => {
    const fake = new FakeAutoUpdater()
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    fake.emit('error', new Error('x'))
    expect(updater.status().state).toBe('idle')
  })

  it('reports a quitAndInstall that throws as an install failure', async () => {
    const { fake, updater } = await ready()
    fake.onQuitAndInstall = () => {
      throw new Error('no')
    }
    expect(await updater.installAndRestart()).toBe(false)
    expect(updater.status().reason).toBe('install-failed')
  })

  it('resumes scheduled checks when Squirrel.Mac refuses the update after the hand-off', async () => {
    const { fake, clock, updater } = await ready()
    expect(await updater.installAndRestart()).toBe(true)
    expect(clock.pending()).toEqual([])
    // MacUpdater re-emits nativeUpdater's errors: Squirrel.Mac refusing the zip it fetched.
    fake.emit('error', new Error('Code signature did not pass validation'))
    expect(updater.status()).toMatchObject({ state: 'error', reason: 'install-failed' })
    expect(clock.pending()).toEqual([CHECK_INTERVAL_MS])
    fake.onCheck = available('1.2.0')
    await clock.advance(60 * 60 * 60 * 1000)
    expect(fake.checks.length).toBeGreaterThan(1)
    expect(updater.status()).toMatchObject({ state: 'ready', available: '1.2.0' })
  })

  it('resumes scheduled checks when quitAndInstall throws', async () => {
    const { fake, clock, updater } = await ready()
    fake.onQuitAndInstall = () => {
      throw new Error('no')
    }
    expect(await updater.installAndRestart()).toBe(false)
    expect(clock.pending()).toEqual([CHECK_INTERVAL_MS])
    await clock.advance(CHECK_INTERVAL_MS)
    expect(fake.checks).toHaveLength(2)
  })

  it('does not start a schedule that was never running when an install fails', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    const clock = new ManualClock()
    const updater = createUpdater(baseOptions(fake, clock, []))
    expect((await updater.checkNow()).state).toBe('ready')
    expect(await updater.installAndRestart()).toBe(true)
    fake.emit('error', new Error('refused'))
    expect(updater.status().reason).toBe('install-failed')
    expect(clock.pending()).toEqual([])
  })

  it('reports false, not quitting, when Squirrel.Mac refuses during quitAndInstall itself', async () => {
    const { fake, clock, updater } = await ready()
    fake.onQuitAndInstall = () => fake.emit('error', new Error('refused'))
    expect(await updater.installAndRestart()).toBe(false)
    expect(updater.status().reason).toBe('install-failed')
    expect(clock.pending()).toEqual([CHECK_INTERVAL_MS])
  })

  it('treats a refusal that lands before the download’s promise settles as an install failure', async () => {
    // With install-on-quit on, electron-updater resolves downloadUpdate() once Squirrel.Mac has been
    // sent the bytes, before it checks them; its refusal can arrive while the state still says
    // downloading.
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    fake.onDownload = async () => {
      fake.emit('error', new Error('Code signature did not pass validation'))
      return []
    }
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    expect(await updater.checkNow()).toMatchObject({ state: 'error', reason: 'install-failed' })
    // The next download that goes through cleanly is ready again.
    fake.onDownload = async () => []
    expect((await updater.checkNow()).state).toBe('ready')
  })

  it('still classifies a download that fails (error event and rejection) as the download’s', async () => {
    const fake = new FakeAutoUpdater()
    fake.onCheck = available('1.1.0')
    fake.onDownload = async () => {
      const error = codedError('ERR_CHECKSUM_MISMATCH')
      fake.emit('error', error)
      throw error
    }
    const updater = createUpdater(baseOptions(fake, new ManualClock(), []))
    expect((await updater.checkNow()).reason).toBe('checksum-mismatch')
  })

  it('never installs from a check, a download or the schedule', async () => {
    const { fake, clock } = await ready()
    await clock.advance(5 * CHECK_INTERVAL_MS)
    expect(fake.quitAndInstallCalls).toEqual([])
  })
})

describe('toUpdateStatus', () => {
  const base: UpdaterStatus = {
    state: 'up-to-date',
    current: '1.0.0',
    available: null,
    checkedAt: Date.UTC(2026, 10, 7, 9, 0, 0),
    channel: 'stable',
    progress: null,
    reason: null,
  }

  it('never says up to date for a disabled updater, or one that hasn’t checked yet', () => {
    expect(toUpdateStatus({ ...base, state: 'disabled', checkedAt: null }, true)).toMatchObject({
      state: 'disabled',
      disabledReason: 'development',
      checkedAt: null,
    })
    expect(toUpdateStatus({ ...base, state: 'idle', checkedAt: null }, true)).toMatchObject({
      state: 'not-checked',
      disabledReason: null,
      signed: true,
      checkedAt: null,
    })
  })

  it('maps the updater’s states onto the renderer contract', () => {
    const mapped = (state: UpdaterStatus['state']) => toUpdateStatus({ ...base, state }, true).state
    expect(mapped('disabled')).toBe('disabled')
    expect(mapped('idle')).toBe('not-checked')
    expect(mapped('up-to-date')).toBe('up-to-date')
    expect(mapped('checking')).toBe('checking')
    expect(mapped('downloading')).toBe('downloading')
    expect(mapped('ready')).toBe('ready')
    expect(mapped('installing')).toBe('ready')
    expect(mapped('error')).toBe('error')
  })

  it('carries the versions, an ISO check time and whether the build is signed', () => {
    expect(toUpdateStatus({ ...base, state: 'ready', available: '1.1.0' }, false)).toEqual({
      current: '1.0.0',
      state: 'ready',
      available: '1.1.0',
      checkedAt: '2026-11-07T09:00:00.000Z',
      signed: false,
      disabledReason: null,
    })
    expect(toUpdateStatus({ ...base, checkedAt: null }, true).checkedAt).toBeNull()
  })
})
