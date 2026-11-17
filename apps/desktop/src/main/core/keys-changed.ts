// When this Mac's approval keys change (the dev build's key file lost, a Secure Enclave key made
// again, a data folder restored onto another Mac), everything the old keys signed stops counting:
// its evidence names the old Mac id, so verifyDecision refuses it as `wrong-mac`. That is the safe
// outcome and it stays (docs/agent-run-security.md#devices-and-keys). What this module adds is the
// explanation: which stored approvals were signed by another key of this Mac, and so what the
// person has to do again. Nothing here makes anything count; it only reads.

import { type Evidence, MESSAGES_SECRET, parseRequestText } from '@valet/core'
import { z } from 'zod'
import type { KeysChangedItem } from '../../shared/api'
import { JsonDocument } from './files'

/** The notice's one id: there is only ever one. */
export const KEYS_CHANGED_ID = 'keys-changed'

/** What a Mac id other than this one signed, as stored evidence. */
export interface OldKeysSigned {
  /** Sites whose install the old keys approved, by adapter id. */
  readonly installs: ReadonlySet<string>
  /** Logins the old keys granted: adapter id to secret names. */
  readonly grants: ReadonlyMap<string, ReadonlySet<string>>
  /** Any other approval they signed: a setting turned on, remote access, a tool. */
  readonly others: number
}

/** Null when everything stored was signed for `macId` (or nothing is stored). */
export function signedByOldKeys(evidence: readonly Evidence[], macId: string): OldKeysSigned | null {
  const installs = new Set<string>()
  const grants = new Map<string, Set<string>>()
  let others = 0
  let any = false
  for (const e of evidence) {
    const parsed = parseRequestText(e.requestText)
    if (parsed === null || parsed.request.macId === macId) continue
    any = true
    const request = parsed.request
    if (request.kind === 'adapter-install') installs.add(request.subject.adapterId)
    else if (request.kind === 'secret-grant') {
      const secrets = grants.get(request.subject.adapterId) ?? new Set<string>()
      secrets.add(request.subject.secret)
      grants.set(request.subject.adapterId, secrets)
    } else others++
  }
  return any ? { installs, grants, others } : null
}

/** An installed site as it stands now, under this Mac's current keys. */
export interface SiteNow {
  readonly adapterId: string
  readonly adapterName: string
  /** The installed version is approved (by a signature that counts now). */
  readonly approved: boolean
  /** Secrets the installed version declares (MESSAGES_SECRET when it reads codes). */
  readonly declared: ReadonlySet<string>
  /** Secrets with a grant that counts now, for the installed version. */
  readonly granted: ReadonlySet<string>
}

/**
 * The Needs you notice, or null once nothing the old keys signed for an installed site is still to
 * do again. A site whose approval was never signed by the old keys isn't listed: it was new anyway.
 */
export function keysChangedItem(old: OldKeysSigned, sites: readonly SiteNow[]): KeysChangedItem | null {
  const listed: KeysChangedItem['sites'][number][] = []
  for (const site of sites) {
    const review = old.installs.has(site.adapterId) && !site.approved
    const logins = [...(old.grants.get(site.adapterId) ?? [])]
      .filter((s) => site.declared.has(s) && !site.granted.has(s))
      // The site's own logins first, its one-time codes last, as the site page lists them.
      .sort((a, b) => Number(a === MESSAGES_SECRET) - Number(b === MESSAGES_SECRET) || a.localeCompare(b))
    if (review || logins.length > 0)
      listed.push({ adapterId: site.adapterId, adapterName: site.adapterName, review, logins })
  }
  if (listed.length === 0) return null
  return { kind: 'keys-changed', id: KEYS_CHANGED_ID, sites: listed, others: old.others }
}

const noticeSchema = z.object({ dismissedFor: z.string().max(64).nullable() }).strict()
type Notice = z.infer<typeof noticeSchema>

/**
 * keys-notice.json: the Mac id the person dismissed the notice for. A later change of keys is a new
 * Mac id, so the notice comes back. A damaged file reads as not dismissed: the notice shows again.
 */
export class KeysNotice {
  private readonly document: JsonDocument<Notice>
  private dismissedFor: string | null = null

  constructor(path: string) {
    this.document = new JsonDocument<Notice>(path, noticeSchema, () => ({ dismissedFor: null }), true)
  }

  async load(): Promise<void> {
    this.dismissedFor = (await this.document.read()).dismissedFor
  }

  dismissed(macId: string): boolean {
    return this.dismissedFor === macId
  }

  async dismiss(macId: string): Promise<void> {
    this.dismissedFor = macId
    await this.document.update(() => ({ dismissedFor: macId }))
  }
}
