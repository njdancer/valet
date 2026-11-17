import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  keyId,
  nextRosterChange,
  ROSTER_MAX_DEVICES,
  type Roster,
  type RosterChange,
  type RosterDevice,
  rosterChangeHash,
  SIGNING_DOMAINS,
  type SignedText,
  verifyRoster,
} from '../src/index'

const ACCOUNT = 'acct_0123456789abcdef'
const AT = '2026-11-16T00:00:00.000Z'

interface Device {
  readonly record: RosterDevice
  sign(payload: string, domain?: string): SignedText
}

function spki(): { publicKey: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url'),
    privateKey,
  }
}

function device(role: 'mac' | 'phone', name = role === 'mac' ? 'MacBook Pro' : 'iPhone'): Device {
  const approval = spki()
  const record: RosterDevice = {
    deviceId: keyId(approval.publicKey),
    role,
    platform: role === 'mac' ? 'macos' : 'ios',
    name,
    approvalKey: approval.publicKey,
    transportKey: spki().publicKey,
    agreementKey: spki().publicKey,
  }
  return {
    record,
    sign: (payload, domain = SIGNING_DOMAINS.rosterChange) => ({
      payload,
      signature: sign('sha256', Buffer.from(`${domain}\n${payload}`), {
        key: approval.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
    }),
  }
}

/** Appends one change signed by `by`, checking the chain still verifies. */
function append(chain: SignedText[], by: Device, change: RosterChange['change']): Roster {
  const current = chain.length === 0 ? null : (verifyRoster(chain) as { ok: true; roster: Roster }).roster
  chain.push(by.sign(nextRosterChange(current, ACCOUNT, by.record.deviceId, change, AT)))
  const check = verifyRoster(chain)
  if (!check.ok) throw new Error(`append failed: ${check.reason}`)
  return check.roster
}

describe('the account roster', () => {
  it('starts with a device adding itself, then grows only by members’ signatures', () => {
    const mac = device('mac')
    const phone = device('phone')
    const chain: SignedText[] = []
    const first = append(chain, mac, { op: 'add', device: mac.record })
    expect(first.seq).toBe(0)
    expect(first.genesis).toBe(rosterChangeHash(chain[0] as SignedText))
    const second = append(chain, mac, { op: 'add', device: phone.record })
    expect([...second.devices.keys()]).toEqual([mac.record.deviceId, phone.record.deviceId])
    expect(second.genesis).toBe(first.genesis)
    // The new phone can now add a phone itself, and remove the Mac.
    const tablet = device('phone', 'iPad')
    append(chain, phone, { op: 'add', device: tablet.record })
    const after = append(chain, phone, { op: 'remove', deviceId: mac.record.deviceId })
    expect(after.devices.has(mac.record.deviceId)).toBe(false)
    expect(verifyRoster(chain, { pinned: first.genesis }).ok).toBe(true)
  })

  it('refuses a stranger’s signature, a forged first change, and a wrong domain', () => {
    const mac = device('mac')
    const stranger = device('phone')
    const chain: SignedText[] = []
    const roster = append(chain, mac, { op: 'add', device: mac.record })

    // A device not on the list can't add itself.
    const self = stranger.sign(
      nextRosterChange(roster, ACCOUNT, stranger.record.deviceId, { op: 'add', device: stranger.record }, AT),
    )
    expect(verifyRoster([...chain, self])).toMatchObject({ ok: false, at: 1, reason: 'not-a-member' })

    // Claimed as the Mac's, signed by someone else.
    const forged = stranger.sign(
      nextRosterChange(roster, ACCOUNT, mac.record.deviceId, { op: 'add', device: stranger.record }, AT),
    )
    expect(verifyRoster([...chain, forged])).toMatchObject({ ok: false, reason: 'bad-signature' })

    // The first change must be the signer adding itself.
    const odd = mac.sign(
      nextRosterChange(null, ACCOUNT, mac.record.deviceId, { op: 'add', device: stranger.record }, AT),
    )
    expect(verifyRoster([odd])).toMatchObject({ ok: false, at: 0, reason: 'broken-chain' })

    // A signature over the same text for another purpose.
    const other = mac.sign(
      nextRosterChange(roster, ACCOUNT, mac.record.deviceId, { op: 'add', device: stranger.record }, AT),
      SIGNING_DOMAINS.deviceRecord,
    )
    expect(verifyRoster([...chain, other])).toMatchObject({ ok: false, reason: 'bad-signature' })
  })

  it('catches a hub that forks, reorders, rolls back or swaps the chain', () => {
    const mac = device('mac')
    const phone = device('phone')
    const chain: SignedText[] = []
    const first = append(chain, mac, { op: 'add', device: mac.record })
    const seen = append(chain, mac, { op: 'add', device: phone.record })

    // Reordered: the second change no longer follows the first.
    expect(verifyRoster([chain[1] as SignedText, chain[0] as SignedText]).ok).toBe(false)
    // Rolled back to before the phone, for a node that saw the phone.
    expect(verifyRoster(chain.slice(0, 1), { known: { seq: seen.seq, head: seen.head } })).toMatchObject({
      ok: false,
      reason: 'stale',
    })
    // A fork: another change at the same place.
    const fork = [...chain.slice(0, 1)]
    append(fork, mac, { op: 'add', device: device('phone').record })
    expect(verifyRoster(fork, { known: { seq: seen.seq, head: seen.head } })).toMatchObject({
      ok: false,
      reason: 'broken-chain',
    })
    // A whole other account's chain.
    const other: SignedText[] = []
    const otherMac = device('mac')
    append(other, otherMac, { op: 'add', device: otherMac.record })
    expect(verifyRoster(other, { pinned: first.genesis })).toMatchObject({
      ok: false,
      reason: 'wrong-genesis',
    })
  })

  it('never empties the list, never adds twice, and caps the size', () => {
    const mac = device('mac')
    const chain: SignedText[] = []
    const roster = append(chain, mac, { op: 'add', device: mac.record })
    const removeSelf = mac.sign(
      nextRosterChange(
        roster,
        ACCOUNT,
        mac.record.deviceId,
        { op: 'remove', deviceId: mac.record.deviceId },
        AT,
      ),
    )
    expect(verifyRoster([...chain, removeSelf])).toMatchObject({ ok: false, reason: 'last-device' })
    const again = mac.sign(
      nextRosterChange(roster, ACCOUNT, mac.record.deviceId, { op: 'add', device: mac.record }, AT),
    )
    expect(verifyRoster([...chain, again])).toMatchObject({ ok: false, reason: 'duplicate' })

    for (let n = 1; n < ROSTER_MAX_DEVICES; n++)
      append(chain, mac, { op: 'add', device: device('phone').record })
    const full = (verifyRoster(chain) as { ok: true; roster: Roster }).roster
    const extra = mac.sign(
      nextRosterChange(full, ACCOUNT, mac.record.deviceId, { op: 'add', device: device('phone').record }, AT),
    )
    expect(verifyRoster([...chain, extra])).toMatchObject({ ok: false, reason: 'too-many-devices' })
  })

  it('refuses junk and a change moved into another account', () => {
    const mac = device('mac')
    const chain: SignedText[] = []
    const roster = append(chain, mac, { op: 'add', device: mac.record })
    expect(verifyRoster([])).toMatchObject({ ok: false, reason: 'empty' })
    expect(verifyRoster([{ payload: 'not json', signature: 'x' }])).toMatchObject({
      ok: false,
      reason: 'malformed',
    })
    const moved = mac.sign(
      JSON.stringify({
        ...JSON.parse(
          nextRosterChange(
            roster,
            ACCOUNT,
            mac.record.deviceId,
            { op: 'add', device: device('phone').record },
            AT,
          ),
        ),
        account: 'acct_another_account_0',
      }),
    )
    expect(verifyRoster([...chain, moved])).toMatchObject({ ok: false, reason: 'wrong-account' })
  })
})
