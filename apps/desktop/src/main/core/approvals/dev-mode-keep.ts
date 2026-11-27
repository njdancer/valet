// Where developer mode's key waits across a restart (dev-mode.ts, docs/approval-broker.md#developer-mode).
// Only an unpackaged build has developer mode, so only it keeps one: in the Keychain when the dev
// build has its Keychain helper, otherwise in a file (mode 0600) in its data folder, next to the dev
// build's own software approval keys. Either way any process running as the person can read it in a
// dev build, the same as those keys; what it can approve is only what developer mode approves, and
// only until its 8 hours end, since the ledger's record says nothing past that.

import { readFile, rm } from 'node:fs/promises'
import { CredentialError } from '@valet/core'
import type { KeychainStore } from '@valet/credentials'
import { z } from 'zod'
import type { DevModeKeep, KeptDevMode } from './dev-mode'
import { softwareKeysSchema, writeAtomic } from './mac-keys'

/** The dev build's Keychain service for it (the helper takes only `valet.` services). */
export const DEV_MODE_SERVICE = 'valet.dev.developer-mode'
const ACCOUNT = 'key'

const keptSchema = z
  .object({
    keys: softwareKeysSchema,
    deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    until: z.string().datetime(),
  })
  .strict()

/** What was kept, or null when it is missing or damaged (then nothing resumes). */
function parse(text: string): KeptDevMode | null {
  try {
    const parsed = keptSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function keychainDevModeKeep(
  keychain: KeychainStore,
  service: string = DEV_MODE_SERVICE,
): DevModeKeep {
  return {
    async read() {
      try {
        const secret = await keychain.read(service, ACCOUNT)
        try {
          return parse(secret.reveal((plaintext) => plaintext))
        } finally {
          secret.dispose()
        }
      } catch (error) {
        if (error instanceof CredentialError && error.failure === 'not-found') return null
        throw error
      }
    },
    async write(kept) {
      await keychain.write(
        service,
        ACCOUNT,
        Buffer.from(JSON.stringify(keptSchema.parse(kept)), 'utf8'),
        'Valet developer mode (dev build)',
      )
    },
    async clear() {
      try {
        await keychain.delete(service, ACCOUNT)
      } catch (error) {
        if (error instanceof CredentialError && error.failure === 'not-found') return
        throw error
      }
    },
  }
}

export function fileDevModeKeep(path: string): DevModeKeep {
  return {
    async read() {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      return parse(text)
    },
    async write(kept) {
      await writeAtomic(path, JSON.stringify(keptSchema.parse(kept)))
    },
    async clear() {
      await rm(path, { force: true })
    },
  }
}
