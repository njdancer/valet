// Agents signing in through the Valet hub (docs/relay-hub.md, step 3), as this Mac takes part:
//
// - The hub sends every sign-in still waiting (`hub-consents`), each with the code the agent's
//   browser shows. They appear in the same "Approve a connection" sheet as the Mac's own, and the
//   person types the code from their browser, which picks the sign-in it belongs to.
// - Approving signs a grant (core's hub-grant.ts) with this Mac's approval key, after Touch ID, and
//   sends it to the hub. The grant covers the tools each Mac lets remote agents use, nothing wider.
// - The hub sends every grant the account holds (`hub-grants`). This Mac honours only those it
//   checks itself against the account's device list it verified (roster-keeper.ts); a grant the
//   hub stops sending is gone.

import {
  type HubGrant,
  hubGrantSchema,
  type MacToRelay,
  type RelayToMac,
  type Roster,
  SIGNING_DOMAINS,
  type SignedText,
  verifyHubGrant,
} from '@valet/core'
import type { ChannelKeys } from './signer'

/** How long an approval through the hub lasts before the person approves the agent again. */
export const HUB_GRANT_DAYS = 30

export interface HubConsent {
  readonly id: string
  readonly clientId: string
  readonly clientName: string
  readonly host: string
  readonly source: string
  /** What the agent's browser shows. Never shown on the Mac. */
  readonly code: string
  readonly expiresAt: number
  /** When this Mac first heard of it. */
  readonly seenAt: number
}

export interface HubAgentsOptions {
  readonly macId: string
  readonly channel: ChannelKeys
  /** The account's device list as this Mac verified it, or null while it has none. */
  readonly roster: () => Roster | null
  readonly send: (frame: Extract<MacToRelay, { type: 'hub-grant' | 'hub-consent-decline' }>) => boolean
  readonly now: () => number
  /** The waiting sign-ins changed. `opened`: one this Mac hadn't seen before arrived. */
  readonly onChange: (opened: boolean) => void
}

export class HubAgents {
  private waiting: HubConsent[] = []
  private held: readonly SignedText[] = []

  constructor(private readonly options: HubAgentsOptions) {}

  /** Sign-ins still waiting, oldest first. */
  consents(): HubConsent[] {
    const now = this.options.now()
    return this.waiting.filter((c) => c.expiresAt > now)
  }

  /** The hub's list of waiting sign-ins, whole. */
  received(consents: Extract<RelayToMac, { type: 'hub-consents' }>['consents']): void {
    const now = this.options.now()
    const before = new Map(this.waiting.map((c) => [c.id, c]))
    this.waiting = consents.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      clientName: c.clientName,
      host: c.host,
      source: c.source,
      code: c.code,
      expiresAt: Date.parse(c.expiresAt),
      seenAt: before.get(c.id)?.seenAt ?? now,
    }))
    const opened = this.waiting.some((c) => !before.has(c.id))
    const changed = opened || before.size !== this.waiting.length
    if (changed) this.options.onChange(opened)
  }

  /** The waiting sign-in a typed code belongs to, or null. */
  matching(code: string): HubConsent | null {
    const typed = code.toUpperCase().replace(/[\s-]/g, '')
    if (!/^[A-HJ-NP-Z]{8}$/.test(typed)) return null
    return this.consents().find((c) => c.code.replace('-', '') === typed) ?? null
  }

  /**
   * Signs the grant for this sign-in (Touch ID) and sends it. False if the person cancelled, the
   * Mac isn't on the account's list, or it isn't connected.
   */
  async approve(consent: HubConsent): Promise<boolean> {
    const roster = this.options.roster()
    if (roster === null) return false
    const at = this.options.now()
    const grant: HubGrant = hubGrantSchema.parse({
      v: 1,
      account: roster.account,
      consentId: consent.id,
      clientId: consent.clientId,
      clientName: consent.clientName,
      host: consent.host,
      scope: 'remote-tools',
      at: new Date(at).toISOString(),
      expiresAt: new Date(at + HUB_GRANT_DAYS * 24 * 60 * 60_000).toISOString(),
      by: this.options.macId,
    })
    const payload = JSON.stringify(grant)
    const signature = await this.options.channel
      .signApproval(
        SIGNING_DOMAINS.hubGrant,
        payload,
        `let an agent at ${consent.host} use your Valet tools through your Valet account`,
      )
      .catch(() => null)
    if (signature === null) return false
    if (!this.options.send({ type: 'hub-grant', grant: { payload, signature } })) return false
    // The hub's next list leaves it out; until then, nobody approves it twice.
    this.waiting = this.waiting.filter((c) => c.id !== consent.id)
    this.options.onChange(false)
    return true
  }

  decline(id: string): boolean {
    if (!this.waiting.some((c) => c.id === id)) return false
    this.options.send({ type: 'hub-consent-decline', consentId: id })
    this.waiting = this.waiting.filter((c) => c.id !== id)
    this.options.onChange(false)
    return true
  }

  declineAll(): number {
    const ids = this.waiting.map((c) => c.id)
    for (const id of ids) this.decline(id)
    return ids.length
  }

  /** The hub's grants, whole. Checked when used, against the list as it is then. */
  grantsReceived(grants: readonly SignedText[]): void {
    this.held = grants
  }

  /** Grants this Mac checked against the account's list: what it may serve agents through the hub for. */
  grants(): { readonly id: string; readonly grant: HubGrant }[] {
    const roster = this.options.roster()
    if (roster === null) return []
    const now = this.options.now()
    const out: { id: string; grant: HubGrant }[] = []
    for (const signed of this.held) {
      const check = verifyHubGrant(signed, roster, now)
      if (check.ok) out.push({ id: check.id, grant: check.grant })
    }
    return out
  }
}
