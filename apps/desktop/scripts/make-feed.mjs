#!/usr/bin/env node
// Writes the channel files for the static update feed: latest-mac.yml (and beta-mac.yml) in the
// shape electron-builder writes and electron-updater's generic provider reads, for zips that already
// exist. electron-builder writes these itself during a build; this is for publishing zips built
// earlier, re-issuing a channel file, and the updater tests.
//
//   node scripts/make-feed.mjs --version 1.2.0 --signing-key ~/feed-key.pem \
//     [--minimum-version 1.1.4] [--valid-days 30] [--release-date 2026-11-07T10:00:00.000Z] \
//     [--out dist/feed] dist/valet-1.2.0-arm64.zip dist/valet-1.2.0-x64.zip
//
// A stable version is written to both channels, so beta installs move on to it once it overtakes
// their beta, but beta-mac.yml is left alone when it already names a newer beta. A beta prerelease
// (1.3.0-beta.1) is written to beta only. Any other prerelease tag is refused: the app offers only
// "stable" and "beta".
//
// Each zip must hold exactly one <name>.app whose Info.plist names the release bundle ID and the
// version being published, so a dev build or a stale zip can't be published under a new name.
//
// With --signing-key (a PKCS#8 PEM Ed25519 private key: the offline feed key, never the Developer ID
// key), each channel file gets its signed envelope, <channel>-mac.envelope.json and .sig, which the
// app requires (src/main/updater/feed-envelope.ts). Without one, pass --unsigned to write channel
// files only; the app refuses those.

import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { compareVersions, formatVersion, parseVersion } from '../src/main/updater/version.ts'

const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/
const APP_PLIST = /^[A-Za-z0-9 ._-]+\.app\/Contents\/Info\.plist$/

/** electron-builder.config.ts's RELEASE_APP_ID (make-feed.test.ts holds them equal). */
export const RELEASE_APP_ID = 'me.dncr.valet'
/** The envelope's keys in signing order: feed-envelope.ts's ENVELOPE_KEYS. */
export const ENVELOPE_KEYS = ['channel', 'version', 'ymlSha256', 'minimumVersion', 'issuedAt', 'expiresAt']
/** feed-envelope.ts's MAX_ENVELOPE_VALIDITY_MS, in days. */
export const MAX_VALID_DAYS = 62
const DAY_MS = 24 * 60 * 60 * 1000

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

/**
 * The envelope for one channel file, as the exact text that is signed: canonical JSON, keys in
 * ENVELOPE_KEYS order, ASCII only.
 */
export function buildEnvelope({ channel, version, yml, minimumVersion, issuedAt, expiresAt }) {
  if (channel !== 'latest' && channel !== 'beta') throw new FeedError('channel is latest or beta')
  const parsed = parseVersion(version)
  const minimum = parseVersion(minimumVersion)
  if (parsed === null || formatVersion(parsed) !== version) throw new FeedError('version must be canonical')
  if (minimum === null || formatVersion(minimum) !== minimumVersion) {
    throw new FeedError('minimum version must be canonical SemVer, e.g. 1.1.4')
  }
  if (compareVersions(minimum, parsed) > 0) throw new FeedError('minimum version is above the version')
  for (const value of [issuedAt, expiresAt]) {
    if (typeof value !== 'string' || !ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) {
      throw new FeedError('envelope times must be ISO 8601 UTC, e.g. 2026-11-07T10:00:00.000Z')
    }
  }
  const validity = Date.parse(expiresAt) - Date.parse(issuedAt)
  if (validity <= 0 || validity > MAX_VALID_DAYS * DAY_MS) {
    throw new FeedError(`an envelope is valid for more than 0 and at most ${MAX_VALID_DAYS} days`)
  }
  if (typeof yml !== 'string' || !/^[\u0020-\u007e\n]*$/.test(yml))
    throw new FeedError('channel file is not ASCII')
  const ymlSha256 = createHash('sha256').update(yml, 'utf8').digest('hex')
  const values = { channel, version, ymlSha256, minimumVersion, issuedAt, expiresAt }
  return JSON.stringify(Object.fromEntries(ENVELOPE_KEYS.map((key) => [key, values[key]])))
}

/** The detached signature file's text: base64 Ed25519 over the envelope's bytes, and a newline. */
export function signEnvelope(envelope, privateKey) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new FeedError('the signing key must be an Ed25519 private key')
  }
  return `${sign(null, Buffer.from(envelope, 'latin1'), key).toString('base64')}\n`
}

/**
 * The bundle ID and version of the one app inside a zip, from its Contents/Info.plist, read with
 * /usr/bin/unzip and /usr/bin/plutil (nothing is extracted to disk).
 */
export function readZipBundleInfo(path) {
  const entries = execFileSync('/usr/bin/unzip', ['-Z1', '--', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((entry) => APP_PLIST.test(entry))
  if (entries.length !== 1) throw new FeedError(`${basename(path)} must hold exactly one .app`)
  const plist = execFileSync('/usr/bin/unzip', ['-p', '--', path, entries[0]], { maxBuffer: 1024 * 1024 })
  const info = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
      input: plist,
      encoding: 'utf8',
    }),
  )
  return { bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString }
}

function checkBundle(path, info, version, appId) {
  if (info?.bundleId !== appId) {
    throw new FeedError(`${basename(path)} is not the release app (${appId}): a development build?`)
  }
  if (info?.version !== version)
    throw new FeedError(`${basename(path)} holds another version than ${version}`)
}

/** The version a channel file names, or null if there is none or it can't be read. */
async function publishedVersion(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const match = /^version: '?([^'\n]+)'?$/m.exec(text)
  return match === null ? null : parseVersion(match[1])
}

/** SHA-512 of a file, base64, and its size. */
export async function hashZip(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const { size } = await stat(path)
  return { name: basename(path), sha512: hash.digest('base64'), size }
}

/**
 * Checks and hashes the zips and writes <channel>-mac.yml for each channel the version belongs to,
 * with its signed envelope when a signing key is given. A stable version skips beta when
 * beta-mac.yml in outDir already names a newer version. Resolves with the paths written.
 */
export async function makeFeed({
  version,
  zips,
  outDir,
  releaseDate = new Date().toISOString(),
  signingKey,
  minimumVersion = '0.0.0',
  validDays = 30,
  appId = RELEASE_APP_ID,
  readBundleInfo = readZipBundleInfo,
}) {
  const parsed = parseVersion(version)
  let channels = channelsForVersion(version)
  if (!Number.isSafeInteger(validDays) || validDays < 1 || validDays > MAX_VALID_DAYS) {
    throw new FeedError(`--valid-days is a whole number from 1 to ${MAX_VALID_DAYS}`)
  }
  const files = []
  for (const zip of zips) {
    checkBundle(zip, await readBundleInfo(zip), version, appId)
    files.push(await hashZip(zip))
  }
  const yaml = buildFeedYaml({ version, files, releaseDate })
  const expiresAt = new Date(Date.parse(releaseDate) + validDays * DAY_MS).toISOString()
  const envelopes = new Map()
  for (const channel of channels) {
    if (signingKey === undefined) break
    const envelope = buildEnvelope({
      channel,
      version,
      yml: yaml,
      minimumVersion,
      issuedAt: releaseDate,
      expiresAt,
    })
    envelopes.set(channel, { envelope, signature: signEnvelope(envelope, signingKey) })
  }
  const beta = await publishedVersion(join(outDir, 'beta-mac.yml'))
  if (parsed.prerelease.length === 0 && beta !== null && compareVersions(beta, parsed) > 0) {
    // An in-flight beta newer than this release stays on the beta channel.
    channels = channels.filter((channel) => channel !== 'beta')
  }
  await mkdir(outDir, { recursive: true })
  const written = []
  for (const channel of channels) {
    const path = join(outDir, `${channel}-mac.yml`)
    await writeFile(path, yaml)
    written.push(path)
    const signed = envelopes.get(channel)
    if (signed === undefined) continue
    await writeFile(`${path.slice(0, -'.yml'.length)}.envelope.json`, signed.envelope)
    await writeFile(`${path.slice(0, -'.yml'.length)}.envelope.json.sig`, signed.signature)
    written.push(
      `${path.slice(0, -'.yml'.length)}.envelope.json`,
      `${path.slice(0, -'.yml'.length)}.envelope.json.sig`,
    )
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
      'signing-key': { type: 'string' },
      'minimum-version': { type: 'string' },
      'valid-days': { type: 'string' },
      unsigned: { type: 'boolean', default: false },
    },
  })
  const signed = values['signing-key'] !== undefined
  if (values.version === undefined || positionals.length === 0 || signed === values.unsigned) {
    throw new FeedError(
      'usage: make-feed.mjs --version <semver> (--signing-key <pem> | --unsigned) [--minimum-version <semver>]' +
        ' [--valid-days <n>] [--release-date <iso>] [--out <dir>] <zip>...',
    )
  }
  const written = await makeFeed({
    version: values.version,
    zips: positionals.map((p) => resolve(p)),
    outDir: resolve(values.out ?? '.'),
    releaseDate: values['release-date'],
    signingKey: signed ? await readFile(resolve(values['signing-key']), 'utf8') : undefined,
    minimumVersion: values['minimum-version'],
    validDays: values['valid-days'] === undefined ? undefined : Number(values['valid-days']),
  })
  for (const path of written) process.stdout.write(`${path}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`make-feed: ${error instanceof FeedError ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
