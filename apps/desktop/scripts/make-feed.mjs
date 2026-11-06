#!/usr/bin/env node
// Writes the channel files for the static update feed: latest-mac.yml (and beta-mac.yml) in the
// shape electron-builder writes and electron-updater's generic provider reads, for zips that already
// exist. electron-builder writes these itself during a build; this is for publishing zips built
// earlier, re-issuing a channel file, and the updater tests.
//
//   node scripts/make-feed.mjs --version 1.2.0 [--release-date 2026-11-07T10:00:00.000Z] \
//     [--out dist/feed] dist/siteadapter-1.2.0-arm64.zip dist/siteadapter-1.2.0-x64.zip
//
// A stable version is written to both channels, so beta installs move on to it once it overtakes
// their beta. A beta prerelease (1.3.0-beta.1) is written to beta only. Any other prerelease tag is
// refused: the app offers only "stable" and "beta".

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { formatVersion, parseVersion } from '../src/main/updater/version.ts'

const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/

export class FeedError extends Error {
  name = 'FeedError'
}

/** The channels a version is published to. */
export function channelsForVersion(version) {
  const parsed = parseVersion(version)
  if (parsed === null || formatVersion(parsed) !== version) {
    throw new FeedError('version must be canonical SemVer without build metadata, e.g. 1.2.0 or 1.3.0-beta.1')
  }
  if (parsed.prerelease.length === 0) return ['latest', 'beta']
  if (parsed.prerelease[0] === 'beta') return ['beta']
  throw new FeedError('only beta prereleases are published (1.3.0-beta.N)')
}

// electron-updater picks the zip for the machine by whether its name contains "arm64"
// (MacUpdater.filterFilesForArch), so a feed has at most one of each kind.
function isArm64(name) {
  return name.includes('arm64')
}

/**
 * Builds the channel file text. `files` are { name, sha512, size }, sha512 in base64 as
 * electron-updater checks it.
 */
export function buildFeedYaml({ version, files, releaseDate }) {
  channelsForVersion(version)
  if (
    typeof releaseDate !== 'string' ||
    !ISO_TIME.test(releaseDate) ||
    Number.isNaN(Date.parse(releaseDate))
  ) {
    throw new FeedError('releaseDate must be an ISO 8601 UTC time, e.g. 2026-11-07T10:00:00.000Z')
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 2) {
    throw new FeedError('give one zip per architecture: arm64, x64, or both')
  }
  for (const file of files) {
    if (typeof file.name !== 'string' || !ZIP_NAME.test(file.name)) {
      throw new FeedError('zip names are plain file names ending in .zip ([A-Za-z0-9._-])')
    }
    if (!file.name.includes(`-${version}-`)) {
      throw new FeedError(`zip name must carry the version (-${version}-), so a stale zip can't be published`)
    }
    if (typeof file.sha512 !== 'string' || !SHA512_BASE64.test(file.sha512)) {
      throw new FeedError('sha512 must be base64 of a 64-byte digest')
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0)
      throw new FeedError('size must be a positive integer')
  }
  if (files.length === 2 && isArm64(files[0].name) === isArm64(files[1].name)) {
    throw new FeedError('two zips for the same architecture')
  }
  const first = files[0]
  const lines = [`version: '${version}'`, 'files:']
  for (const file of files) {
    lines.push(`  - url: '${file.name}'`, `    sha512: '${file.sha512}'`, `    size: ${file.size}`)
  }
  lines.push(`path: '${first.name}'`, `sha512: '${first.sha512}'`, `releaseDate: '${releaseDate}'`, '')
  return lines.join('\n')
}

/** SHA-512 of a file, base64, and its size. */
export async function hashZip(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const { size } = await stat(path)
  return { name: basename(path), sha512: hash.digest('base64'), size }
}

/** Hashes the zips and writes <channel>-mac.yml for each channel the version belongs to. */
export async function makeFeed({ version, zips, outDir, releaseDate = new Date().toISOString() }) {
  const channels = channelsForVersion(version)
  const files = []
  for (const zip of zips) files.push(await hashZip(zip))
  const yaml = buildFeedYaml({ version, files, releaseDate })
  await mkdir(outDir, { recursive: true })
  const written = []
  for (const channel of channels) {
    const path = join(outDir, `${channel}-mac.yml`)
    await writeFile(path, yaml)
    written.push(path)
  }
  return written
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      'release-date': { type: 'string' },
      out: { type: 'string' },
    },
  })
  if (values.version === undefined || positionals.length === 0) {
    throw new FeedError(
      'usage: make-feed.mjs --version <semver> [--release-date <iso>] [--out <dir>] <zip>...',
    )
  }
  const written = await makeFeed({
    version: values.version,
    zips: positionals.map((p) => resolve(p)),
    outDir: resolve(values.out ?? '.'),
    releaseDate: values['release-date'],
  })
  for (const path of written) process.stdout.write(`${path}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`make-feed: ${error instanceof FeedError ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
