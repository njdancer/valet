// The Mac's part in the account's device list (docs/relay-hub.md, step 4; core's roster.ts).
//
// Once the Mac joins an account at the hub, the hub hands it the account's list of devices: a
// chain of changes, each signed by a device already on it. This keeps that list in step with the
// phones the Mac paired itself:
//
// - an empty list: the Mac starts it, adding itself and then each phone it already paired, all
//   under one Touch ID prompt, so nobody pairs again;
// - a phone paired here that isn't on the list is added, and a phone removed here is removed;
// - a phone of this Mac's that another device on the list removed is removed here too (that only
//   ever tightens).
//
// The Mac pins the list's first change, and only one it signed itself: a hub can't hand it a list
// some other key started. A list started elsewhere (another Mac's account) waits until a device on
// it adds this Mac (step 4c). Nothing here trusts a phone the Mac didn't pair: that comes with the
// phone's own sign-in (step 4c).

import {
  nextRosterChange,
  type Roster,
  type RosterChange,
  type RosterDevice,
  rosterChangeHash,
  rosterChangeSchema,
  SIGNING_DOMAINS,
  type SignedText,
  verifyRoster,
} from '@valet/core'
import type { DeviceStore } from './devices'
import type { TrustedLedger } from './ledger'
import type { ChannelKeys, MacKeys } from './signer'

/** What Settings › Devices shows about the account's device list. */
export type RosterState =
  /** Not on an account. */
  | 'off'
  /** On one, and the list is on its way (or a change is). */
  | 'waiting'
  /** This Mac and its phones are on the list. */
  | 'on'
  /** Touch ID was cancelled: nothing changes until the person tries again. */
  | 'needs-you'
  /** Another device started this account's list, and hasn't added this Mac. */
  | 'not-added'
  /** The list the hub sent doesn't check: nothing on it is used. */
  | 'refused'

export interface RosterView {
  readonly state: RosterState
  /** Devices on the list, when it checks. */
  readonly devices: number
}

export interface RosterKeeperOptions {
  readonly ledger: TrustedLedger
  readonly devices: DeviceStore
  readonly keys: MacKeys
  readonly channel: ChannelKeys
  readonly macName: string
  /** Sends changes to the hub; false when not connected. */
  readonly send: (changes: readonly SignedText[]) => boolean
  /** A phone of this Mac's that the device `by` removed from the list: revoke it here. */
  readonly removed: (deviceId: string, by: string) => Promise<void>
  readonly now: () => number
  readonly onChange: () => void
  readonly log?: (line: string) => void
}

/** The prompt's reason for a software signer; the Secure Enclave helper writes its own. */
const REASONS = {
  start: 'put this Mac and its iPhones on your Valet account',
  add: 'add an iPhone to your Valet account',
  remove: 'remove a device from your Valet account',
} as const

export class RosterKeeper {
  private account: string | null = null
  private chain: readonly SignedText[] | null = null
  private state: RosterState = 'off'
  private count = 0
  /** Set after a cancelled prompt: nothing is signed again until `retry`. */
  private declined = false
  /** Set after a change was refused as invalid, so a bad change isn't sent again and again. */
  private stuck = false
  private busy: Promise<void> = Promise.resolve()

  constructor(private readonly options: RosterKeeperOptions) {}

  get view(): RosterView {
    return { state: this.state, devices: this.count }
  }

  /** The hub's status said which account this Mac is on, or that it is on none. */
  async linked(accountId: string | null): Promise<void> {
    if (accountId === this.account) return
    this.account = accountId
    this.chain = null
    this.declined = false
    this.stuck = false
    this.set(accountId === null ? 'off' : 'waiting', 0)
    // Left the account: a later one starts its own pin.
    if (accountId === null && this.options.ledger.data.roster !== undefined)
      await this.options.ledger.commit((draft) => {
        delete draft.roster
      })
  }

  /** The account's whole list, from the hub. `refused`: the Mac's last change wasn't kept. */
  received(changes: readonly SignedText[], refused?: 'not-linked' | 'conflict' | 'invalid'): Promise<void> {
    return this.queue(async () => {
      if (this.account === null) return
      if (refused === 'invalid') {
        this.stuck = true
        this.options.log?.('[roster] the hub refused a change as invalid')
      }
      this.chain = changes
      await this.sync()
    })
  }

  /** A phone was paired or removed here: bring the list along. */
  changed(): Promise<void> {
    return this.queue(async () => {
      this.declined = false
      this.stuck = false
      await this.sync()
    })
  }

  /** After a cancelled prompt, from Settings. */
  retry(): Promise<void> {
    return this.changed()
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.busy.then(work, work)
    this.busy = next.catch(() => undefined)
    return next
  }

  private async sync(): Promise<void> {
    const account = this.account
    const chain = this.chain
    if (account === null || chain === null) return
    const ledger = this.options.ledger
    const macId = this.options.devices.macId
    const pin = ledger.data.roster?.account === account ? ledger.data.roster : undefined

    if (chain.length === 0) {
      // A list this Mac pinned can't go back to nothing.
      if (pin !== undefined) return this.refuse('the hub sent an empty list after this Mac started one')
      return this.sign(this.start(account), REASONS.start)
    }

    const check = verifyRoster(chain, {
      ...(pin === undefined ? {} : { pinned: pin.genesis, known: { seq: pin.seq, head: pin.head } }),
    })
    if (!check.ok) return this.refuse(`the hub's list doesn't check (${check.reason} at ${check.at})`)
    const roster = check.roster
    if (roster.account !== account) return this.refuse('the hub sent another account’s list')
    if (pin === undefined) {
      // Pin only a list this Mac started: its own first change, adding itself.
      if (firstSigner(chain) !== macId) return this.set('not-added', roster.devices.size)
    }
    if (pin === undefined || pin.seq !== roster.seq || pin.head !== roster.head)
      await ledger.commit((draft) => {
        draft.roster = { account, genesis: roster.genesis, seq: roster.seq, head: roster.head }
      })
    if (!roster.devices.has(macId)) return this.set('not-added', roster.devices.size)

    // Phones of this Mac's that another device took off the list.
    const removedBy = lastRemovals(chain)
    for (const phone of this.options.devices.activePhones()) {
      const by = removedBy.get(phone.deviceId)
      if (by !== undefined && !roster.devices.has(phone.deviceId) && by !== macId) {
        this.options.log?.(`[roster] ${phone.deviceId} was removed from the account`)
        await this.options.removed(phone.deviceId, by)
      }
    }

    const changes = this.pending(roster, removedBy)
    if (changes.length === 0) return this.set('on', roster.devices.size)
    const removing = changes.some((c) => c.op === 'remove')
    await this.sign(this.after(roster, changes), removing ? REASONS.remove : REASONS.add)
  }

  /** What the list lacks: phones paired here, and phones removed here that it still has. */
  private pending(roster: Roster, removedBy: ReadonlyMap<string, string>): RosterChange['change'][] {
    const devices = this.options.devices
    const changes: RosterChange['change'][] = []
    for (const phone of devices.activePhones())
      if (!roster.devices.has(phone.deviceId) && !removedBy.has(phone.deviceId))
        changes.push({ op: 'add', device: rosterDevice(phone) })
    for (const phone of devices.allPhones())
      if (devices.revokedAt(phone.deviceId) !== null && roster.devices.get(phone.deviceId)?.role === 'phone')
        changes.push({ op: 'remove', deviceId: phone.deviceId })
    // The hub takes at most this Mac's own phone limit in one go; the rest follow next time.
    return changes.slice(0, 5)
  }

  /** The first change, this Mac adding itself, then each phone it paired. */
  private start(account: string): string[] {
    const mac = this.options.devices.mac
    const self: RosterDevice = rosterDevice({ ...mac, name: this.options.macName })
    const phones = this.options.devices
      .activePhones()
      .slice(0, 5)
      .map((p) => ({ op: 'add' as const, device: rosterDevice(p) }))
    return this.payloads(null, account, [{ op: 'add', device: self }, ...phones])
  }

  private after(roster: Roster, changes: RosterChange['change'][]): string[] {
    return this.payloads(roster, roster.account, changes)
  }

  /** Payloads that follow one another: each names the hash of the one before. */
  private payloads(roster: Roster | null, account: string, changes: RosterChange['change'][]): string[] {
    const at = new Date(this.options.now()).toISOString()
    const macId = this.options.devices.macId
    const out: string[] = []
    let current = roster
    for (const change of changes) {
      const payload = nextRosterChange(current, account, macId, change, at)
      out.push(payload)
      current = {
        account,
        genesis: current?.genesis ?? '',
        head: rosterChangeHash({ payload, signature: '' }),
        seq: current === null ? 0 : current.seq + 1,
        devices: new Map(),
      }
    }
    return out
  }

  private async sign(payloads: string[], reason: string): Promise<void> {
    if (this.declined || this.stuck) return this.set(this.declined ? 'needs-you' : 'refused', this.count)
    this.set('waiting', this.count)
    const channel = this.options.channel
    const signatures =
      channel.signApprovals === undefined
        ? await signEach(channel, payloads, reason)
        : await channel.signApprovals(SIGNING_DOMAINS.rosterChange, payloads, reason).catch(() => null)
    if (signatures === null || signatures.length !== payloads.length) {
      this.declined = true
      return this.set('needs-you', this.count)
    }
    const changes = payloads.map((payload, i) => ({ payload, signature: signatures[i] as string }))
    // Not connected: the list comes again with the next connection, and this runs again.
    this.options.send(changes)
  }

  private refuse(why: string): void {
    this.options.log?.(`[roster] ${why}`)
    this.set('refused', 0)
  }

  private set(state: RosterState, count: number): void {
    if (state === this.state && count === this.count) return
    this.state = state
    this.count = count
    this.options.onChange()
  }
}

async function signEach(channel: ChannelKeys, payloads: string[], reason: string): Promise<string[] | null> {
  const out: string[] = []
  for (const payload of payloads) {
    const signature = await channel
      .signApproval(SIGNING_DOMAINS.rosterChange, payload, reason)
      .catch(() => null)
    if (signature === null) return null
    out.push(signature)
  }
  return out
}

function rosterDevice(d: {
  deviceId: string
  role: 'mac' | 'phone'
  platform: 'macos' | 'ios'
  name: string
  approvalKey: string
  transportKey: string
  agreementKey: string
}): RosterDevice {
  return {
    deviceId: d.deviceId,
    role: d.role,
    platform: d.platform,
    name: d.name.slice(0, 60),
    approvalKey: d.approvalKey,
    transportKey: d.transportKey,
    agreementKey: d.agreementKey,
  }
}

/** Who signed the first change, of a chain that already checks. */
function firstSigner(chain: readonly SignedText[]): string | null {
  const first = chain[0]
  return first === undefined ? null : (parse(first)?.by ?? null)
}

/** For each device whose last change on the list removed it: who removed it. */
function lastRemovals(chain: readonly SignedText[]): Map<string, string> {
  const removed = new Map<string, string>()
  for (const signed of chain) {
    const change = parse(signed)
    if (change === null) continue
    if (change.change.op === 'remove') removed.set(change.change.deviceId, change.by)
    else removed.delete(change.change.device.deviceId)
  }
  return removed
}

function parse(signed: SignedText): RosterChange | null {
  try {
    const result = rosterChangeSchema.safeParse(JSON.parse(signed.payload))
    return result.success ? result.data : null
  } catch {
    return null
  }
}
