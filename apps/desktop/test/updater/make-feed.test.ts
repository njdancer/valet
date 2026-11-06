// @vitest-environment node
// scripts/make-feed.mjs: the channel files for the static feed. That electron-updater reads them is
// proven in feed-server.test.ts; here, what the script refuses to write.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFeedYaml, channelsForVersion, FeedError, hashZip, makeFeed } from '../../scripts/make-feed.mjs'

const SHA = createHash('sha512').update('zip').digest('base64')
const ARM = { name: 'siteadapter-1.2.0-arm64.zip', sha512: SHA, size: 1234 }
const X64 = { name: 'siteadapter-1.2.0-x64.zip', sha512: SHA, size: 5678 }
const DATE = '2026-11-07T10:00:00.000Z'
const SCRIPT = resolve(import.meta.dirname, '../../scripts/make-feed.mjs')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siteadapter-make-feed-'))
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
      '../siteadapter-1.2.0-arm64.zip',
      'sub/siteadapter-1.2.0-arm64.zip',
      "siteadapter-1.2.0-arm64'.zip",
      'siteadapter-1.2.0-arm64.zip\n',
      'siteadapter 1.2.0-arm64.zip',
      'siteadapter-1.2.0-arm64.dmg',
      '.siteadapter-1.2.0-arm64.zip',
      'https://evil.example/siteadapter-1.2.0-arm64.zip',
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
        files: [{ ...ARM, name: 'siteadapter-1.1.0-arm64.zip' }],
        releaseDate: DATE,
      }),
    ).toThrow('must carry the version')
    expect(() =>
      buildFeedYaml({
        version: '1.2.0',
        files: [{ ...ARM, name: 'siteadapter-1.2.0.1-arm64.zip' }],
        releaseDate: DATE,
      }),
    ).toThrow(FeedError)
  })

  it('refuses two zips for one architecture, no zips, or more than two', () => {
    const arm2 = { ...ARM, name: 'siteadapter-1.2.0-arm64-b.zip' }
    const x642 = { ...X64, name: 'siteadapter-1.2.0-x64-b.zip' }
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
    const zip = join(dir, 'siteadapter-1.2.0-arm64.zip')
    await writeFile(zip, bytes)
    const written = await makeFeed({
      version: '1.2.0',
      zips: [zip],
      outDir: join(dir, 'feed'),
      releaseDate: DATE,
    })
    expect(written).toEqual([join(dir, 'feed', 'latest-mac.yml'), join(dir, 'feed', 'beta-mac.yml')])
    const yaml = await readFile(join(dir, 'feed', 'latest-mac.yml'), 'utf8')
    expect(yaml).toContain(`sha512: '${createHash('sha512').update(bytes).digest('base64')}'`)
    expect(yaml).toContain(`size: ${bytes.length}`)
    expect(await readFile(join(dir, 'feed', 'beta-mac.yml'), 'utf8')).toBe(yaml)
  })

  it('writes nothing for a version it refuses', async () => {
    const zip = join(dir, 'siteadapter-1.2.0-alpha.1-arm64.zip')
    await writeFile(zip, 'x')
    await expect(
      makeFeed({ version: '1.2.0-alpha.1', zips: [zip], outDir: join(dir, 'feed') }),
    ).rejects.toThrow(FeedError)
    expect(await readdir(dir)).toEqual(['siteadapter-1.2.0-alpha.1-arm64.zip'])
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

  it('writes the channel files and prints their paths', async () => {
    await writeFile(join(dir, 'siteadapter-1.3.0-beta.2-arm64.zip'), 'zip')
    const { stdout } = await run(process.execPath, [
      SCRIPT,
      '--version',
      '1.3.0-beta.2',
      '--release-date',
      DATE,
      '--out',
      join(dir, 'feed'),
      join(dir, 'siteadapter-1.3.0-beta.2-arm64.zip'),
    ])
    expect(stdout).toBe(`${join(dir, 'feed', 'beta-mac.yml')}\n`)
  })

  it('exits non-zero with a usage message when the version is missing', async () => {
    await expect(run(process.execPath, [SCRIPT, join(dir, 'x.zip')])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('usage: make-feed.mjs'),
    })
  })
})
