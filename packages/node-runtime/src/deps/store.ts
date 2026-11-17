// Where npm tarballs are kept (docs/node-runtime.md#dependencies): one file per tarball, named by
// its integrity, in a folder of Valet's own. A tarball is checked against its integrity every time
// it is read, so a file changed on disk is refused, never used.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SHA512_INTEGRITY } from '@valet/core'
import { checkIntegrity, TarballError } from './tarball'

export interface TarballStore {
  /** The tarball with this integrity, checked, or null if the store doesn't have it (or it changed). */
  get(integrity: string): Promise<Uint8Array | null>
  /** Keeps a tarball. Throws TarballError if it doesn't match `integrity`. */
  put(integrity: string, bytes: Uint8Array): Promise<void>
}

function fileName(integrity: string): string {
  if (!SHA512_INTEGRITY.test(integrity)) throw new TarballError('integrity', 'not a sha512 integrity')
  return `${Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')}.tgz`
}

export function diskTarballStore(folder: string): TarballStore {
  return {
    async get(integrity) {
      const bytes = await readFile(join(folder, fileName(integrity))).catch(() => null)
      if (bytes === null) return null
      try {
        checkIntegrity(bytes, integrity)
      } catch {
        return null
      }
      return new Uint8Array(bytes)
    },
    async put(integrity, bytes) {
      checkIntegrity(bytes, integrity)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const target = join(folder, fileName(integrity))
      const temp = `${target}.${randomBytes(6).toString('hex')}.partial`
      try {
        await writeFile(temp, bytes, { mode: 0o600 })
        await rename(temp, target)
      } catch (error) {
        await rm(temp, { force: true })
        throw error
      }
    },
  }
}

/** A store in memory, for tests and one-off checks. */
export function memoryTarballStore(): TarballStore & { readonly size: number } {
  const kept = new Map<string, Uint8Array>()
  return {
    async get(integrity) {
      const bytes = kept.get(integrity)
      return bytes === undefined ? null : new Uint8Array(bytes)
    },
    async put(integrity, bytes) {
      checkIntegrity(bytes, integrity)
      kept.set(integrity, new Uint8Array(bytes))
    },
    get size() {
      return kept.size
    },
  }
}
