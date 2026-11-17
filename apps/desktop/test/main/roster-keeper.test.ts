// @vitest-environment node

// The Mac's part in the account's device list (approvals/roster-keeper.ts): it starts the list
// with itself and the phones it paired, keeps it in step as phones come and go, follows removals
// made by other devices, and refuses a list that a hub swapped, rolled back or started elsewhere.
// The hub here is an array that keeps a change only if core's verifyRoster still passes.

import { generateKeyPairSync, sign } from 'node:crypto'
import {
  joinRecordDevice,
  keyId,
  nextRosterChange,
  type RosterDevice,
  SIGNING_DOMAINS,
  type SignedText,
  signingInput,
  verifyRoster,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  type AccountPhone,
  AnchoredFile,
  type ChannelKeys,
  DeviceStore,
  type FileOps,
  MemoryAnchor,
  RosterKeeper,
  SoftwareSigner,
  TrustedLedger,
} from '../../src/main/core/approvals'

const ACCOUNT = 'acct_0123456789abcdef'
const T0 = Date.parse('2026-11-16T00:00:00.000Z')

class MemoryFiles implements FileOps {
  readonly files = new Map<string, string>()
  async read(path: string) {
    return this.files.get(path) ?? null
  }
  async write(path: string, text: string) {
    this.files.set(path, text)
  }
}

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
}

/** A phone: its keys, and its approval key's signature over a roster change. */
function phone(name: string) {
  const approval = p256()
  const transport = p256()
  const agreement = p256()
  return {
    deviceId: keyId(approval.spki),
    name,
    approval,
    transport,
    agreement,
    signRoster: (payload: string): SignedText => ({
      payload,
      signature: sign('sha256', signingInput(SIGNING_DOMAINS.rosterChange, payload), {
        key: approval.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
    }),
  }
}
type Phone = ReturnType<typeof phone>

function phoneDevice(p: Phone): RosterDevice {
  return {
    deviceId: p.deviceId,
    role: 'phone',
    platform: 'ios',
    name: p.name,
    approvalKey: p.approval.spki,
    transportKey: p.transport.spki,
    agreementKey: p.agreement.spki,
  }
}

/** A list a phone started, with itself on it. */
function phoneGenesis(owner: Phone): SignedText {
  return owner.signRoster(
    nextRosterChange(
      null,
      ACCOUNT,
      owner.deviceId,
      { op: 'add', device: phoneDevice(owner) },
      new Date(T0).toISOString(),
    ),
  )
}

async function setup(options: { present?: () => boolean } = {}) {
  let present = options.present ?? (() => true)
  const signer = new SoftwareSigner(() => present())
  const keys = await signer.keys()
  const ledger = await TrustedLedger.open(
    new AnchoredFile('/t.json', 'trusted', new MemoryAnchor(), new MemoryFiles()),
  )
  const devices = new DeviceStore(ledger, keys)
  /** One prompt for every payload, as the Secure Enclave helper does it. */
  const prompts: { reason: string; count: number }[] = []
  const channel: ChannelKeys = {
    ...signer.channel,
    signApprovals: async (domain, payloads, reason) => {
      prompts.push({ reason, count: payloads.length })
      if (!present()) return null
      const out: string[] = []
      for (const p of payloads) out.push((await signer.sign(domain, p, reason)) as string)
      return out
    },
  }
  const hub: SignedText[] = []
  const sent: SignedText[][] = []
  const removed: { deviceId: string; by: string }[] = []
  const joins: SignedText[] = []
  const handed: (readonly AccountPhone[])[] = []
  const keeper = new RosterKeeper({
    ledger,
    devices,
    keys,
    channel,
    macName: 'Studio',
    send: (changes) => {
      sent.push([...changes])
      return true
    },
    removed: async (deviceId, by) => {
      removed.push({ deviceId, by })
      await devices.revoke(deviceId, by, new Date(T0).toISOString())
    },
    now: () => T0,
    onChange: () => undefined,
    sendJoin: (record) => {
      joins.push(record)
      return true
    },
    onPhones: (phones) => handed.push(phones),
  })

  /** The hub's half: keeps the last batch the Mac sent if the chain still checks, then answers. */
  async function answer(): Promise<void> {
    const batch = sent.shift()
    if (batch === undefined) throw new Error('nothing sent')
    const check = verifyRoster([...hub, ...batch])
    if (check.ok) {
      hub.push(...batch)
      await keeper.received([...hub])
    } else {
      const conflict = check.reason === 'broken-chain' && check.at === hub.length
      await keeper.received([...hub], conflict ? 'conflict' : 'invalid')
    }
  }

  async function pair(p: Phone): Promise<void> {
    const payload = JSON.stringify({
      v: 1,
      deviceId: p.deviceId,
      macId: devices.macId,
      role: 'phone',
      platform: 'ios',
      name: p.name,
      approvalKey: p.approval.spki,
      transportKey: p.transport.spki,
      agreementKey: p.agreement.spki,
      pairedAt: new Date(T0).toISOString(),
    })
    const signature = await signer.sign(SIGNING_DOMAINS.deviceRecord, payload, 'pair')
    await devices.add({ payload, signature: signature as string })
  }

  return {
    keeper,
    ledger,
    devices,
    hub,
    sent,
    prompts,
    removed,
    joins,
    handed,
    answer,
    pair,
    setPresent: (fn: () => boolean) => (present = fn),
    roster: () => {
      const check = verifyRoster(hub)
      if (!check.ok) throw new Error(check.reason)
      return check.roster
    },
  }
}

describe('the Mac and the account’s device list', () => {
  it('starts the list with itself and the phones it paired, under one prompt', async () => {
    const t = await setup()
    const a = phone('iPhone')
    const b = phone('iPad')
    await t.pair(a)
    await t.pair(b)
    await t.keeper.linked(ACCOUNT)
    expect(t.keeper.view.state).toBe('waiting')
    await t.keeper.received([])
    expect(t.prompts).toEqual([{ reason: 'put this Mac and its iPhones on your Valet account', count: 3 }])
    expect(t.sent[0]).toHaveLength(3)
    await t.answer()

    const roster = t.roster()
    expect([...roster.devices.keys()]).toEqual([t.devices.macId, a.deviceId, b.deviceId])
    expect(roster.devices.get(t.devices.macId)).toMatchObject({ role: 'mac', name: 'Studio' })
    expect(t.keeper.view).toEqual({ state: 'on', devices: 3 })
    // Pinned: its own first change, and the latest it saw.
    expect(t.ledger.data.roster).toEqual({
      account: ACCOUNT,
      genesis: roster.genesis,
      seq: 2,
      head: roster.head,
    })
    // Hearing the same list again asks nothing.
    await t.keeper.received([...t.hub])
    expect(t.prompts).toHaveLength(1)
  })

  it('adds a phone paired later and removes one removed here', async () => {
    const t = await setup()
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([])
    await t.answer()
    expect(t.keeper.view).toEqual({ state: 'on', devices: 1 })

    const a = phone('iPhone')
    await t.pair(a)
    await t.keeper.changed()
    expect(t.prompts.at(-1)).toEqual({ reason: 'add an iPhone to your Valet account', count: 1 })
    await t.answer()
    expect(t.roster().devices.has(a.deviceId)).toBe(true)

    await t.devices.revoke(a.deviceId, 'mac-ui', new Date(T0).toISOString())
    await t.keeper.changed()
    expect(t.prompts.at(-1)).toEqual({ reason: 'remove a device from your Valet account', count: 1 })
    await t.answer()
    expect(t.roster().devices.has(a.deviceId)).toBe(false)
    expect(t.keeper.view).toEqual({ state: 'on', devices: 1 })
    expect(t.removed).toEqual([])
  })

  it('revokes a phone of its own that another device took off the list', async () => {
    const t = await setup()
    const a = phone('iPhone')
    const b = phone('iPad')
    await t.pair(a)
    await t.pair(b)
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([])
    await t.answer()

    // The iPad removes the iPhone.
    t.hub.push(
      b.signRoster(
        nextRosterChange(
          t.roster(),
          ACCOUNT,
          b.deviceId,
          { op: 'remove', deviceId: a.deviceId },
          new Date(T0).toISOString(),
        ),
      ),
    )
    await t.keeper.received([...t.hub])
    expect(t.removed).toEqual([{ deviceId: a.deviceId, by: b.deviceId }])
    expect(t.devices.isActivePhone(a.deviceId)).toBe(false)
    expect(t.devices.isActivePhone(b.deviceId)).toBe(true)
    // Nothing to put back: it was removed on purpose.
    expect(t.sent).toEqual([])
    expect(t.keeper.view).toEqual({ state: 'on', devices: 2 })
  })

  it('builds again on the newer list after a conflict', async () => {
    const t = await setup()
    const b = phone('iPad')
    await t.pair(b)
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([])
    await t.answer()

    const a = phone('iPhone')
    await t.pair(a)
    await t.keeper.changed()
    // Meanwhile the iPad adds a phone of its own, so the Mac's change names an old head.
    const other = phone('Other iPhone')
    t.hub.push(
      b.signRoster(
        nextRosterChange(
          t.roster(),
          ACCOUNT,
          b.deviceId,
          {
            op: 'add',
            device: {
              deviceId: other.deviceId,
              role: 'phone',
              platform: 'ios',
              name: other.name,
              approvalKey: other.approval.spki,
              transportKey: other.transport.spki,
              agreementKey: other.agreement.spki,
            },
          },
          new Date(T0).toISOString(),
        ),
      ),
    )
    await t.answer()
    // Refused as a conflict; the Mac signs again on the new head, and that one is kept.
    expect(t.sent).toHaveLength(1)
    await t.answer()
    expect([...t.roster().devices.keys()]).toEqual([t.devices.macId, b.deviceId, other.deviceId, a.deviceId])
    expect(t.keeper.view).toEqual({ state: 'on', devices: 4 })
  })

  it('refuses a list rolled back, emptied, swapped or broken', async () => {
    const t = await setup()
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([])
    await t.answer()
    const a = phone('iPhone')
    await t.pair(a)
    await t.keeper.changed()
    await t.answer()
    const full = [...t.hub]

    await t.keeper.received(full.slice(0, 1))
    expect(t.keeper.view.state).toBe('refused')
    await t.keeper.received([])
    expect(t.keeper.view.state).toBe('refused')
    // Another list altogether, started by some other key.
    const stranger = phone('Stranger')
    const forged = stranger.signRoster(
      nextRosterChange(
        null,
        ACCOUNT,
        stranger.deviceId,
        {
          op: 'add',
          device: {
            deviceId: stranger.deviceId,
            role: 'phone',
            platform: 'ios',
            name: 'Stranger',
            approvalKey: stranger.approval.spki,
            transportKey: stranger.transport.spki,
            agreementKey: stranger.agreement.spki,
          },
        },
        new Date(T0).toISOString(),
      ),
    )
    await t.keeper.received([forged])
    expect(t.keeper.view.state).toBe('refused')
    await t.keeper.received([...full.slice(0, 1), { payload: full[1]?.payload ?? '', signature: 'AAAA' }])
    expect(t.keeper.view.state).toBe('refused')
    // None of it signed anything or touched a phone.
    expect(t.sent).toEqual([])
    expect(t.devices.isActivePhone(a.deviceId)).toBe(true)
    // The real list again is fine.
    await t.keeper.received(full)
    expect(t.keeper.view).toEqual({ state: 'on', devices: 2 })
  })

  it('waits to be added to a list it didn’t start, and pins nothing', async () => {
    const t = await setup()
    const owner = phone('Owner')
    const genesis = owner.signRoster(
      nextRosterChange(
        null,
        ACCOUNT,
        owner.deviceId,
        {
          op: 'add',
          device: {
            deviceId: owner.deviceId,
            role: 'phone',
            platform: 'ios',
            name: 'Owner',
            approvalKey: owner.approval.spki,
            transportKey: owner.transport.spki,
            agreementKey: owner.agreement.spki,
          },
        },
        new Date(T0).toISOString(),
      ),
    )
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([genesis])
    expect(t.keeper.view).toEqual({ state: 'not-added', devices: 1 })
    expect(t.ledger.data.roster).toBeUndefined()
    expect(t.prompts).toEqual([])
  })

  it('joins a list a phone started after a fresh link, once the phone adds it with its own keys', async () => {
    const t = await setup()
    const owner = phone('Owner')
    const genesis = phoneGenesis(owner)
    // The status and the list arrive together, as they do from the relay: the list isn't lost
    // while the link is written down.
    await Promise.all([t.keeper.linked(ACCOUNT, true), t.keeper.received([genesis])])
    expect(t.ledger.data.rosterJoin?.account).toBe(ACCOUNT)
    expect(t.keeper.view).toEqual({ state: 'joining', devices: 1 })
    expect(t.ledger.data.roster).toBeUndefined()
    // It asked with its own record, signed by its own key, naming its own three keys.
    expect(t.joins).toHaveLength(1)
    const device = joinRecordDevice(t.joins[0] as SignedText, { macId: t.devices.macId })
    expect(device).toMatchObject({
      deviceId: t.devices.macId,
      role: 'mac',
      name: 'Studio',
      transportKey: t.devices.mac.transportKey,
      agreementKey: t.devices.mac.agreementKey,
    })
    // Heard again before anyone added it: asks again, without signing again.
    await t.keeper.received([genesis])
    expect(t.joins).toHaveLength(2)
    expect(t.joins[1]).toEqual(t.joins[0])
    expect(t.handed).toEqual([])

    // The phone adds it: pinned, and the phone is trusted here without pairing.
    const first = verifyRoster([genesis])
    if (!first.ok || device === null) throw new Error('setup')
    const add = owner.signRoster(
      nextRosterChange(
        first.roster,
        ACCOUNT,
        owner.deviceId,
        { op: 'add', device },
        new Date(T0 + 1000).toISOString(),
      ),
    )
    await t.keeper.received([genesis, add])
    expect(t.keeper.view).toEqual({ state: 'on', devices: 2 })
    expect(t.ledger.data.roster).toMatchObject({ account: ACCOUNT, seq: 1, genesis: first.roster.genesis })
    expect(t.ledger.data.rosterJoin).toBeUndefined()
    expect(t.handed.at(-1)).toEqual([{ device: phoneDevice(owner), addedAt: new Date(T0).toISOString() }])

    // From now on the pin holds: a list swapped for another the hub made up is refused.
    const other = phone('Other')
    const swapped = phoneGenesis(other)
    await t.keeper.received([swapped])
    expect(t.keeper.view.state).toBe('refused')
    expect(t.handed.at(-1)).toEqual([])
  })

  it('pins nothing a phone adds it to unless the person just linked it, and never wrong keys', async () => {
    const t = await setup()
    const owner = phone('Owner')
    const genesis = phoneGenesis(owner)
    const first = verifyRoster([genesis])
    if (!first.ok) throw new Error(first.reason)
    const mac = t.devices.mac
    const self: RosterDevice = {
      deviceId: mac.deviceId,
      role: 'mac',
      platform: 'macos',
      name: 'Studio',
      approvalKey: mac.approvalKey,
      transportKey: mac.transportKey,
      agreementKey: mac.agreementKey,
    }
    const at = new Date(T0).toISOString()
    // Not freshly linked: a list that lists it is still someone else's.
    await t.keeper.linked(ACCOUNT)
    const added = owner.signRoster(
      nextRosterChange(first.roster, ACCOUNT, owner.deviceId, { op: 'add', device: self }, at),
    )
    await t.keeper.received([genesis, added])
    expect(t.keeper.view).toEqual({ state: 'not-added', devices: 2 })
    expect(t.ledger.data.roster).toBeUndefined()
    expect(t.joins).toEqual([])

    // Freshly linked, but the list adds it with an agreement key that isn't its own.
    await t.keeper.linked(ACCOUNT, true)
    const forged = owner.signRoster(
      nextRosterChange(
        first.roster,
        ACCOUNT,
        owner.deviceId,
        { op: 'add', device: { ...self, agreementKey: phone('x').agreement.spki } },
        at,
      ),
    )
    await t.keeper.received([genesis, forged])
    expect(t.keeper.view.state).toBe('refused')
    expect(t.ledger.data.roster).toBeUndefined()
    expect(t.handed).toEqual([])
  })

  it('waits, without asking, on a list with no phone to add it', async () => {
    const t = await setup()
    const other = phone('Another Mac')
    const genesis = other.signRoster(
      nextRosterChange(
        null,
        ACCOUNT,
        other.deviceId,
        { op: 'add', device: { ...phoneDevice(other), role: 'mac', platform: 'macos' } },
        new Date(T0).toISOString(),
      ),
    )
    await t.keeper.linked(ACCOUNT, true)
    await t.keeper.received([genesis])
    expect(t.keeper.view).toEqual({ state: 'not-added', devices: 1 })
    expect(t.joins).toEqual([])
  })

  it('asks once after a cancel, until the person tries again', async () => {
    const t = await setup()
    await t.pair(phone('iPhone'))
    t.setPresent(() => false)
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([])
    expect(t.keeper.view.state).toBe('needs-you')
    await t.keeper.received([])
    expect(t.prompts).toHaveLength(1)
    t.setPresent(() => true)
    await t.keeper.retry()
    expect(t.prompts).toHaveLength(2)
    await t.answer()
    expect(t.keeper.view).toEqual({ state: 'on', devices: 2 })
  })

  it('stops after the hub calls a change invalid, and forgets the pin on leaving', async () => {
    const t = await setup()
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([])
    await t.answer()
    await t.pair(phone('iPhone'))
    await t.keeper.received([...t.hub], 'invalid')
    expect(t.keeper.view.state).toBe('refused')
    expect(t.sent).toEqual([])

    expect(t.ledger.data.roster).toBeDefined()
    await t.keeper.linked(null)
    expect(t.keeper.view).toEqual({ state: 'off', devices: 0 })
    expect(t.ledger.data.roster).toBeUndefined()
    // Not on an account: nothing is heard.
    await t.keeper.received([])
    expect(t.sent).toEqual([])
  })

  it('starts again when added afresh after the account’s list was emptied without it hearing', async () => {
    const t = await setup()
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([])
    await t.answer()
    expect(t.ledger.data.roster).toBeDefined()

    // The hub dropped the list while this Mac wasn't listening (it was removed and missed it).
    t.hub.splice(0)
    await t.keeper.received([])
    expect(t.keeper.view.state).toBe('refused')
    expect(t.sent).toEqual([])
    // Hearing the same account again is no reason to forget the pin…
    await t.keeper.linked(ACCOUNT)
    await t.keeper.received([])
    expect(t.sent).toEqual([])
    // …but being added again with a code it showed is: it starts a new list, under one prompt.
    await t.keeper.linked(ACCOUNT, true)
    expect(t.ledger.data.roster).toBeUndefined()
    await t.keeper.received([])
    expect(t.sent).toHaveLength(1)
    await t.answer()
    expect(t.keeper.view).toEqual({ state: 'on', devices: 1 })
    expect(t.keeper.roster).not.toBeNull()
  })
})
