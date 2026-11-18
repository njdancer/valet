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
// The Mac pins the list's first change. Normally only one it signed itself: a hub can't hand it a
// list some other key started. The one exception (step 4c): right after the person added this Mac
// to the account with the code it showed, it asks to join the account's list (its own device
// record, signed), and pins that list once a device on it, a phone, adds this Mac with exactly its
// keys. That is trust on first use, bounded by the person having just typed this Mac's code on the
// hub's page while signed in.
//
// Once on a list, the Mac trusts every phone on it for approvals, as if it had paired it
// (`onPhones`), and stops trusting one the moment the list drops it.

import {
  nextRosterChange,
  ROSTER_MAX_PASSKEYS,
  type Roster,
  type RosterChange,
  type RosterDevice,
  type RosterPasskey,
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
  /** This Mac asked to join the account's list: a phone on it adds it. */
  | 'joining'
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
  /** The phones on the verified list, each with when it was added: trusted here until dropped. */
  readonly onPhones?: (phones: readonly AccountPhone[]) => void
  /** Asks to join a list another device started; false when not connected. */
  readonly sendJoin?: (record: SignedText) => boolean
  readonly log?: (line: string) => void
}

export interface AccountPhone {
  readonly device: RosterDevice
  /** When the change that added it was made. */
  readonly addedAt: string
}

/** The prompt's reason for a software signer; the Secure Enclave helper writes its own. */
const REASONS = {
  start: 'put this Mac and its iPhones on your Valet account',
  join: 'join your Valet account',
  add: 'add an iPhone to your Valet account',
  remove: 'remove a device from your Valet account',
  addPasskey: 'let your passkey sign iPhones in to your Valet account',
  removePasskey: 'stop a passkey signing iPhones in to your Valet account',
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
  /** The list as last verified with this Mac on it; null otherwise. */
  private verified: Roster | null = null
  /** This Mac's own record, signed once per launch, for asking to join. */
  private joinRecord: SignedText | null = null
  /** The phones last handed to `onPhones`, by id, so an unchanged list says nothing. */
  private phonesKey = ''
  /** The account's passkeys as the hub last listed them; undefined from a hub that doesn't. */
  private hubPasskeys: readonly RosterPasskey[] | undefined

  constructor(private readonly options: RosterKeeperOptions) {}

  /** The account's list, checked here against the pin, while this Mac is on it. */
  get roster(): Roster | null {
    return this.verified
  }

  get view(): RosterView {
    return { state: this.state, devices: this.count }
  }

  /**
   * The hub's status said which account this Mac is on, or that it is on none. `fresh`: the Mac
   * was just added with a code it showed, so any list it pinned before belongs to an earlier time
   * on the account (it was removed while offline, or it lost its keys and came back new): the
   * account's current list decides, and a Mac never joins another's list without a signature.
   */
  linked(accountId: string | null, fresh = false): Promise<void> {
    // In turn with the lists the hub sends: the list right after a status belongs to it.
    return this.queue(() => this.link(accountId, fresh))
  }

  private async link(accountId: string | null, fresh: boolean): Promise<void> {
    if (fresh && accountId !== null) {
      if (this.options.ledger.data.roster !== undefined)
        this.options.log?.('[roster] added to the account again: forgetting the list pinned before')
      const at = new Date(this.options.now()).toISOString()
      await this.options.ledger.commit((draft) => {
        delete draft.roster
        draft.rosterJoin = { account: accountId, at }
      })
      this.account = null
    }
    if (accountId === this.account) return
    this.account = accountId
    this.chain = null
    this.verified = null
    this.declined = false
    this.stuck = false
    this.set(accountId === null ? 'off' : 'waiting', 0)
    if (accountId === null) this.phones(null)
    // Left the account: a later one starts its own pin.
    const data = this.options.ledger.data
    if (accountId === null && (data.roster !== undefined || data.rosterJoin !== undefined))
      await this.options.ledger.commit((draft) => {
        delete draft.roster
        delete draft.rosterJoin
      })
  }

  /** The account's whole list, from the hub. `refused`: the Mac's last change wasn't kept. */
  received(
    changes: readonly SignedText[],
    refused?: 'not-linked' | 'conflict' | 'invalid',
    passkeys?: readonly RosterPasskey[],
  ): Promise<void> {
    return this.queue(async () => {
      if (this.account === null) return
      this.hubPasskeys = passkeys
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
    const joining = ledger.data.rosterJoin?.account === account
    if (pin === undefined && firstSigner(chain) !== macId) {
      // A list another device started: pin it only once it lists this Mac with exactly its keys,
      // and only while the person's fresh link lets this Mac join (trust on first use).
      const listed = roster.devices.get(macId)
      if (!joining || listed === undefined) {
        this.verified = null
        this.phones(null)
        if (!joining) return this.set('not-added', roster.devices.size)
        return this.askToJoin(roster)
      }
      const own = this.options.devices.mac
      if (listed.transportKey !== own.transportKey || listed.agreementKey !== own.agreementKey)
        return this.refuse('the list adds this Mac with keys that aren’t its own')
      this.options.log?.('[roster] a device on the account added this Mac: pinning its list')
    }
    if (pin === undefined || pin.seq !== roster.seq || pin.head !== roster.head || joining)
      await ledger.commit((draft) => {
        draft.roster = { account, genesis: roster.genesis, seq: roster.seq, head: roster.head }
        delete draft.rosterJoin
      })
    if (!roster.devices.has(macId)) {
      this.verified = null
      this.phones(null)
      return this.set('not-added', roster.devices.size)
    }
    this.verified = roster
    this.phones(roster, chain)

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
    await this.sign(this.after(roster, changes), reasonFor(changes))
  }

  /**
   * Sends this Mac's own record to the hub, for a phone on the list to add. Only a list with a
   * phone on it can take a new Mac: a Mac never adds another Mac.
   */
  private async askToJoin(roster: Roster): Promise<void> {
    const hasPhone = [...roster.devices.values()].some((d) => d.role === 'phone')
    if (!hasPhone || this.options.sendJoin === undefined) return this.set('not-added', roster.devices.size)
    if (this.joinRecord === null) {
      if (this.declined) return this.set('needs-you', roster.devices.size)
      const mac = this.options.devices.mac
      const payload = JSON.stringify({
        ...mac,
        name: this.options.macName.slice(0, 60),
        pairedAt: new Date(this.options.now()).toISOString(),
      })
      const signature = await this.options.channel
        .signApproval(SIGNING_DOMAINS.deviceRecord, payload, REASONS.join)
        .catch(() => null)
      if (signature === null) {
        this.declined = true
        return this.set('needs-you', roster.devices.size)
      }
      this.joinRecord = { payload, signature }
    }
    this.options.sendJoin(this.joinRecord)
    this.set('joining', roster.devices.size)
  }

  /** Hands on the phones of a verified list (or none), when they changed. */
  private phones(roster: Roster | null, chain: readonly SignedText[] = []): void {
    const addedAt = new Map<string, string>()
    for (const signed of chain) {
      const change = parse(signed)
      if (change?.change.op === 'add') addedAt.set(change.change.device.deviceId, change.at)
    }
    const phones: AccountPhone[] =
      roster === null
        ? []
        : [...roster.devices.values()]
            .filter((d) => d.role === 'phone')
            .map((device) => ({ device, addedAt: addedAt.get(device.deviceId) ?? new Date(0).toISOString() }))
    const key = phones.map((p) => `${p.device.deviceId}:${p.device.name}`).join(',')
    if (key === this.phonesKey) return
    this.phonesKey = key
    this.options.onPhones?.(phones)
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
    // The account's passkeys, so its iPhones can sign in with them (step 4d), and no others.
    if (this.hubPasskeys !== undefined) {
      const atHub = new Set(this.hubPasskeys.map((p) => p.passkeyId))
      for (const passkey of roster.passkeys.values())
        if (!atHub.has(passkey.passkeyId))
          changes.push({ op: 'remove-passkey', passkeyId: passkey.passkeyId })
      let room = ROSTER_MAX_PASSKEYS - roster.passkeys.size
      for (const passkey of this.hubPasskeys)
        if (room > 0 && !roster.passkeys.has(passkey.passkeyId) && !roster.devices.has(passkey.passkeyId)) {
          changes.push({ op: 'add-passkey', passkey })
          room--
        }
    }
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
    // The hub takes six changes in one go: passkeys that don't fit follow with the next list.
    const passkeys = (this.hubPasskeys ?? [])
      .slice(0, Math.max(0, 5 - phones.length))
      .map((passkey) => ({ op: 'add-passkey' as const, passkey }))
    return this.payloads(null, account, [{ op: 'add', device: self }, ...phones, ...passkeys])
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
        passkeys: new Map(),
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
    this.verified = null
    this.phones(null)
    this.options.log?.(`[roster] ${why}`)
    this.set('refused', 0)
  }

  private set(state: RosterState, count: number): void {
    if (state === this.state && count === this.count) return
    if (state !== this.state) this.options.log?.(`[roster] ${state}, ${count} devices`)
    this.state = state
    this.count = count
    this.options.onChange()
  }
}

function reasonFor(changes: readonly RosterChange['change'][]): string {
  if (changes.some((c) => c.op === 'remove')) return REASONS.remove
  if (changes.some((c) => c.op === 'add')) return REASONS.add
  if (changes.some((c) => c.op === 'add-passkey')) return REASONS.addPasskey
  return REASONS.removePasskey
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
    else if (change.change.op === 'add') removed.delete(change.change.device.deviceId)
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
