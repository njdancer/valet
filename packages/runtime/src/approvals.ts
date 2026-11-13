// Which adapter bundle the person has approved, keyed by exact content hash. Any change to an
// adapter makes a new hash, which starts unapproved; approving it replaces the adapter's previous
// approval. Reads fail closed: a file that can't be read or parsed approves nothing.
//
// The store writes the adapter-approved and adapter-rejected audit events itself, so no caller can
// change an approval without a record. The event is written first: an approval that can't be
// audited doesn't happen, and if the file write then fails, the log over-reports rather than
// under-reports.

import { readFile } from 'node:fs/promises'
import { type AuditSink, ValetError } from '@valet/core'
import { z } from 'zod'
import { isErrno, writeFileAtomic } from './files'

/** The manifest's id rule, repeated here because ids become map keys and file names. */
export const ADAPTER_ID = /^[a-z][a-z0-9-]{1,63}$/
const HASH = /^[0-9a-f]{64}$/
/** The manifest's version rule. */
const VERSION = /^\d+\.\d+\.\d+$/

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

  constructor(
    private readonly path: string,
    private readonly audit: AuditSink,
  ) {}

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

  /**
   * Approves exactly this bundle of the adapter, replacing any earlier approval, and audits
   * adapter-approved with the hash it replaces. Approving the one hash already approved is a no-op.
   */
  approve(adapterId: string, adapterHash: string, version: string): Promise<void> {
    return this.update(adapterId, adapterHash, version, async (hashes) => {
      if (hashes.length === 1 && hashes[0] === adapterHash) return null
      const previousHash = hashes.filter((h) => h !== adapterHash).at(-1) ?? null
      await this.audit.append({ type: 'adapter-approved', adapterId, adapterHash, version, previousHash })
      return [adapterHash]
    })
  }

  /**
   * Records that the person rejected this bundle, and withdraws its approval if it had one. Other
   * hashes' approvals are untouched: rejecting an update leaves the installed version running.
   */
  reject(adapterId: string, adapterHash: string, version: string): Promise<void> {
    return this.update(adapterId, adapterHash, version, async (hashes) => {
      await this.audit.append({ type: 'adapter-rejected', adapterId, adapterHash, version })
      return hashes.includes(adapterHash) ? hashes.filter((h) => h !== adapterHash) : null
    })
  }

  /** Drops every approval of an adapter (the site was removed; the caller audits that). */
  forget(adapterId: string): Promise<void> {
    if (!ADAPTER_ID.test(adapterId)) return Promise.reject(new ValetError('manifest', 'invalid'))
    const done = this.queue.then(async () => {
      const approved = await this.load()
      if (!approved.delete(adapterId)) return
      const file = {
        version: 1,
        approved: Object.fromEntries([...approved].sort(([a], [b]) => a.localeCompare(b))),
      }
      await writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`)
    })
    this.queue = done.catch(() => undefined)
    return done
  }

  /** `change` returns the adapter's new hashes, or null to leave the file alone. */
  private update(
    adapterId: string,
    adapterHash: string,
    version: string,
    change: (hashes: readonly string[]) => Promise<readonly string[] | null>,
  ): Promise<void> {
    if (!ADAPTER_ID.test(adapterId) || !HASH.test(adapterHash) || !VERSION.test(version)) {
      return Promise.reject(new ValetError('manifest', 'invalid'))
    }
    const done = this.queue.then(async () => {
      // Throws on a corrupt file rather than overwriting approvals we couldn't read.
      const approved = await this.load()
      const next = await change(approved.get(adapterId) ?? [])
      if (next === null) return
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
      throw new ValetError('config', 'unavailable')
    }
    let parsed: z.infer<typeof fileSchema>
    try {
      parsed = fileSchema.parse(JSON.parse(text))
    } catch {
      throw new ValetError('config', 'invalid')
    }
    return new Map(Object.entries(parsed.approved))
  }
}
