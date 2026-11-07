// @vitest-environment node
// scripts/make-feed.mjs: the channel files for the static feed. That electron-updater reads them is
// proven in feed-server.test.ts; here, what the script refuses to write.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildFeedYaml,
  channelsForVersion,
  FeedError,
  hashZip,
  makeFeed,
  RELEASE_APP_ID,
  readZipBundleInfo,
} from '../../scripts/make-feed.mjs'
import { verifyFeed } from '../../src/main/updater'
import { writeAppZip } from './fake-feed-server'
import { TEST_FEED_KEYS } from './fakes'

const SHA = createHash('sha512').update('zip').digest('base64')
const ARM = { name: 'valet-1.2.0-arm64.zip', sha512: SHA, size: 1234 }
const X64 = { name: 'valet-1.2.0-x64.zip', sha512: SHA, size: 5678 }
const DATE = '2026-11-07T10:00:00.000Z'
const SCRIPT = resolve(import.meta.dirname, '../../scripts/make-feed.mjs')
/** For zips that aren't real: what readZipBundleInfo would read from a release zip of `version`. */
const releaseInfo = (version: string) => () => ({ bundleId: RELEASE_APP_ID, version })

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-make-feed-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('channelsForVersion', () => {
  it('publishes a stable version to both channels and a beta to beta only', () => {
    expect(channelsForVersion('1.2.0')).toEqual(['latest', 'beta'])
    expect(channelsForVersion('1.3.0-beta.1')).toEqual(['beta'])
  })

  it('refuses other prerelease tags and non-canonical versions', () => {
    for (const version of [
      '1.3.0-alpha.1',
      '1.3.0-rc.1',
      '1.3.0-betax',
      'v1.2.0',
      '1.2',
      '1.2.0+build.5',
      '',
    ]) {
      expect(() => channelsForVersion(version), version).toThrow(FeedError)
    }
  })
})

describe('buildFeedYaml', () => {
  it('writes electron-builder’s latest-mac.yml shape, first file as the legacy path', () => {
    expect(buildFeedYaml({ version: '1.2.0', files: [ARM, X64], releaseDate: DATE })).toBe(
      [
        "version: '1.2.0'",
        'files:',
        `  - url: '${ARM.name}'`,
        `    sha512: '${SHA}'`,
        '    size: 1234',
        `  - url: '${X64.name}'`,
        `    sha512: '${SHA}'`,
        '    size: 5678',
        `path: '${ARM.name}'`,
        `sha512: '${SHA}'`,
        `releaseDate: '${DATE}'`,
        '',
      ].join('\n'),
    )
  })

  it('refuses names that could escape the feed directory or break the YAML', () => {
    for (const name of [
      '../valet-1.2.0-arm64.zip',
      'sub/valet-1.2.0-arm64.zip',
      "valet-1.2.0-arm64'.zip",
      'valet-1.2.0-arm64.zip\n',
      'valet 1.2.0-arm64.zip',
      'valet-1.2.0-arm64.dmg',
      '.valet-1.2.0-arm64.zip',
      'https://evil.example/valet-1.2.0-arm64.zip',
    ]) {
      expect(
        () => buildFeedYaml({ version: '1.2.0', files: [{ ...ARM, name }], releaseDate: DATE }),
        name,
      ).toThrow(FeedError)
    }
  })

  it('refuses a zip whose name carries another version', () => {
    expect(() =>
      buildFeedYaml({
        version: '1.2.0',
        files: [{ ...ARM, name: 'valet-1.1.0-arm64.zip' }],
        releaseDate: DATE,
      }),
    ).toThrow('must carry the version')
    expect(() =>
      buildFeedYaml({
        version: '1.2.0',
        files: [{ ...ARM, name: 'valet-1.2.0.1-arm64.zip' }],
        releaseDate: DATE,
      }),
    ).toThrow(FeedError)
  })

  it('refuses two zips for one architecture, no zips, or more than two', () => {
    const arm2 = { ...ARM, name: 'valet-1.2.0-arm64-b.zip' }
    const x642 = { ...X64, name: 'valet-1.2.0-x64-b.zip' }
    expect(() => buildFeedYaml({ version: '1.2.0', files: [ARM, arm2], releaseDate: DATE })).toThrow(
      'same architecture',
    )
    expect(() => buildFeedYaml({ version: '1.2.0', files: [X64, x642], releaseDate: DATE })).toThrow(
      'same architecture',
    )
    expect(() => buildFeedYaml({ version: '1.2.0', files: [], releaseDate: DATE })).toThrow(FeedError)
    expect(() => buildFeedYaml({ version: '1.2.0', files: [ARM, X64, ARM], releaseDate: DATE })).toThrow(
      FeedError,
    )
  })

  it('refuses a malformed digest, size or date', () => {
    const bad = [
      { files: [{ ...ARM, sha512: 'abc' }], releaseDate: DATE },
      { files: [{ ...ARM, sha512: createHash('sha256').update('x').digest('base64') }], releaseDate: DATE },
      { files: [{ ...ARM, sha512: `${SHA.slice(0, -3)}'x` }], releaseDate: DATE },
      { files: [{ ...ARM, size: 0 }], releaseDate: DATE },
      { files: [{ ...ARM, size: 1.5 }], releaseDate: DATE },
      { files: [ARM], releaseDate: '2026-11-07' },
      { files: [ARM], releaseDate: "2026-11-07T10:00:00Z'\nversion: '9.9.9" },
      { files: [ARM], releaseDate: '2026-13-45T10:00:00Z' },
    ]
    for (const input of bad) {
      expect(() => buildFeedYaml({ version: '1.2.0', ...input })).toThrow(FeedError)
    }
  })
})

describe('makeFeed', () => {
  it('hashes the zips and writes one file per channel', async () => {
    const bytes = Buffer.from('not really a zip')
    const zip = join(dir, 'valet-1.2.0-arm64.zip')
    await writeFile(zip, bytes)
    const written = await makeFeed({
      version: '1.2.0',
      zips: [zip],
      outDir: join(dir, 'feed'),
      releaseDate: DATE,
      readBundleInfo: releaseInfo('1.2.0'),
    })
    expect(written).toEqual([join(dir, 'feed', 'latest-mac.yml'), join(dir, 'feed', 'beta-mac.yml')])
    const yaml = await readFile(join(dir, 'feed', 'latest-mac.yml'), 'utf8')
    expect(yaml).toContain(`sha512: '${createHash('sha512').update(bytes).digest('base64')}'`)
    expect(yaml).toContain(`size: ${bytes.length}`)
    expect(await readFile(join(dir, 'feed', 'beta-mac.yml'), 'utf8')).toBe(yaml)
  })

  it('signs an envelope for each channel it writes, which the app accepts', async () => {
    const zip = join(dir, 'valet-1.2.0-arm64.zip')
    await writeFile(zip, 'zip')
    const out = join(dir, 'feed')
    const written = await makeFeed({
      version: '1.2.0',
      zips: [zip],
      outDir: out,
      releaseDate: DATE,
      signingKey: TEST_FEED_KEYS.privateKey,
      minimumVersion: '1.1.4',
      validDays: 14,
      readBundleInfo: releaseInfo('1.2.0'),
    })
    expect(written.map((p) => p.slice(out.length + 1))).toEqual([
      'latest-mac.yml',
      'latest-mac.envelope.json',
      'latest-mac.envelope.json.sig',
      'beta-mac.yml',
      'beta-mac.envelope.json',
      'beta-mac.envelope.json.sig',
    ])
    for (const channel of ['latest', 'beta'] as const) {
      const read = (suffix: string) => readFile(join(out, `${channel}-mac.${suffix}`), 'utf8')
      const envelope = await read('envelope.json')
      expect(JSON.parse(envelope)).toMatchObject({
        channel,
        version: '1.2.0',
        minimumVersion: '1.1.4',
        issuedAt: DATE,
        expiresAt: '2026-11-21T10:00:00.000Z',
      })
      const verdict = verifyFeed(
        { yml: await read('yml'), envelope, signature: await read('envelope.json.sig') },
        {
          publicKey: TEST_FEED_KEYS.publicKey,
          channel,
          now: Date.parse(DATE) + 1000,
          readYmlVersion: (yml) => /^version: '([^']+)'$/m.exec(yml)?.[1],
        },
      )
      expect(verdict.ok).toBe(true)
    }
  })

  it('refuses a validity window it can’t sign, or a minimum version above the version', async () => {
    const zip = join(dir, 'valet-1.2.0-arm64.zip')
    await writeFile(zip, 'zip')
    const base = {
      version: '1.2.0',
      zips: [zip],
      outDir: join(dir, 'feed'),
      releaseDate: DATE,
      signingKey: TEST_FEED_KEYS.privateKey,
      readBundleInfo: releaseInfo('1.2.0'),
    }
    for (const validDays of [0, 63, 1.5, Number.NaN]) {
      await expect(makeFeed({ ...base, validDays }), String(validDays)).rejects.toThrow(FeedError)
    }
    await expect(makeFeed({ ...base, minimumVersion: '1.3.0' })).rejects.toThrow(FeedError)
    expect(await readdir(dir)).toEqual(['valet-1.2.0-arm64.zip'])
  })

  it('leaves beta-mac.yml alone when it names a newer beta than this stable release', async () => {
    const out = join(dir, 'feed')
    const beta = join(dir, 'valet-1.4.0-beta.1-arm64.zip')
    await writeFile(beta, 'beta')
    await makeFeed({
      version: '1.4.0-beta.1',
      zips: [beta],
      outDir: out,
      readBundleInfo: releaseInfo('1.4.0-beta.1'),
    })
    const betaYml = await readFile(join(out, 'beta-mac.yml'), 'utf8')

    const hotfix = join(dir, 'valet-1.3.1-arm64.zip')
    await writeFile(hotfix, 'hotfix')
    const written = await makeFeed({
      version: '1.3.1',
      zips: [hotfix],
      outDir: out,
      readBundleInfo: releaseInfo('1.3.1'),
    })
    expect(written).toEqual([join(out, 'latest-mac.yml')])
    expect(await readFile(join(out, 'beta-mac.yml'), 'utf8')).toBe(betaYml)

    // Once a stable release overtakes the beta, beta installs move on to it.
    const release = join(dir, 'valet-1.4.0-arm64.zip')
    await writeFile(release, 'release')
    expect(
      await makeFeed({
        version: '1.4.0',
        zips: [release],
        outDir: out,
        readBundleInfo: releaseInfo('1.4.0'),
      }),
    ).toEqual([join(out, 'latest-mac.yml'), join(out, 'beta-mac.yml')])
    expect(await readFile(join(out, 'beta-mac.yml'), 'utf8')).toContain("version: '1.4.0'")
  })

  it('reads the bundle ID and version from the one app in a real zip', async () => {
    const zip = join(dir, 'valet-1.2.0-arm64.zip')
    await writeAppZip(zip, { bundleId: RELEASE_APP_ID, version: '1.2.0' }, Buffer.from('binary'))
    expect(readZipBundleInfo(zip)).toEqual({ bundleId: RELEASE_APP_ID, version: '1.2.0' })
    expect((await makeFeed({ version: '1.2.0', zips: [zip], outDir: join(dir, 'feed') })).length).toBe(2)
  })

  it('refuses a zip with no app, or with two', async () => {
    const empty = join(dir, 'valet-1.2.0-arm64.zip')
    await writeFile(join(dir, 'readme.txt'), 'x')
    await promisify(execFile)('/usr/bin/ditto', ['-c', '-k', join(dir, 'readme.txt'), empty])
    expect(() => readZipBundleInfo(empty)).toThrow('exactly one .app')

    const two = join(dir, 'two', 'valet-1.2.0-x64.zip')
    await writeAppZip(
      join(dir, 'a.zip'),
      { bundleId: RELEASE_APP_ID, version: '1.2.0', appName: 'a' },
      Buffer.from('a'),
    )
    await writeAppZip(
      join(dir, 'b.zip'),
      { bundleId: RELEASE_APP_ID, version: '1.2.0', appName: 'b' },
      Buffer.from('b'),
    )
    await mkdir(join(dir, 'two', 'root'), { recursive: true })
    await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', join(dir, 'a.zip'), join(dir, 'two', 'root')])
    await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', join(dir, 'b.zip'), join(dir, 'two', 'root')])
    await promisify(execFile)('/usr/bin/ditto', ['-c', '-k', join(dir, 'two', 'root'), two])
    expect(() => readZipBundleInfo(two)).toThrow('exactly one .app')
  })

  it('writes nothing for a version it refuses', async () => {
    const zip = join(dir, 'valet-1.2.0-alpha.1-arm64.zip')
    await writeFile(zip, 'x')
    await expect(
      makeFeed({ version: '1.2.0-alpha.1', zips: [zip], outDir: join(dir, 'feed') }),
    ).rejects.toThrow(FeedError)
    expect(await readdir(dir)).toEqual(['valet-1.2.0-alpha.1-arm64.zip'])
  })

  it('hashes a file as a stream, the same as hashing its bytes', async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7)
    await writeFile(join(dir, 'big.zip'), bytes)
    expect(await hashZip(join(dir, 'big.zip'))).toEqual({
      name: 'big.zip',
      sha512: createHash('sha512').update(bytes).digest('base64'),
      size: bytes.length,
    })
  })
})

describe('make-feed.mjs on the command line', () => {
  const run = promisify(execFile)

  it('writes and signs the channel files and prints their paths', async () => {
    const zip = join(dir, 'valet-1.3.0-beta.2-arm64.zip')
    await writeAppZip(zip, { bundleId: RELEASE_APP_ID, version: '1.3.0-beta.2' }, Buffer.from('zip'))
    const key = join(dir, 'feed-key.pem')
    await writeFile(key, TEST_FEED_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const { stdout } = await run(process.execPath, [
      SCRIPT,
      '--version',
      '1.3.0-beta.2',
      '--signing-key',
      key,
      '--valid-days',
      '7',
      '--release-date',
      DATE,
      '--out',
      join(dir, 'feed'),
      zip,
    ])
    const feed = join(dir, 'feed', 'beta-mac')
    expect(stdout).toBe(`${feed}.yml\n${feed}.envelope.json\n${feed}.envelope.json.sig\n`)
    expect(JSON.parse(await readFile(`${feed}.envelope.json`, 'utf8')).expiresAt).toBe(
      '2026-11-14T10:00:00.000Z',
    )
  })

  it('needs a signing key or an explicit --unsigned, not both', async () => {
    const zip = join(dir, 'valet-1.2.0-arm64.zip')
    await writeAppZip(zip, { bundleId: RELEASE_APP_ID, version: '1.2.0' }, Buffer.from('zip'))
    await expect(run(process.execPath, [SCRIPT, '--version', '1.2.0', zip])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('--signing-key <pem> | --unsigned'),
    })
    await expect(
      run(process.execPath, [SCRIPT, '--version', '1.2.0', '--unsigned', '--signing-key', zip, zip]),
    ).rejects.toMatchObject({ code: 1 })
    const { stdout } = await run(process.execPath, [
      SCRIPT,
      '--version',
      '1.2.0',
      '--unsigned',
      '--out',
      join(dir, 'feed'),
      zip,
    ])
    expect(stdout.trim().split('\n')).toHaveLength(2)
  })

  it('exits non-zero with a usage message when the version is missing', async () => {
    await expect(run(process.execPath, [SCRIPT, join(dir, 'x.zip')])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('usage: make-feed.mjs'),
    })
  })
})
