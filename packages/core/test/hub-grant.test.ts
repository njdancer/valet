import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  hubGrantId,
  keyId,
  nextRosterChange,
  type Roster,
  SIGNING_DOMAINS,
  type SignedText,
  verifyHubGrant,
  verifyRoster,
} from '../src/index'

const ACCOUNT = 'acct_0123456789abcdef'
const NOW = Date.parse('2026-11-16T00:00:00.000Z')

function device() {
  const make = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    return {
      spki: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url'),
      privateKey,
    }
  }
  const approval = make()
  const signWith = (domain: string, payload: string): SignedText => ({
    payload,
    signature: sign('sha256', Buffer.from(`${domain}\n${payload}`), {
      key: approval.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  })
  return {
    id: keyId(approval.spki),
    record: {
      deviceId: keyId(approval.spki),
      role: 'mac' as const,
      platform: 'macos' as const,
      name: 'Studio',
      approvalKey: approval.spki,
      transportKey: make().spki,
      agreementKey: make().spki,
    },
    signWith,
  }
}

function grant(by: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    account: ACCOUNT,
    consentId: 'consent_0123456789',
    clientId: 'hc0123456789abcdef',
    clientName: 'Claude',
    host: 'claude.ai',
    scope: 'remote-tools',
    at: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 30 * 24 * 60 * 60_000).toISOString(),
    by,
    ...fields,
  })
}

describe('an agent’s grant at the hub', () => {
  const mac = device()
  const genesis = mac.signWith(
    SIGNING_DOMAINS.rosterChange,
    nextRosterChange(null, ACCOUNT, mac.id, { op: 'add', device: mac.record }, new Date(NOW).toISOString()),
  )
  const roster = (verifyRoster([genesis]) as { ok: true; roster: Roster }).roster

  it('holds when a device on the list signed it', () => {
    const signed = mac.signWith(SIGNING_DOMAINS.hubGrant, grant(mac.id))
    const check = verifyHubGrant(signed, roster, NOW)
    expect(check).toMatchObject({ ok: true, id: hubGrantId(signed), grant: { clientName: 'Claude' } })
  })

  it('refuses a stranger, another purpose, another account, the wrong time and junk', () => {
    const stranger = device()
    expect(
      verifyHubGrant(stranger.signWith(SIGNING_DOMAINS.hubGrant, grant(stranger.id)), roster, NOW),
    ).toEqual({
      ok: false,
      reason: 'not-a-member',
    })
    expect(verifyHubGrant(stranger.signWith(SIGNING_DOMAINS.hubGrant, grant(mac.id)), roster, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
    expect(
      verifyHubGrant(mac.signWith(SIGNING_DOMAINS.rosterChange, grant(mac.id)), roster, NOW),
    ).toMatchObject({
      reason: 'bad-signature',
    })
    expect(
      verifyHubGrant(
        mac.signWith(SIGNING_DOMAINS.hubGrant, grant(mac.id, { account: 'acct_another_account_0' })),
        roster,
        NOW,
      ),
    ).toMatchObject({ reason: 'wrong-account' })
    const signed = mac.signWith(SIGNING_DOMAINS.hubGrant, grant(mac.id))
    expect(verifyHubGrant(signed, roster, NOW + 31 * 24 * 60 * 60_000)).toMatchObject({ reason: 'expired' })
    expect(verifyHubGrant(signed, roster, NOW - 60 * 60_000)).toMatchObject({ reason: 'not-yet' })
    const long = grant(mac.id, { expiresAt: new Date(NOW + 91 * 24 * 60 * 60_000).toISOString() })
    expect(verifyHubGrant(mac.signWith(SIGNING_DOMAINS.hubGrant, long), roster, NOW)).toMatchObject({
      reason: 'malformed',
    })
    expect(verifyHubGrant({ payload: 'not json', signature: 'x' }, roster, NOW)).toMatchObject({
      reason: 'malformed',
    })
    expect(
      verifyHubGrant(
        mac.signWith(SIGNING_DOMAINS.hubGrant, grant(mac.id, { scope: 'everything' })),
        roster,
        NOW,
      ),
    ).toMatchObject({ reason: 'malformed' })
  })
})
