// @vitest-environment node
// The updater against a local static feed, with electron-updater's real check and download code
// (see node-updater.ts for what is real and what is replaced). The feed is written by
// scripts/make-feed.mjs, so this also proves electron-updater reads what that script writes.

import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFeed } from '../../scripts/make-feed.mjs'
import {
  createUpdater,
  STAGING_ID_HEADER_VALUE,
  type UpdateChannelSetting,
  type UpdaterLogEntry,
  type UpdaterOptions,
} from '../../src/main/updater'
import { FakeFeedServer } from './fake-feed-server'
import { ManualClock } from './fakes'
import { NodeAppAdapter, NodeUpdater } from './node-updater'

let dir: string
let server: FakeFeedServer
const zips = new Map<string, Buffer>()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siteadapter-feed-'))
  server = new FakeFeedServer()
  await server.start()
  zips.clear()
  // What electron-builder writes into Contents/Resources from `publish`.
  await writeFile(
    join(dir, 'app-update.yml'),
    `provider: generic\nurl: ${server.url}\nupdaterCacheDirName: siteadapter-updater\n`,
  )
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

/** Builds zips for a version, runs make-feed over them, and serves the lot. */
async function publish(version: string): Promise<void> {
  const build = join(dir, 'build', version)
  await mkdir(build, { recursive: true })
  const paths: string[] = []
  for (const arch of ['arm64', 'x64']) {
    const name = `siteadapter-${version}-${arch}.zip`
    const bytes = randomBytes(48 * 1024)
    zips.set(name, bytes)
    await writeFile(join(build, name), bytes)
    paths.push(join(build, name))
    server.files.set(`/${name}`, bytes)
  }
  const out = join(build, 'feed')
  for (const path of await makeFeed({
    version,
    zips: paths,
    outDir: out,
    releaseDate: '2026-11-07T10:00:00.000Z',
  })) {
    server.files.set(`/${path.slice(out.length + 1)}`, await readFile(path))
  }
}

function setup(options: Partial<UpdaterOptions> & { arm64?: boolean; currentVersion?: string } = {}) {
  const app = new NodeAppAdapter(
    options.currentVersion ?? '1.0.0',
    join(dir, 'app-update.yml'),
    join(dir, 'userData'),
    join(dir, 'cache'),
  )
  const nodeUpdater = new NodeUpdater(app, options.arm64 ?? true)
  const logs: UpdaterLogEntry[] = []
  const updater = createUpdater({
    autoUpdater: nodeUpdater,
    enabled: true,
    currentVersion: app.version,
    channel: () => 'stable',
    autoInstallOnQuit: () => false,
    highestVersionRun: () => app.version,
    whenIdle: async () => {},
    clock: new ManualClock(),
    random: () => 0,
    log: (entry) => logs.push(entry),
    ...options,
  })
  return { updater, nodeUpdater, logs }
}

async function downloaded(): Promise<Buffer[]> {
  const pending = join(dir, 'cache', 'siteadapter-updater', 'pending')
  const names = await readdir(pending).catch(() => [] as string[])
  return Promise.all(names.filter((n) => n.endsWith('.zip')).map((n) => readFile(join(pending, n))))
}

describe('the updater against a local feed', () => {
  it('finds a newer version, downloads the arm64 zip with a verified SHA-512, and waits', async () => {
    await publish('1.1.0')
    const { updater, nodeUpdater } = setup()
    const status = await updater.checkNow()
    expect(status).toMatchObject({ state: 'ready', available: '1.1.0', reason: null })
    expect(await downloaded()).toEqual([zips.get('siteadapter-1.1.0-arm64.zip')])
    expect(server.requested('/latest-mac.yml')).toBe(1)
    expect(server.requested('/siteadapter-1.1.0-arm64.zip')).toBe(1)
    expect(server.requested('/siteadapter-1.1.0-x64.zip')).toBe(0)
    expect(nodeUpdater.installs).toEqual([])
  })

  it('downloads the x64 zip on an Intel Mac', async () => {
    await publish('1.1.0')
    const { updater } = setup({ arm64: false })
    expect((await updater.checkNow()).state).toBe('ready')
    expect(await downloaded()).toEqual([zips.get('siteadapter-1.1.0-x64.zip')])
    expect(server.requested('/siteadapter-1.1.0-arm64.zip')).toBe(0)
  })

  it('uses a compiled-in feed URL in place of app-update.yml’s', async () => {
    await publish('1.1.0')
    await writeFile(
      join(dir, 'app-update.yml'),
      'provider: generic\nurl: https://wrong.example.invalid/\nupdaterCacheDirName: siteadapter-updater\n',
    )
    const { updater } = setup({ feedUrl: server.url, allowLoopbackFeed: true })
    expect((await updater.checkNow()).state).toBe('ready')
  })

  it('sends the same constant in place of the per-install staging id, on every request', async () => {
    await publish('1.1.0')
    const { updater } = setup()
    await updater.checkNow()
    const stagingId = (await readFile(join(dir, 'userData', '.updaterId'), 'utf8')).trim()
    expect(stagingId).toMatch(/^[0-9a-f-]{36}$/)
    expect(server.requests.length).toBeGreaterThanOrEqual(2)
    for (const request of server.requests) {
      expect(JSON.stringify(request.headers)).not.toContain(stagingId)
    }
    const channelRequest = server.requests.find((r) => r.path === '/latest-mac.yml')
    expect(channelRequest?.headers['x-user-staging-id']).toBe(STAGING_ID_HEADER_VALUE)
  })

  it('refuses a zip whose bytes differ from the feed’s SHA-512, and never offers it', async () => {
    await publish('1.1.0')
    const original = zips.get('siteadapter-1.1.0-arm64.zip') as Buffer
    const tampered = Buffer.from(original)
    tampered[1000] = (tampered[1000] as number) ^ 0x01
    server.files.set('/siteadapter-1.1.0-arm64.zip', tampered)
    const { updater, nodeUpdater } = setup()
    const status = await updater.checkNow()
    expect(status).toMatchObject({ state: 'error', reason: 'checksum-mismatch', available: null })
    expect(await downloaded()).toEqual([])
    expect(await updater.installAndRestart()).toBe(false)
    expect(nodeUpdater.installs).toEqual([])
  })

  it('stays put when the feed offers an older version', async () => {
    await publish('0.9.0')
    const { updater } = setup()
    expect((await updater.checkNow()).state).toBe('up-to-date')
    expect(server.requested('/siteadapter-0.9.0-arm64.zip')).toBe(0)
  })

  it('stays put on the beta channel too, where electron-updater alone would downgrade', async () => {
    await publish('0.9.0')
    // electron-updater's own behaviour, which the updater guards against: setting a channel turns
    // allowDowngrade on, and the older version is then "available".
    const raw = setup().nodeUpdater
    raw.logger = null
    raw.channel = 'beta'
    expect(raw.allowDowngrade).toBe(true)
    expect((await raw.checkForUpdates())?.isUpdateAvailable).toBe(true)

    const { updater } = setup({ channel: (): UpdateChannelSetting => 'beta' })
    expect((await updater.checkNow()).state).toBe('up-to-date')
    expect(server.requested('/siteadapter-0.9.0-arm64.zip')).toBe(0)
  })

  it('refuses a version below the highest this install has run, before downloading anything', async () => {
    await publish('1.2.0')
    const { updater, logs } = setup({ highestVersionRun: () => '1.5.0' })
    const status = await updater.checkNow()
    expect(status).toMatchObject({ state: 'error', reason: 'downgrade-refused' })
    expect(server.requested('/siteadapter-1.2.0-arm64.zip')).toBe(0)
    expect(logs.at(-1)?.refused).toBe('1.2.0')
  })

  it('refuses a prerelease served as stable, before downloading anything', async () => {
    await publish('2.0.0-beta.1')
    server.files.set('/latest-mac.yml', server.files.get('/beta-mac.yml') as Buffer)
    const { updater } = setup()
    expect((await updater.checkNow()).reason).toBe('channel-mismatch')
    expect(server.requested('/siteadapter-2.0.0-beta.1-arm64.zip')).toBe(0)
  })

  it('offers a beta to the beta channel only', async () => {
    await publish('1.1.0-beta.1')
    expect(server.files.has('/latest-mac.yml')).toBe(false)
    const stable = setup()
    expect((await stable.updater.checkNow()).reason).toBe('feed-unreachable')
    const beta = setup({ channel: () => 'beta' })
    expect((await beta.updater.checkNow()).available).toBe('1.1.0-beta.1')
  })

  it('reports an unreachable feed, a server error and a garbled channel file by code only', async () => {
    const missing = setup()
    expect((await missing.updater.checkNow()).reason).toBe('feed-unreachable')

    server.failures.set('/latest-mac.yml', 403)
    const forbidden = setup()
    expect((await forbidden.updater.checkNow()).reason).toBe('feed-unreachable')

    server.failures.clear()
    server.files.set('/latest-mac.yml', Buffer.from('version: 1.1.0\n'))
    const garbled = setup()
    expect((await garbled.updater.checkNow()).reason).toBe('feed-invalid')
    expect(JSON.stringify(garbled.logs)).not.toContain('127.0.0.1')
  })

  it('reports a zip that has gone missing as a failed download', async () => {
    await publish('1.1.0')
    server.files.delete('/siteadapter-1.1.0-arm64.zip')
    const { updater } = setup()
    expect((await updater.checkNow()).reason).toBe('download-failed')
  })

  it('installs only when asked, after waiting for idle', async () => {
    await publish('1.1.0')
    let idle = false
    const { updater, nodeUpdater } = setup({
      whenIdle: async () => {
        idle = true
      },
    })
    await updater.checkNow()
    expect(nodeUpdater.installs).toEqual([])
    expect(await updater.installAndRestart()).toBe(true)
    expect(idle).toBe(true)
    expect(nodeUpdater.installs).toEqual([[false, true]])
  })

  it('keeps electron-updater’s own logging off, so feed URLs never reach the console', async () => {
    await publish('1.1.0')
    const { updater, nodeUpdater } = setup()
    await updater.checkNow()
    expect(nodeUpdater.logger).not.toBe(console)
  })
})
