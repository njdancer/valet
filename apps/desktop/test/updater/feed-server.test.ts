// @vitest-environment node
// The updater against a local static feed, with electron-updater's real check and download code
// (see node-updater.ts for what is real and what is replaced) and the signed feed provider. The feed
// is written and signed by scripts/make-feed.mjs, so this also proves the app accepts what that
// script publishes, and refuses what an attacker who controls the feed, or a hop on its path, could
// serve instead.

import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEnvelope, makeFeed, RELEASE_APP_ID, signEnvelope } from '../../scripts/make-feed.mjs'
import {
  confineUpdaterSession,
  createUpdater,
  STAGING_ID_HEADER_VALUE,
  type UpdateChannelSetting,
  type UpdaterLogEntry,
  type UpdaterOptions,
} from '../../src/main/updater'
import { FakeFeedServer, writeAppZip } from './fake-feed-server'
import { ManualClock, TEST_FEED_KEYS } from './fakes'
import { NodeAppAdapter, NodeUpdater } from './node-updater'

const RELEASE_DATE = '2026-11-07T10:00:00.000Z'
/** A week after RELEASE_DATE: inside make-feed's default 30-day validity. */
const NOW = Date.parse('2026-11-14T10:00:00.000Z')

let dir: string
let server: FakeFeedServer
const zips = new Map<string, Buffer>()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siteadapter-feed-'))
  server = new FakeFeedServer()
  await server.start()
  zips.clear()
  // What electron-builder writes into Contents/Resources from `publish`. The signed provider
  // replaces its provider; electron-updater still reads the cache directory name from it.
  await writeFile(
    join(dir, 'app-update.yml'),
    `provider: generic\nurl: ${server.url}\nupdaterCacheDirName: siteadapter-updater\n`,
  )
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

/** Builds release zips for a version, runs make-feed over them (signed), and serves the lot. */
async function publish(
  version: string,
  options: { signingKey?: Parameters<typeof makeFeed>[0]['signingKey'] | null; serve?: boolean } = {},
): Promise<Map<string, Buffer>> {
  const build = join(dir, 'build', version)
  const paths: string[] = []
  for (const arch of ['arm64', 'x64']) {
    const name = `siteadapter-${version}-${arch}.zip`
    const path = join(build, name)
    await writeAppZip(path, { bundleId: RELEASE_APP_ID, version }, randomBytes(48 * 1024))
    const bytes = await readFile(path)
    zips.set(name, bytes)
    paths.push(path)
    if (options.serve !== false) server.files.set(`/${name}`, bytes)
  }
  const out = join(build, 'feed')
  const files = new Map<string, Buffer>()
  for (const path of await makeFeed({
    version,
    zips: paths,
    outDir: out,
    releaseDate: RELEASE_DATE,
    ...(options.signingKey === null ? {} : { signingKey: options.signingKey ?? TEST_FEED_KEYS.privateKey }),
  })) {
    files.set(`/${path.slice(out.length + 1)}`, await readFile(path))
  }
  if (options.serve !== false) for (const [path, bytes] of files) server.files.set(path, bytes)
  return files
}

/** Signs `yml` for a channel with the test feed key, as make-feed would, and serves both. */
function serveSigned(channel: 'latest' | 'beta', yml: string, version: string): void {
  const envelope = buildEnvelope({
    channel,
    version,
    yml,
    minimumVersion: '0.0.0',
    issuedAt: RELEASE_DATE,
    expiresAt: '2026-12-07T10:00:00.000Z',
  })
  server.files.set(`/${channel}-mac.yml`, Buffer.from(yml))
  server.files.set(`/${channel}-mac.envelope.json`, Buffer.from(envelope))
  server.files.set(
    `/${channel}-mac.envelope.json.sig`,
    Buffer.from(signEnvelope(envelope, TEST_FEED_KEYS.privateKey)),
  )
}

function setup(
  options: Partial<UpdaterOptions> & { arm64?: boolean; currentVersion?: string; now?: number } = {},
) {
  const app = new NodeAppAdapter(
    options.currentVersion ?? '1.0.0',
    join(dir, 'app-update.yml'),
    join(dir, 'userData'),
    join(dir, 'cache'),
  )
  const nodeUpdater = new NodeUpdater(app, options.arm64 ?? true)
  const guard = confineUpdaterSession(nodeUpdater.partition, server.url)
  const clock = new ManualClock()
  clock.time = options.now ?? NOW
  const logs: UpdaterLogEntry[] = []
  const updater = createUpdater({
    autoUpdater: nodeUpdater,
    enabled: true,
    feed: { url: server.url, publicKey: TEST_FEED_KEYS.publicPem },
    allowLoopbackFeed: true,
    requestGuard: guard,
    currentVersion: app.version,
    channel: () => 'stable',
    autoInstallOnQuit: () => false,
    highestVersionRun: () => app.version,
    whenIdle: async () => {},
    clock,
    random: () => 0,
    log: (entry) => logs.push(entry),
    ...options,
  })
  return { updater, nodeUpdater, logs, guard }
}

async function downloaded(): Promise<Buffer[]> {
  const pending = join(dir, 'cache', 'siteadapter-updater', 'pending')
  const names = await readdir(pending).catch(() => [] as string[])
  return Promise.all(names.filter((n) => n.endsWith('.zip')).map((n) => readFile(join(pending, n))))
}

/** Every zip request the server saw. */
function zipRequests(): string[] {
  return server.requests.filter((r) => r.path.endsWith('.zip')).map((r) => r.path)
}

describe('the updater against a local signed feed', () => {
  it('finds a newer version, verifies its envelope, downloads the arm64 zip with a verified SHA-512, and waits', async () => {
    await publish('1.1.0')
    const { updater, nodeUpdater } = setup()
    const status = await updater.checkNow()
    expect(status).toMatchObject({ state: 'ready', available: '1.1.0', reason: null })
    expect(await downloaded()).toEqual([zips.get('siteadapter-1.1.0-arm64.zip')])
    expect(server.requested('/latest-mac.yml')).toBe(1)
    expect(server.requested('/latest-mac.envelope.json')).toBe(1)
    expect(server.requested('/latest-mac.envelope.json.sig')).toBe(1)
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

  it('uses the compiled-in feed, never app-update.yml’s', async () => {
    await publish('1.1.0')
    await writeFile(
      join(dir, 'app-update.yml'),
      'provider: generic\nurl: https://wrong.example.invalid/\nupdaterCacheDirName: siteadapter-updater\n',
    )
    const { updater } = setup()
    expect((await updater.checkNow()).state).toBe('ready')
  })

  it('sends the same constant in place of the per-install staging id, on every request', async () => {
    await publish('1.1.0')
    const { updater } = setup()
    await updater.checkNow()
    const stagingId = (await readFile(join(dir, 'userData', '.updaterId'), 'utf8')).trim()
    expect(stagingId).toMatch(/^[0-9a-f-]{36}$/)
    expect(server.requests.length).toBeGreaterThanOrEqual(4)
    for (const request of server.requests) {
      expect(JSON.stringify(request.headers)).not.toContain(stagingId)
    }
    for (const path of ['/latest-mac.yml', '/latest-mac.envelope.json']) {
      expect(server.requests.find((r) => r.path === path)?.headers['x-user-staging-id']).toBe(
        STAGING_ID_HEADER_VALUE,
      )
    }
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
    expect(zipRequests()).toEqual([])
  })

  it('stays put on the beta channel too, where electron-updater alone would downgrade', async () => {
    await publish('0.9.0')
    // electron-updater's own behaviour, which the updater guards against: setting a channel turns
    // allowDowngrade on, and the older version is then "available" (generic provider, unsigned).
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
    expect(zipRequests()).toEqual([])
    expect(logs.at(-1)?.refused).toBe('1.2.0')
  })

  it('offers a beta to the beta channel only', async () => {
    await publish('1.1.0-beta.1')
    expect(server.files.has('/latest-mac.yml')).toBe(false)
    const stable = setup()
    expect((await stable.updater.checkNow()).reason).toBe('feed-unreachable')
    const beta = setup({ channel: () => 'beta' })
    expect((await beta.updater.checkNow()).available).toBe('1.1.0-beta.1')
  })

  it('reports an unreachable feed and a server error by code only', async () => {
    const missing = setup()
    expect((await missing.updater.checkNow()).reason).toBe('feed-unreachable')

    server.failures.set('/latest-mac.yml', 403)
    const forbidden = setup()
    expect((await forbidden.updater.checkNow()).reason).toBe('feed-unreachable')
    expect(JSON.stringify(forbidden.logs)).not.toContain('127.0.0.1')
  })

  it('reports a signed channel file it can’t use as invalid, before downloading anything', async () => {
    serveSigned('latest', 'version: 1.1.0\n', '1.1.0')
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

describe('the signed feed against an attacker who controls the feed', () => {
  it('refuses a channel file rewritten to version 99 around a genuine old zip', async () => {
    // The old build is genuinely signed and passes Squirrel.Mac; only the version is a lie.
    const old = await publish('0.9.0', { serve: false })
    await publish('1.1.0')
    const yml = (old.get('/latest-mac.yml') as Buffer).toString().replaceAll('0.9.0', '99.0.0')
    server.files.set('/latest-mac.yml', Buffer.from(yml))
    for (const arch of ['arm64', 'x64']) {
      server.files.set(`/siteadapter-99.0.0-${arch}.zip`, zips.get(`siteadapter-0.9.0-${arch}.zip`) as Buffer)
    }
    const { updater, logs } = setup()
    expect(await updater.checkNow()).toMatchObject({
      state: 'error',
      reason: 'feed-unverified',
      available: null,
    })
    expect(zipRequests()).toEqual([])
    expect(await downloaded()).toEqual([])
    expect(JSON.stringify(logs)).not.toContain('99.0.0')
  })

  it('refuses the same rewrite with the old envelope and signature served beside it', async () => {
    const old = await publish('0.9.0', { serve: false })
    for (const [path, bytes] of old) server.files.set(path, bytes)
    server.files.set(
      '/latest-mac.yml',
      Buffer.from((old.get('/latest-mac.yml') as Buffer).toString().replaceAll('0.9.0', '99.0.0')),
    )
    server.files.set('/siteadapter-99.0.0-arm64.zip', zips.get('siteadapter-0.9.0-arm64.zip') as Buffer)
    const { updater } = setup()
    expect((await updater.checkNow()).reason).toBe('feed-unverified')
    expect(zipRequests()).toEqual([])
  })

  it('refuses a feed signed by another key', async () => {
    await publish('1.1.0', { signingKey: generateKeyPairSync('ed25519').privateKey })
    const { updater } = setup()
    expect((await updater.checkNow()).reason).toBe('feed-unverified')
    expect(zipRequests()).toEqual([])
  })

  it('refuses an unsigned feed: no envelope, or no signature', async () => {
    await publish('1.1.0', { signingKey: null })
    expect(server.files.has('/latest-mac.envelope.json')).toBe(false)
    const unsigned = setup()
    expect((await unsigned.updater.checkNow()).reason).toBe('feed-unverified')

    await publish('1.1.0')
    server.files.delete('/latest-mac.envelope.json.sig')
    const noSignature = setup()
    expect((await noSignature.updater.checkNow()).reason).toBe('feed-unverified')
    expect(zipRequests()).toEqual([])
  })

  it('refuses a frozen feed once its envelope expires, and says so', async () => {
    await publish('1.1.0')
    const { updater } = setup({ now: Date.parse('2026-12-07T10:00:00.000Z') })
    expect((await updater.checkNow()).reason).toBe('feed-expired')
    expect(zipRequests()).toEqual([])
  })

  it('refuses the beta envelope served as stable', async () => {
    await publish('1.1.0-beta.1')
    for (const suffix of ['yml', 'envelope.json', 'envelope.json.sig']) {
      server.files.set(`/latest-mac.${suffix}`, server.files.get(`/beta-mac.${suffix}`) as Buffer)
    }
    const { updater } = setup()
    expect((await updater.checkNow()).reason).toBe('feed-unverified')
    expect(zipRequests()).toEqual([])
  })

  it('refuses a signed channel file whose zip lives on another host, before fetching it', async () => {
    const yml = [
      "version: '1.1.0'",
      'files:',
      "  - url: 'http://localhost:1/siteadapter-1.1.0-arm64.zip'",
      `    sha512: '${'A'.repeat(86)}=='`,
      '    size: 10',
      "path: 'siteadapter-1.1.0-arm64.zip'",
      `sha512: '${'A'.repeat(86)}=='`,
      `releaseDate: '${RELEASE_DATE}'`,
      '',
    ].join('\n')
    serveSigned('latest', yml, '1.1.0')
    const { updater } = setup()
    expect((await updater.checkNow()).reason).toBe('feed-unverified')
  })
})

describe('the session guard against redirects', () => {
  it('cancels a redirect of the zip to another origin before anything is fetched there', async () => {
    await publish('1.1.0')
    const elsewhere = server.url.replace('127.0.0.1', 'localhost')
    server.redirects.set('/siteadapter-1.1.0-arm64.zip', `${elsewhere}elsewhere/siteadapter-1.1.0-arm64.zip`)
    server.files.set(
      '/elsewhere/siteadapter-1.1.0-arm64.zip',
      zips.get('siteadapter-1.1.0-arm64.zip') as Buffer,
    )
    const { updater, nodeUpdater, guard } = setup()
    expect(await updater.checkNow()).toMatchObject({ state: 'error', reason: 'request-refused' })
    expect(server.requested('/elsewhere/siteadapter-1.1.0-arm64.zip')).toBe(0)
    expect(guard.refusals()).toBe(1)
    expect(nodeUpdater.partition.seen.at(-1)).toContain('localhost')
    expect(await downloaded()).toEqual([])
  })

  it('cancels a redirect of the channel file to a different scheme on the same host', async () => {
    await publish('1.1.0')
    server.redirects.set('/latest-mac.yml', `${server.url.replace('http:', 'https:')}latest-mac.yml`)
    const { updater, guard } = setup()
    expect((await updater.checkNow()).reason).toBe('request-refused')
    expect(guard.refusals()).toBe(1)
    expect(zipRequests()).toEqual([])
  })

  it('cancels a redirect of the envelope to another port on the same host', async () => {
    await publish('1.1.0')
    // Leaving the feed directory on the same origin is the guard's unit tests' job: this feed's
    // base is the server root.
    server.redirects.set('/latest-mac.envelope.json', 'http://127.0.0.1:1/latest-mac.envelope.json')
    const { updater, nodeUpdater } = setup()
    expect((await updater.checkNow()).reason).toBe('request-refused')
    expect(nodeUpdater.partition.seen).toContain('http://127.0.0.1:1/latest-mac.envelope.json')
    expect(zipRequests()).toEqual([])
  })

  it('lets a redirect within the feed base through', async () => {
    await publish('1.1.0')
    server.redirects.set('/siteadapter-1.1.0-arm64.zip', `${server.url}moved/siteadapter-1.1.0-arm64.zip`)
    server.files.set('/moved/siteadapter-1.1.0-arm64.zip', zips.get('siteadapter-1.1.0-arm64.zip') as Buffer)
    const { updater, guard } = setup()
    expect((await updater.checkNow()).state).toBe('ready')
    expect(guard.refusals()).toBe(0)
  })
})

describe('make-feed’s checks on what it publishes', () => {
  it('refuses a development build’s zip, or one holding another version', async () => {
    const build = join(dir, 'bad')
    await mkdir(build, { recursive: true })
    const dev = join(build, 'siteadapter-dev-1.2.0-arm64.zip')
    await writeAppZip(
      dev,
      { bundleId: `${RELEASE_APP_ID}.dev`, version: '1.2.0', appName: 'siteadapter-dev' },
      randomBytes(64),
    )
    await expect(makeFeed({ version: '1.2.0', zips: [dev], outDir: join(build, 'feed') })).rejects.toThrow(
      'not the release app',
    )
    const stale = join(build, 'siteadapter-1.2.0-arm64.zip')
    await writeAppZip(stale, { bundleId: RELEASE_APP_ID, version: '1.1.0' }, randomBytes(64))
    await expect(makeFeed({ version: '1.2.0', zips: [stale], outDir: join(build, 'feed') })).rejects.toThrow(
      'another version',
    )
    expect(await readdir(build)).not.toContain('feed')
  })
})
