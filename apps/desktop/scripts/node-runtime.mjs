// The Node runtime's binary (docs/node-runtime.md#shipping-the-binary): the official Node release for
// both architectures, checked against the SHA-256s pinned in build/node-runtime.json, joined into one
// universal binary, and signed separately from the app: its own identifier, the hardened runtime and
// the JIT entitlement only (build/entitlements.node.plist). It ships as Contents/MacOS/valet-node.
//
//   node scripts/node-runtime.mjs [--sign <identity>]   (default: ad hoc, "-")
//
// The release script calls buildNodeRuntime and signNodeRuntime itself, with its own identity.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const NODE_RUNTIME_PIN = join(APP_DIR, 'build', 'node-runtime.json')
export const NODE_RUNTIME_ENTITLEMENTS = join(APP_DIR, 'build', 'entitlements.node.plist')
/** Where the archives are kept between builds, by file name, and where the binary is built. */
export const NODE_RUNTIME_CACHE = join(APP_DIR, '.node-runtime', 'archives')
export const NODE_RUNTIME_OUT = join(APP_DIR, '.node-runtime', 'valet-node')
export const NODE_DIST = 'https://nodejs.org/dist/'
export const ARCHES = /** @type {const} */ (['arm64', 'x64'])

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SHA256 = /^[0-9a-f]{64}$/
const IDENTIFIER = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/

/**
 * The pin, checked: an exact release version, its own signing identifier, and for each architecture
 * the official archive's file name and SHA-256. Throws on anything else.
 * @param {string} text
 */
export function readPin(text) {
  const pin = JSON.parse(text)
  const keys = (o) =>
    Object.keys(o ?? {})
      .sort()
      .join(',')
  if (keys(pin) !== 'archives,identifier,version') throw new Error('node-runtime.json: unexpected keys')
  if (typeof pin.version !== 'string' || !VERSION.test(pin.version))
    throw new Error('node-runtime.json: version must be an exact release, like 24.22.2')
  if (typeof pin.identifier !== 'string' || !IDENTIFIER.test(pin.identifier))
    throw new Error('node-runtime.json: identifier must be a reverse-DNS signing identifier')
  if (keys(pin.archives) !== ARCHES.join(','))
    throw new Error('node-runtime.json: archives for arm64 and x64')
  for (const arch of ARCHES) {
    const archive = pin.archives[arch]
    if (keys(archive) !== 'file,sha256') throw new Error(`node-runtime.json: ${arch} needs file and sha256`)
    if (archive.file !== `node-v${pin.version}-darwin-${arch}.tar.gz`)
      throw new Error(`node-runtime.json: ${arch}'s file must be node-v${pin.version}-darwin-${arch}.tar.gz`)
    if (typeof archive.sha256 !== 'string' || !SHA256.test(archive.sha256))
      throw new Error(`node-runtime.json: ${arch}'s sha256 must be 64 lowercase hex digits`)
  }
  return pin
}

/** The official download for one architecture. */
export function archiveUrl(pin, arch) {
  return new URL(`v${pin.version}/${pin.archives[arch].file}`, NODE_DIST).href
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The archive for one architecture, from the cache when it is there and still matches, else
 * downloaded. Either way it is checked against the pinned SHA-256 before it is used or kept.
 */
export async function verifiedArchive(
  pin,
  arch,
  { cache = NODE_RUNTIME_CACHE, fetch = globalThis.fetch } = {},
) {
  const { file, sha256: expected } = pin.archives[arch]
  const cached = join(cache, file)
  if (existsSync(cached)) {
    if (sha256(readFileSync(cached)) === expected) return cached
    rmSync(cached, { force: true })
  }
  const response = await fetch(archiveUrl(pin, arch), { redirect: 'error' })
  if (!response.ok) throw new Error(`${file}: nodejs.org answered ${response.status}`)
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
export async function buildNodeRuntime({ out = NODE_RUNTIME_OUT, cache = NODE_RUNTIME_CACHE, fetch } = {}) {
  const pin = readPin(readFileSync(NODE_RUNTIME_PIN, 'utf8'))
  const work = mkdtempSync(join(tmpdir(), 'valet-node-runtime-'))
  try {
    const thin = []
    for (const arch of ARCHES) {
      const archive = await verifiedArchive(pin, arch, { cache, fetch })
      const member = `node-v${pin.version}-darwin-${arch}/bin/node`
      const dir = join(work, arch)
      mkdirSync(dir)
      run('/usr/bin/tar', ['-xzf', archive, '-C', dir, member])
      thin.push(join(dir, member))
    }
    mkdirSync(dirname(out), { recursive: true })
    run('/usr/bin/lipo', ['-create', ...thin, '-output', out])
    const archs = run('/usr/bin/lipo', ['-archs', out]).trim().split(/\s+/).sort()
    if (archs.join(' ') !== 'arm64 x86_64') throw new Error(`valet-node has ${archs.join(' ')}`)
    return { out, pin }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** The codesign arguments for the binary: its own identifier, hardened runtime, the JIT only. */
export function signArguments(pin, identity, file, { timestamp = identity !== '-' } = {}) {
  return [
    '--sign',
    identity,
    '--force',
    '--identifier',
    pin.identifier,
    '--options',
    'runtime',
    ...(timestamp ? ['--timestamp'] : []),
    '--entitlements',
    NODE_RUNTIME_ENTITLEMENTS,
    file,
  ]
}

export function signNodeRuntime(pin, identity, file = NODE_RUNTIME_OUT) {
  run('/usr/bin/codesign', signArguments(pin, identity, file))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { sign: { type: 'string', default: '-' } } })
  const { out, pin } = await buildNodeRuntime()
  signNodeRuntime(pin, values.sign ?? '-', out)
  console.log(
    `valet-node ${pin.version}, universal, signed ${values.sign === '-' ? 'ad hoc' : 'with the identity given'}: ${out}`,
  )
}
