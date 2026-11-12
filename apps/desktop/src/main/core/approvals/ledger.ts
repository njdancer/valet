// The trusted ledger (docs/approval-broker.md#the-ledger): one anchored file holding everything the
// approval broker must be able to trust after a restart. Pending requests, the evidence that backs
// every widening record, paired phones and their revocations, the safety switches, and the decline
// window behind the fatigue limits.
//
// Approving is one write that removes the pending request and adds its evidence, so no crash can
// leave both or neither. A file that doesn't match its anchor is never read: the ledger opens empty
// and locked down, and nothing it held is honoured until the person starts again at the Mac.

import {
  type AnchorCheck,
  canonicalJson,
  clientIdSchema,
  deviceRevocationSchema,
  evidenceSchema,
  signedTextSchema,
} from '@valet/core'
import { z } from 'zod'
import type { AnchoredFile } from './anchored-file'

/** Generous caps: a bigger file is refused as malformed rather than read. */
const MAX_PENDING = 100
const MAX_EVIDENCE = 10_000

export const ledgerSchema = z
  .object({
    v: z.literal(1),
    /** Phones' records, each signed by the Mac's approval key. The Mac's own isn't stored. */
    devices: z.array(signedTextSchema).max(32),
    revocations: z.array(deviceRevocationSchema).max(256),
    /** Requests as the Mac serialised them, still waiting for an answer. */
    pending: z.array(z.object({ requestText: z.string().max(64 * 1024) }).strict()).max(MAX_PENDING),
    evidence: z.array(evidenceSchema).max(MAX_EVIDENCE),
    safety: z.object({ lockdown: z.boolean(), pausedRemote: z.boolean() }).strict(),
    /** Declines of agents' requests within the fatigue window. */
    declines: z.array(z.object({ clientId: clientIdSchema, at: z.iso.datetime() }).strict()).max(1000),
    /** Requests agents made in the last day, whatever became of them (the daily cap). */
    asks: z.array(z.object({ clientId: clientIdSchema, at: z.iso.datetime() }).strict()).max(5000),
  })
  .strict()
export type LedgerData = z.infer<typeof ledgerSchema>

export function emptyLedger(lockdown = false): LedgerData {
  return {
    v: 1,
    devices: [],
    revocations: [],
    pending: [],
    evidence: [],
    safety: { lockdown, pausedRemote: false },
    declines: [],
    asks: [],
  }
}

/** Why the ledger opened locked down, if it did. */
export type LedgerTamper = Extract<AnchorCheck, 'interrupted' | 'mismatch'> | 'malformed' | 'unreadable'

export class TrustedLedger {
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly file: AnchoredFile,
    private current: LedgerData,
    /** Set when the file couldn't be trusted. Cleared only by `reset`. */
    private tamperedBy: LedgerTamper | null,
  ) {}

  static async open(file: AnchoredFile): Promise<TrustedLedger> {
    let loaded: Awaited<ReturnType<AnchoredFile['load']>>
    try {
      loaded = await file.load()
    } catch {
      // The Keychain or the disk couldn't be read: never a fresh start, which would clear lockdown
      // and revocations. Locked down until the person resumes at the Mac.
      return new TrustedLedger(file, emptyLedger(true), 'unreadable')
    }
    if (loaded.check === 'fresh') return new TrustedLedger(file, emptyLedger(), null)
    if (loaded.check === 'mismatch') return new TrustedLedger(file, emptyLedger(true), 'mismatch')
    const parsed = parse(loaded.text)
    if (loaded.check === 'interrupted') {
      // The committed file, which the anchor vouches for, with a write begun and lost: it may have
      // been a revocation. Keep what was committed, lock down, and have the person repeat it (B).
      return new TrustedLedger(
        file,
        parsed === null ? emptyLedger(true) : { ...parsed, safety: { ...parsed.safety, lockdown: true } },
        'interrupted',
      )
    }
    if (parsed === null) return new TrustedLedger(file, emptyLedger(true), 'malformed')
    return new TrustedLedger(file, parsed, null)
  }

  get data(): LedgerData {
    return this.current
  }

  /** Why the file wasn't trusted at open, or null. While set, nothing is written. */
  get tampered(): LedgerTamper | null {
    return this.tamperedBy
  }

  /**
   * Applies `change` to a copy and writes it; the new state takes effect only once written.
   * `tightening` changes (a revocation, lockdown, withdrawing requests) take effect in memory even
   * if the write fails, so a failed write never loosens, and the error is still thrown.
   * While the ledger is tampered, changes stay in memory only: writing would move the anchor past
   * the evidence of tampering.
   */
  commit(change: (draft: LedgerData) => void, options: { tightening?: boolean } = {}): Promise<void> {
    const done = this.queue.then(async () => {
      const next = structuredClone(this.current)
      change(next)
      const valid = ledgerSchema.parse(next)
      if (this.tamperedBy !== null) {
        this.current = valid
        return
      }
      try {
        await this.file.write(serialize(valid))
      } catch (error) {
        if (options.tightening === true) this.current = valid
        throw error
      }
      this.current = valid
    })
    this.queue = done.catch(() => undefined)
    return done
  }

  /**
   * Starts again after tampering, once the person resumed at the Mac: writes `data` as a fresh
   * ledger and clears the tampered state.
   */
  reset(data: LedgerData): Promise<void> {
    const done = this.queue.then(async () => {
      const valid = ledgerSchema.parse(data)
      await this.file.reset(serialize(valid))
      this.current = valid
      this.tamperedBy = null
    })
    this.queue = done.catch(() => undefined)
    return done
  }
}

function serialize(data: LedgerData): string {
  return `${canonicalJson(data)}\n`
}

function parse(text: string | null): LedgerData | null {
  if (text === null) return null
  try {
    const result = ledgerSchema.safeParse(JSON.parse(text))
    return result.success ? result.data : null
  } catch {
    return null
  }
}
