// Which adapter bundles the person has approved, keyed by exact content hash. Any change to an
// adapter makes a new hash, which starts unapproved. Reads fail closed: a file that can't be read
// or parsed approves nothing.

import { readFile } from 'node:fs/promises'
import { SiteAdapterError } from '@siteadapter/core'
import { z } from 'zod'
import { isErrno, writeFileAtomic } from './files'

/** The manifest's id rule, repeated here because ids become map keys and file names. */
export const ADAPTER_ID = /^[a-z][a-z0-9-]{1,63}$/
const HASH = /^[0-9a-f]{64}$/

const fileSchema = z
  .object({
    version: z.literal(1),
    approved: z.record(z.string().regex(ADAPTER_ID), z.array(z.string().regex(HASH))),
  })
  .strict()

export interface ApprovalLookup {
  isApproved(adapterId: string, adapterHash: string): Promise<boolean>
}

export class ApprovalStore implements ApprovalLookup {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async isApproved(adapterId: string, adapterHash: string): Promise<boolean> {
    try {
      const approved = await this.load()
      return approved.get(adapterId)?.includes(adapterHash) ?? false
    } catch {
      return false
    }
  }

  /** Every approved hash for one adapter. Throws if the file is unreadable. */
  async approvedHashes(adapterId: string): Promise<readonly string[]> {
    return (await this.load()).get(adapterId) ?? []
  }

  approve(adapterId: string, adapterHash: string): Promise<void> {
    return this.update(adapterId, adapterHash, (hashes) =>
      hashes.includes(adapterHash) ? hashes : [...hashes, adapterHash],
    )
  }

  revoke(adapterId: string, adapterHash: string): Promise<void> {
    return this.update(adapterId, adapterHash, (hashes) => hashes.filter((h) => h !== adapterHash))
  }

  private update(
    adapterId: string,
    adapterHash: string,
    change: (hashes: readonly string[]) => readonly string[],
  ): Promise<void> {
    if (!ADAPTER_ID.test(adapterId) || !HASH.test(adapterHash)) {
      return Promise.reject(new SiteAdapterError('manifest', 'invalid'))
    }
    const done = this.queue.then(async () => {
      // Throws on a corrupt file rather than overwriting approvals we couldn't read.
      const approved = await this.load()
      const next = change(approved.get(adapterId) ?? [])
      if (next.length === 0) approved.delete(adapterId)
      else approved.set(adapterId, next)
      const file = {
        version: 1,
        approved: Object.fromEntries([...approved].sort(([a], [b]) => a.localeCompare(b))),
      }
      await writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`)
    })
    this.queue = done.catch(() => undefined)
    return done
  }

  private async load(): Promise<Map<string, readonly string[]>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return new Map()
      throw new SiteAdapterError('manifest', 'unavailable')
    }
    let parsed: z.infer<typeof fileSchema>
    try {
      parsed = fileSchema.parse(JSON.parse(text))
    } catch {
      throw new SiteAdapterError('manifest', 'invalid')
    }
    return new Map(Object.entries(parsed.approved))
  }
}
