// Content hashing for adapters and the audit chain. Canonical JSON sorts object keys so that the
// same value always hashes the same.

import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Hashes an adapter bundle: a map from relative file path to contents. Paths are sorted, and each
 * entry is length-prefixed so that no two different bundles produce the same byte stream.
 */
export function bundleHash(files: Readonly<Record<string, string | Uint8Array>>): string {
  const hash = createHash('sha256')
  for (const path of Object.keys(files).sort()) {
    const contents = files[path] ?? ''
    const body = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : Buffer.from(contents)
    const name = Buffer.from(path, 'utf8')
    hash.update(`${name.length}:`).update(name).update(`${body.length}:`).update(body)
  }
  return hash.digest('hex')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}
