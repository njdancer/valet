// npm tarballs, read as data (docs/node-runtime.md#dependencies): checked against their sha512
// integrity, gunzipped with a cap, and their tar entries read into memory. Nothing is written to
// disk, nothing is run, and only plain files come out: links, devices and anything with a path that
// climbs out of the package are dropped, and a native addon refuses the whole package.

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

export const TARBALL_LIMITS = {
  /** A tarball as downloaded. */
  compressedBytes: 20 * 1024 * 1024,
  /** Everything in it, unpacked. */
  unpackedBytes: 64 * 1024 * 1024,
  files: 5_000,
} as const

export class TarballError extends Error {
  constructor(
    readonly rule: 'integrity' | 'too-large' | 'malformed' | 'native-addon',
    readonly detail: string,
  ) {
    super(`tarball refused (${rule}): ${detail}`)
    this.name = 'TarballError'
  }
}

/** The sha512 integrity string npm uses for these bytes. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** Throws unless `bytes` hash to `integrity`. */
export function checkIntegrity(bytes: Uint8Array, integrity: string): void {
  if (integrityOf(bytes) !== integrity) throw new TarballError('integrity', 'the bytes don’t match')
}

/** A package's files: path inside the package (no leading `package/`) to bytes. */
export type TarballFiles = ReadonlyMap<string, Uint8Array>

const NATIVE = /(^|\/)binding\.gyp$|\.node$/i

function cleanPath(raw: string): string | null {
  // npm packs everything under one top folder, usually `package/`; drop it whatever its name.
  if (raw.startsWith('/')) return null
  const parts = raw.replace(/^\.\//, '').split('/')
  parts.shift()
  if (parts.length === 0) return null
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))
      return null
  }
  const path = parts.join('/')
  return path.normalize('NFC') === path && path.length <= 400 ? path : null
}

function field(block: Uint8Array, start: number, length: number): string {
  let end = start
  while (end < start + length && block[end] !== 0) end++
  return Buffer.from(block.subarray(start, end)).toString('utf8')
}

function octal(block: Uint8Array, start: number, length: number): number {
  const text = field(block, start, length).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new TarballError('malformed', 'a size field isn’t octal')
  return Number.parseInt(text, 8)
}

/** pax extended header records: `<length> <key>=<value>\n`. Only `path` matters here. */
function paxPath(data: Uint8Array): string | null {
  const text = Buffer.from(data).toString('utf8')
  let found: string | null = null
  let i = 0
  while (i < text.length) {
    const space = text.indexOf(' ', i)
    if (space === -1) break
    const length = Number(text.slice(i, space))
    if (!Number.isInteger(length) || length <= 0) break
    const record = text.slice(space + 1, i + length - 1)
    const eq = record.indexOf('=')
    if (eq !== -1 && record.slice(0, eq) === 'path') found = record.slice(eq + 1)
    i += length
  }
  return found
}

/**
 * Unpacks a tarball that has already passed its integrity check. Returns its plain files. Throws
 * TarballError when it is malformed, over a limit, or carries a native addon.
 */
export function unpackTarball(compressed: Uint8Array): Map<string, Uint8Array> {
  if (compressed.byteLength > TARBALL_LIMITS.compressedBytes)
    throw new TarballError('too-large', 'compressed')
  let tar: Buffer
  try {
    tar = gunzipSync(compressed, { maxOutputLength: TARBALL_LIMITS.unpackedBytes + 1024 * 1024 })
  } catch (error) {
    const code = (error as { code?: unknown }).code
    throw code === 'ERR_BUFFER_TOO_LARGE'
      ? new TarballError('too-large', 'unpacked')
      : new TarballError('malformed', 'not gzip')
  }
  const files = new Map<string, Uint8Array>()
  let total = 0
  let offset = 0
  let longName: string | null = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const prefix = field(header, 345, 155)
    const name = field(header, 0, 100)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new TarballError('malformed', 'an entry runs past the end')
    const data = tar.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (type === 'x') {
      longName = paxPath(data)
      continue
    }
    if (type === 'L') {
      longName = Buffer.from(data).toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'g') continue
    const raw = longName ?? (prefix === '' ? name : `${prefix}/${name}`)
    longName = null
    // Only plain files: no links (either kind), devices, FIFOs or folders.
    if (type !== '0' && type !== '\0' && type !== '7') continue
    const path = cleanPath(raw)
    if (path === null) continue
    if (NATIVE.test(path)) throw new TarballError('native-addon', path)
    total += size
    if (total > TARBALL_LIMITS.unpackedBytes) throw new TarballError('too-large', 'unpacked')
    if (files.size >= TARBALL_LIMITS.files) throw new TarballError('too-large', 'too many files')
    files.set(path, new Uint8Array(data))
  }
  if (!files.has('package.json')) throw new TarballError('malformed', 'no package.json')
  return files
}

/** The files a bundle can use, as text: JavaScript and JSON only. */
export function bundleableFiles(files: TarballFiles): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, bytes] of files) {
    if (/\.(?:c|m)?js$|\.json$/i.test(path)) out[path] = Buffer.from(bytes).toString('utf8')
  }
  return out
}
