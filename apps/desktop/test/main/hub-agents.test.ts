// @vitest-environment node

// Agents signing in through the hub, as the Mac takes part (approvals/hub-agents.ts): sign-ins the
// hub sends, picked by the code the browser shows, a grant signed by this Mac's approval key, and
// grants honoured only when they check against the account's list.

import { generateKeyPairSync, sign } from 'node:crypto'
import {
  keyId,
  type MacToRelay,
  nextRosterChange,
  type Roster,
  SIGNING_DOMAINS,
  type SignedText,
  signingInput,
  verifyHubGrant,
  verifyRoster,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import { HUB_GRANT_DAYS, HubAgents, SoftwareSigner } from '../../src/main/core/approvals'

const ACCOUNT = 'acct_0123456789abcdef'
const T0 = Date.parse('2026-11-16T00:00:00.000Z')

function stranger() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  return {
    id: keyId(spki),
    sign: (domain: string, payload: string): SignedText => ({
      payload,
      signature: sign('sha256', signingInput(domain as never, payload), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
    }),
  }
}

async function setup(options: { present?: boolean; connected?: boolean } = {}) {
  let present = true
  const signer = new SoftwareSigner(() => present)
  const keys = await signer.keys()
  const macId = keyId(keys.approvalKey)
  const genesis = {
    payload: nextRosterChange(
      null,
      ACCOUNT,
      macId,
      {
        op: 'add',
        device: {
          deviceId: macId,
          role: 'mac',
          platform: 'macos',
          name: 'Studio',
          approvalKey: keys.approvalKey,
          transportKey: keys.transportKey,
          agreementKey: keys.agreementKey,
        },
      },
      new Date(T0).toISOString(),
    ),
    signature: '',
  }
  genesis.signature = (await signer.sign(SIGNING_DOMAINS.rosterChange, genesis.payload, 'start')) as string
  const roster = (verifyRoster([genesis]) as { ok: true; roster: Roster }).roster
  present = options.present ?? true
  let current: Roster | null = roster
  let now = T0
  const sent: MacToRelay[] = []
  const changes: boolean[] = []
  const agents = new HubAgents({
    macId,
    channel: signer.channel,
    roster: () => current,
    send: (frame) => {
      if (options.connected === false) return false
      sent.push(frame)
      return true
    },
    now: () => now,
    onChange: (opened) => changes.push(opened),
  })
  return {
    agents,
    signer,
    roster,
    sent,
    changes,
    macId,
    setRoster: (r: Roster | null) => (current = r),
    tick: (ms: number) => (now += ms),
  }
}

const consent = (id: string, code: string, expiresAt = T0 + 600_000) => ({
  id,
  clientId: 'hc0123456789abcdef',
  clientName: 'Claude',
  host: 'claude.ai',
  source: '203.0.113.9',
  code,
  expiresAt: new Date(expiresAt).toISOString(),
})

describe('agents signing in through the hub, on the Mac', () => {
  it('lists the hub’s sign-ins and says when a new one arrives', async () => {
    const t = await setup()
    t.agents.received([consent('consent_000000001', 'ABCD-EFGH')])
    t.agents.received([consent('consent_000000001', 'ABCD-EFGH')])
    t.agents.received([consent('consent_000000001', 'ABCD-EFGH'), consent('consent_000000002', 'JKLM-NPQR')])
    t.agents.received([consent('consent_000000002', 'JKLM-NPQR')])
    expect(t.changes).toEqual([true, true, false])
    expect(t.agents.consents().map((c) => c.id)).toEqual(['consent_000000002'])
    expect(t.agents.matching('jklm npqr')?.id).toBe('consent_000000002')
    expect(t.agents.matching('ABCD-EFGH')).toBeNull()
    expect(t.agents.matching('nope')).toBeNull()
    t.tick(600_001)
    expect(t.agents.consents()).toEqual([])
  })

  it('signs a grant this Mac can check, for the sign-in the code picked', async () => {
    const t = await setup()
    t.agents.received([consent('consent_000000001', 'ABCD-EFGH')])
    const picked = t.agents.matching('ABCD-EFGH')
    if (picked === null) throw new Error('no match')
    expect(await t.agents.approve(picked)).toBe(true)
    expect(t.signer.prompts.at(-1)).toBe(
      'let an agent at claude.ai use your Valet tools through your Valet account',
    )
    const frame = t.sent[0]
    if (frame?.type !== 'hub-grant') throw new Error('expected a grant')
    const check = verifyHubGrant(frame.grant, t.roster, T0)
    expect(check).toMatchObject({
      ok: true,
      grant: {
        consentId: 'consent_000000001',
        clientId: 'hc0123456789abcdef',
        by: t.macId,
        scope: 'remote-tools',
      },
    })
    if (!check.ok) throw new Error(check.reason)
    expect(Date.parse(check.grant.expiresAt) - T0).toBe(HUB_GRANT_DAYS * 24 * 60 * 60_000)
    expect(t.agents.consents()).toEqual([])

    // Kept once the hub sends it back; one by someone not on the list, or expired, isn't.
    const other = stranger()
    const forged = other.sign(SIGNING_DOMAINS.hubGrant, frame.grant.payload.replace(t.macId, other.id))
    t.agents.grantsReceived([frame.grant, forged])
    expect(t.agents.grants().map((g) => g.grant.clientId)).toEqual(['hc0123456789abcdef'])
    t.setRoster(null)
    expect(t.agents.grants()).toEqual([])
    t.setRoster(t.roster)
    t.tick(HUB_GRANT_DAYS * 24 * 60 * 60_000 + 1)
    expect(t.agents.grants()).toEqual([])
  })

  it('signs nothing without the person, the list, or a connection', async () => {
    const declined = await setup({ present: false })
    declined.agents.received([consent('consent_000000001', 'ABCD-EFGH')])
    expect(await declined.agents.approve(declined.agents.consents()[0] as never)).toBe(false)
    expect(declined.sent).toEqual([])

    const off = await setup({ connected: false })
    off.agents.received([consent('consent_000000001', 'ABCD-EFGH')])
    expect(await off.agents.approve(off.agents.consents()[0] as never)).toBe(false)
    expect(off.agents.consents()).toHaveLength(1)

    const listless = await setup()
    listless.setRoster(null)
    listless.agents.received([consent('consent_000000001', 'ABCD-EFGH')])
    expect(await listless.agents.approve(listless.agents.consents()[0] as never)).toBe(false)
    expect(listless.signer.prompts.filter((p) => p.startsWith('let an agent'))).toEqual([])
  })

  it('declines one or all, telling the hub', async () => {
    const t = await setup()
    t.agents.received([consent('consent_000000001', 'ABCD-EFGH'), consent('consent_000000002', 'JKLM-NPQR')])
    expect(t.agents.decline('consent_000000001')).toBe(true)
    expect(t.agents.decline('consent_000000001')).toBe(false)
    expect(t.agents.declineAll()).toBe(1)
    expect(t.sent).toEqual([
      { type: 'hub-consent-decline', consentId: 'consent_000000001' },
      { type: 'hub-consent-decline', consentId: 'consent_000000002' },
    ])
    expect(t.agents.consents()).toEqual([])
  })
})
