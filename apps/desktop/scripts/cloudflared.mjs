// Cloudflare's connector for "My Cloudflare account" (docs/cloudflare-tunnel.md): the official
// cloudflared release for both architectures, checked against the SHA-256s pinned in
// build/cloudflared.json, joined into one universal binary and signed on its own: its own
// identifier, the hardened runtime and no entitlements. It ships as Contents/MacOS/cloudflared.
//
//   node scripts/cloudflared.mjs [--sign <identity>]   (default: ad hoc, "-")
//
// The release script calls buildCloudflared and signCloudflared itself, with its own identity.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { sha256 } from './node-runtime.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const CLOUDFLARED_PIN = join(APP_DIR, 'build', 'cloudflared.json')
export const CLOUDFLARED_CACHE = join(APP_DIR, '.cloudflared', 'archives')
export const CLOUDFLARED_OUT = join(APP_DIR, '.cloudflared', 'cloudflared')
export const CLOUDFLARED_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/download/'
const ARCH_NAMES = /** @type {const} */ ({ arm64: 'arm64', x64: 'amd64' })

const VERSION = /^20\d\d\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/
const SHA256 = /^[0-9a-f]{64}$/
const IDENTIFIER = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/

/**
 * The pin, checked: an exact release (cloudflared's are year.month.patch), its own signing
 * identifier, and for each architecture the official archive's file name and SHA-256.
 * @param {string} text
 */
export function readCloudflaredPin(text) {
  const pin = JSON.parse(text)
  const keys = (o) =>
    Object.keys(o ?? {})
      .sort()
      .join(',')
  if (keys(pin) !== 'archives,identifier,version') throw new Error('cloudflared.json: unexpected keys')
  if (typeof pin.version !== 'string' || !VERSION.test(pin.version))
    throw new Error('cloudflared.json: version must be an exact release, like 2026.10.7')
  if (typeof pin.identifier !== 'string' || !IDENTIFIER.test(pin.identifier))
    throw new Error('cloudflared.json: identifier must be a reverse-DNS signing identifier')
  if (keys(pin.archives) !== 'arm64,x64') throw new Error('cloudflared.json: archives for arm64 and x64')
  for (const [arch, name] of Object.entries(ARCH_NAMES)) {
    const archive = pin.archives[arch]
    if (keys(archive) !== 'file,sha256') throw new Error(`cloudflared.json: ${arch} needs file and sha256`)
    if (archive.file !== `cloudflared-darwin-${name}.tgz`)
      throw new Error(`cloudflared.json: ${arch}'s file must be cloudflared-darwin-${name}.tgz`)
    if (typeof archive.sha256 !== 'string' || !SHA256.test(archive.sha256))
      throw new Error(`cloudflared.json: ${arch}'s sha256 must be 64 lowercase hex digits`)
  }
  return pin
}

export function cloudflaredUrl(pin, arch) {
  return new URL(`${pin.version}/${pin.archives[arch].file}`, CLOUDFLARED_RELEASES).href
}

/** The archive, from the cache when it still matches, else downloaded; checked either way. */
export async function verifiedCloudflared(
  pin,
  arch,
  { cache = CLOUDFLARED_CACHE, fetch = globalThis.fetch } = {},
) {
  const { file, sha256: expected } = pin.archives[arch]
  const cached = join(cache, `${pin.version}-${file}`)
  if (existsSync(cached)) {
    if (sha256(readFileSync(cached)) === expected) return cached
    rmSync(cached, { force: true })
  }
  // GitHub sends release downloads on to its storage host, so redirects are followed here; the
  // pinned SHA-256 is what is trusted, not where the bytes came from.
  const response = await fetch(cloudflaredUrl(pin, arch))
  if (!response.ok) throw new Error(`${file}: GitHub answered ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== expected) throw new Error(`${file}: SHA-256 ${actual} isn't the pinned ${expected}`)
  mkdirSync(cache, { recursive: true })
  const partial = `${cached}.partial`
  writeFileSync(partial, bytes)
  renameSync(partial, cached)
  return cached
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return result.stdout
}

/** Builds the universal binary from both verified archives. macOS only (lipo). */
export async function buildCloudflared({ out = CLOUDFLARED_OUT, cache = CLOUDFLARED_CACHE, fetch } = {}) {
  const pin = readCloudflaredPin(readFileSync(CLOUDFLARED_PIN, 'utf8'))
  const work = mkdtempSync(join(tmpdir(), 'valet-cloudflared-'))
  try {
    const thin = []
    for (const arch of Object.keys(ARCH_NAMES)) {
      const archive = await verifiedCloudflared(pin, arch, { cache, fetch })
      const dir = join(work, arch)
      mkdirSync(dir)
      run('/usr/bin/tar', ['-xzf', archive, '-C', dir, 'cloudflared'])
      thin.push(join(dir, 'cloudflared'))
    }
    mkdirSync(dirname(out), { recursive: true })
    run('/usr/bin/lipo', ['-create', ...thin, '-output', out])
    const archs = run('/usr/bin/lipo', ['-archs', out]).trim().split(/\s+/).sort()
    if (archs.join(' ') !== 'arm64 x86_64') throw new Error(`cloudflared has ${archs.join(' ')}`)
    return { out, pin }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** The codesign arguments: its own identifier, the hardened runtime, no entitlements. */
export function cloudflaredSignArguments(pin, identity, file, { timestamp = identity !== '-' } = {}) {
  return [
    '--sign',
    identity,
    '--force',
    '--identifier',
    pin.identifier,
    '--options',
    'runtime',
    ...(timestamp ? ['--timestamp'] : []),
    file,
  ]
}

export function signCloudflared(pin, identity, file = CLOUDFLARED_OUT) {
  run('/usr/bin/codesign', cloudflaredSignArguments(pin, identity, file))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { sign: { type: 'string', default: '-' } } })
  const { out, pin } = await buildCloudflared()
  signCloudflared(pin, values.sign ?? '-', out)
  console.log(
    `cloudflared ${pin.version}, universal, signed ${values.sign === '-' ? 'ad hoc' : 'with the identity given'}: ${out}`,
  )
}
