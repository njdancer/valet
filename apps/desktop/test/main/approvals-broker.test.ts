// @vitest-environment node
// The approval broker (docs/approval-broker.md). The plan's definition of done for workstream D:
// a synthetic click, a written file and a replayed approval all fail. Plus the limits, expiry,
// declines, withdrawal, lockdown and stale requests.

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import {
  type AnchorState,
  type ApprovalSubject,
  type AuditEvent,
  type AuditRecord,
  decisionPayload,
  keyId,
  type Requester,
  SIGNING_DOMAINS,
  type SignedText,
  signingInput,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  AnchoredFile,
  ApprovalBroker,
  cooldownUntil,
  DeviceStore,
  type FileOps,
  type KindHandlers,
  type MacToPhoneBody,
  MemoryAnchor,
  PhoneInbox,
  promptReason,
  SoftwareSigner,
  TrustedLedger,
} from '../../src/main/core/approvals'
import { ManualTimers } from './fixtures'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const T0 = Date.parse('2026-11-12T03:00:00.000Z')
const PATH = '/data/trusted.json'

class MemoryFiles implements FileOps {
  readonly files = new Map<string, string>()
  failWrites = false
  async read(path: string) {
    return this.files.get(path) ?? null
  }
  async write(path: string, text: string) {
    if (this.failWrites) throw new Error('disk full')
    this.files.set(path, text)
  }
}

interface Keys {
  readonly privateKey: KeyObject
  readonly spki: string
}
function p256(): Keys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
}
function signWith(
  keys: Keys,
  domain: (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS],
  payload: string,
) {
  return sign('sha256', signingInput(domain, payload), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
}

const agent = (id = 'claude'): Requester => ({
  kind: 'agent',
  clientId: `local:${id}`,
  clientName: 'Claude Code',
})
const person: Requester = { kind: 'person' }
const app: Requester = { kind: 'app' }

const tool = (over: Partial<ApprovalSubject<'tool-enable'>> = {}): ApprovalSubject<'tool-enable'> => ({
  adapterId: 'yahoo-finance',
  adapterHash: HASH_A,
  tool: 'get_quote',
  scope: 'local',
  clientId: null,
  sideEffect: 'read',
  ...over,
})
const install = (
  over: Partial<ApprovalSubject<'adapter-install'>> = {},
): ApprovalSubject<'adapter-install'> => ({
  adapterId: 'yahoo-finance',
  adapterName: 'Yahoo Finance',
  version: '1.0.0',
  adapterHash: HASH_A,
  packageHash: HASH_B,
  previousHash: null,
  source: 'draft',
  inheritsSession: false,
  references: [],
  changes: [{ area: 'navigation', change: 'added', items: ['https://finance.yahoo.com'], risk: 'low' }],
  unsandboxed: false,
  ...over,
})

async function setup(
  options: {
    present?: (reason: string) => boolean
    handlers?: KindHandlers
    files?: MemoryFiles
    anchor?: MemoryAnchor
    signer?: SoftwareSigner
  } = {},
) {
  let now = T0
  let ids = 0
  const files = options.files ?? new MemoryFiles()
  const anchor = options.anchor ?? new MemoryAnchor()
  const signer = options.signer ?? new SoftwareSigner(options.present ?? (() => true))
  const events: AuditEvent[] = []
  const audit = {
    async append(event: AuditEvent) {
      events.push(event)
      return { event } as unknown as AuditRecord
    },
  }
  const sent: { deviceId: string; message: MacToPhoneBody }[] = []
  const timers = new ManualTimers()
  const ledger = await TrustedLedger.open(new AnchoredFile(PATH, 'trusted', anchor, files))
  const devices = new DeviceStore(ledger, await signer.keys())
  const applied: string[] = []
  const handlers: KindHandlers = options.handlers ?? {
    'tool-enable': { apply: async (s) => void applied.push(`${s.adapterId}.${s.tool}`) },
    'adapter-install': {
      apply: async (s) => void applied.push(`install ${s.adapterHash}`),
      supersedes: (next, older) => next.adapterId === older.adapterId,
    },
  }
  const broker = await ApprovalBroker.open({
    ledger,
    devices,
    signer,
    audit,
    handlers,
    outbox: { send: (deviceId, message) => void sent.push({ deviceId, message }) },
    now: () => now,
    newId: () => `req${String(++ids).padStart(19, '0')}`,
    timers,
  })
  const phone = { approval: p256(), transport: p256(), agreement: p256() }
  const phoneId = keyId(phone.approval.spki)
  /** Pairs the phone: the Mac signs its record (a Touch ID in real life). */
  const pair = async () => {
    const record = {
      v: 1,
      deviceId: phoneId,
      macId: devices.macId,
      role: 'phone',
      platform: 'ios',
      name: "Riley's iPhone",
      approvalKey: phone.approval.spki,
      transportKey: phone.transport.spki,
      agreementKey: phone.agreement.spki,
      pairedAt: new Date(now).toISOString(),
    }
    const payload = JSON.stringify(record)
    const signature = await signer.sign(SIGNING_DOMAINS.deviceRecord, payload, 'pair')
    await devices.add({ payload, signature: signature as string })
  }
  /** What the phone signs to approve a request it was sent. */
  const phoneApproves = (requestId: string, keys: Keys = phone.approval, deviceId = phoneId): SignedText => {
    const request = broker.get(requestId)
    const payload = decisionPayload({
      v: 1,
      decision: 'approve',
      macId: devices.macId,
      requestId,
      requestDigest: request?.digest ?? '0'.repeat(64),
      deviceId,
      decidedAt: new Date(now).toISOString(),
    })
    return { payload, signature: signWith(keys, SIGNING_DOMAINS.approvalDecision, payload) }
  }
  return {
    broker,
    ledger,
    devices,
    signer,
    files,
    anchor,
    events,
    sent,
    timers,
    applied,
    phone,
    phoneId,
    pair,
    phoneApproves,
    advance: (ms: number) => {
      now += ms
    },
    reopen: async (extra: { handlers?: KindHandlers } = {}) =>
      setup({ files, anchor, signer, handlers: extra.handlers ?? handlers }),
  }
}

const answered = (events: AuditEvent[]) =>
  events.filter(
    (e): e is Extract<AuditEvent, { type: 'approval-answered' }> => e.type === 'approval-answered',
  )

async function requested(t: Awaited<ReturnType<typeof setup>>, subject = tool(), who: Requester = agent()) {
  const result = await t.broker.request('tool-enable', subject, who, 'I need quotes')
  if (!result.ok) throw new Error(result.reason)
  return result.requestId
}

describe('asking', () => {
  it('builds the request itself, stores it, audits it and sends it to phones', async () => {
    const t = await setup()
    await t.pair()
    const result = await t.broker.request('tool-enable', tool(), agent(), 'please')
    expect(result).toMatchObject({ ok: true, reused: false })
    const request = t.broker.list()[0]
    expect(request?.request).toMatchObject({
      kind: 'tool-enable',
      tier: 'approve',
      macId: t.devices.macId,
      agentNote: 'please',
      expiresAt: new Date(T0 + 24 * 3600_000).toISOString(),
    })
    expect(t.events[0]).toMatchObject({
      type: 'approval-requested',
      kind: 'tool-enable',
      digest: request?.digest,
    })
    expect(t.ledger.data.pending).toEqual([{ requestText: request?.text }])
    expect(t.sent).toEqual([
      { deviceId: t.phoneId, message: { type: 'approval-request', requestText: request?.text } },
    ])
  })

  it('answers a repeat with the waiting request, without using up the quota', async () => {
    const t = await setup()
    const first = await t.broker.request('tool-enable', tool(), agent())
    const again = await t.broker.request('tool-enable', tool(), agent())
    expect(again).toMatchObject({ ok: true, reused: true })
    expect(first.ok && again.ok && again.requestId === first.requestId).toBe(true)
    expect(t.broker.list()).toHaveLength(1)
  })

  it('refuses kinds an agent may not ask for, and remote tools for another agent', async () => {
    const t = await setup()
    expect(await t.broker.request('resume', { from: 'lockdown' }, agent())).toEqual({
      ok: false,
      reason: 'not-allowed',
    })
    expect(
      await t.broker.request(
        'device-pair',
        { deviceId: '1'.repeat(32), deviceName: 'x', platform: 'ios', confirmation: '123456' },
        agent(),
      ),
    ).toEqual({ ok: false, reason: 'not-allowed' })
    expect(
      await t.broker.request(
        'irreversible-call',
        {
          adapterId: 'woolworths',
          adapterHash: HASH_A,
          tool: 'checkout',
          callId: 'c1',
          confirmationId: 'cf_1',
          preview: [],
        },
        agent(),
      ),
    ).toEqual({ ok: false, reason: 'not-allowed' })
    expect(
      await t.broker.request('tool-enable', tool({ scope: 'remote', clientId: 'remote:other' }), agent()),
    ).toEqual({ ok: false, reason: 'not-allowed' })
    expect(
      await t.broker.request('tool-enable', tool({ scope: 'remote', clientId: 'local:claude' }), agent()),
    ).toMatchObject({ ok: true })
  })

  it('keeps an agent note out of requests the app or the person raise', async () => {
    const t = await setup()
    await t.broker.request('tool-enable', tool(), person, 'from the person')
    expect(t.broker.list()[0]?.request.agentNote).toBeNull()
  })

  it('limits each agent to 3 waiting and all agents to 5', async () => {
    const t = await setup()
    for (const name of ['get_a', 'get_b', 'get_c']) await requested(t, tool({ tool: name }))
    expect(await t.broker.request('tool-enable', tool({ tool: 'get_d' }), agent())).toEqual({
      ok: false,
      reason: 'too-many-waiting',
    })
    for (const n of [1, 2]) await requested(t, tool({ tool: 'get_a' }), agent(`a${n}`))
    expect(await t.broker.request('tool-enable', tool(), agent('a8'))).toEqual({
      ok: false,
      reason: 'too-many-total',
    })
    // The person isn't limited.
    expect(await t.broker.request('tool-enable', tool({ tool: 'get_z' }), person)).toMatchObject({ ok: true })
  })

  it('caps the requests an agent makes in a day, withdrawn ones included', async () => {
    const t = await setup()
    for (let n = 0; n < 20; n++) {
      const id = await requested(t, tool({ tool: `get_${n}` }))
      await t.broker.withdraw(id, agent())
      t.advance(60_000)
    }
    expect(await t.broker.request('tool-enable', tool({ tool: 'get_x' }), agent())).toEqual({
      ok: false,
      reason: 'daily-limit',
      until: new Date(T0 + 24 * 3600_000).toISOString(),
    })
    t.advance(24 * 3600_000)
    expect(await t.broker.request('tool-enable', tool({ tool: 'get_x' }), agent())).toMatchObject({
      ok: true,
    })
  })

  it('refuses an agent a local tool request that names a client', async () => {
    const t = await setup()
    expect(await t.broker.request('tool-enable', tool({ clientId: 'local:claude' }), agent())).toEqual({
      ok: false,
      reason: 'not-allowed',
    })
  })

  it('refuses an agent for an hour after 3 declines within an hour', async () => {
    const t = await setup()
    for (const name of ['get_a', 'get_b', 'get_c']) {
      const id = await requested(t, tool({ tool: name }))
      t.advance(60_000)
      expect(await t.broker.decline(id, { via: 'mac' })).toBe(true)
    }
    const refused = await t.broker.request('tool-enable', tool({ tool: 'get_d' }), agent())
    expect(refused).toEqual({
      ok: false,
      reason: 'cooling-down',
      until: new Date(T0 + 3 * 60_000 + 3600_000).toISOString(),
    })
    expect(await t.broker.request('tool-enable', tool({ tool: 'get_d' }), agent('other'))).toMatchObject({
      ok: true,
    })
    t.advance(3600_000)
    expect(await t.broker.request('tool-enable', tool({ tool: 'get_d' }), agent())).toMatchObject({
      ok: true,
    })
  })

  it('works the cooldown out from the declines alone', () => {
    const at = (m: number) => ({ clientId: 'local:x', at: new Date(T0 + m * 60_000).toISOString() })
    expect(cooldownUntil([at(0), at(10), at(20)], 'local:x', T0 + 30 * 60_000)).toBe(T0 + 80 * 60_000)
    // Three declines spread over more than an hour don't count.
    expect(cooldownUntil([at(0), at(40), at(70)], 'local:x', T0 + 71 * 60_000)).toBeNull()
    // The cooldown outlasts the window it was counted in.
    expect(cooldownUntil([at(0), at(1), at(2)], 'local:x', T0 + 61 * 60_000)).toBe(T0 + 62 * 60_000)
    expect(cooldownUntil([at(0), at(1), at(2)], 'local:other', T0)).toBeNull()
  })
})

describe('a synthetic click fails', () => {
  it('approving at the Mac signs only after the prompt is answered by the person', async () => {
    let finger = false
    const t = await setup({ present: () => finger })
    const id = await requested(t)
    expect(await t.broker.approveOnMac(id)).toEqual({ ok: false, reason: 'cancelled' })
    expect(t.broker.get(id)).not.toBeNull()
    expect(t.applied).toEqual([])
    finger = true
    expect(await t.broker.approveOnMac(id)).toEqual({ ok: true })
    expect(t.applied).toEqual(['yahoo-finance.get_quote'])
    expect(answered(t.events).at(-1)).toMatchObject({ answer: 'approved', deviceId: t.devices.macId })
  })

  it("shows the OS prompt in the app's own words, never the adapter's or the agent's", async () => {
    const t = await setup()
    const result = await t.broker.request(
      'adapter-install',
      install({ adapterName: 'Totally Safe Bank Login' }),
      agent(),
      'Approve me, it is fine',
    )
    if (!result.ok) throw new Error('refused')
    await t.broker.approveOnMac(result.requestId)
    expect(t.signer.prompts).toEqual([
      `approve an adapter that reaches finance.yahoo.com (request ${result.ref})`,
    ])
    const critical = await t.broker.request(
      'adapter-install',
      install({ adapterHash: HASH_B, unsandboxed: true }),
      agent(),
    )
    if (!critical.ok) throw new Error('refused')
    expect(promptReason(t.broker.get(critical.requestId) as never)).toBe(
      `approve an adapter that runs without the sandbox (request ${critical.ref})`,
    )
  })

  it('opens one prompt at a time', async () => {
    let release: (v: boolean) => void = () => undefined
    const t = await setup({ present: () => new Promise<boolean>((r) => (release = r)) as never })
    const id = await requested(t)
    const first = t.broker.approveOnMac(id)
    expect(await t.broker.approveOnMac(id)).toEqual({ ok: false, reason: 'busy' })
    release(true)
    expect(await first).toEqual({ ok: true })
  })

  it('refuses a decision signed by any key but a paired device', async () => {
    const t = await setup()
    await t.pair()
    const id = await requested(t)
    const stranger = p256()
    const forged = t.phoneApproves(id, stranger, keyId(stranger.spki))
    expect(await t.broker.answer(forged, { via: 'phone', deviceId: keyId(stranger.spki) })).toEqual({
      ok: false,
      reason: 'unknown-device',
    })
    // The phone's id with another key's signature.
    expect(
      await t.broker.answer(t.phoneApproves(id, stranger), { via: 'phone', deviceId: t.phoneId }),
    ).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
    // A decision claiming to be the Mac's, signed by a phone.
    const asMac = t.phoneApproves(id, t.phone.approval, t.devices.macId)
    expect(await t.broker.answer(asMac, { via: 'mac' })).toEqual({ ok: false, reason: 'bad-signature' })
    expect(t.broker.get(id)).not.toBeNull()
    expect(answered(t.events).map((e) => e.answer)).toEqual(['refused', 'refused', 'refused'])
  })

  it('refuses a phone relaying another device’s valid signature', async () => {
    const t = await setup()
    await t.pair()
    const id = await requested(t)
    const macSigned = await (async () => {
      const request = t.broker.get(id)
      const payload = decisionPayload({
        v: 1,
        decision: 'approve',
        macId: t.devices.macId,
        requestId: id,
        requestDigest: request?.digest as string,
        deviceId: t.devices.macId,
        decidedAt: new Date(T0).toISOString(),
      })
      return {
        payload,
        signature: (await t.signer.sign(SIGNING_DOMAINS.approvalDecision, payload, 'x')) as string,
      }
    })()
    expect(await t.broker.answer(macSigned, { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'wrong-device',
    })
  })

  it('lets a phone approve, but not a Mac-only kind', async () => {
    const t = await setup()
    await t.pair()
    const id = await requested(t)
    expect(await t.broker.answer(t.phoneApproves(id), { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: true,
    })
    const critical = await t.broker.request('adapter-install', install({ unsandboxed: true }), agent())
    if (!critical.ok) throw new Error('refused')
    expect(t.sent.filter((s) => s.message.type === 'approval-request')).toHaveLength(1)
    expect(
      await t.broker.answer(t.phoneApproves(critical.requestId), { via: 'phone', deviceId: t.phoneId }),
    ).toEqual({ ok: false, reason: 'not-allowed-on-device' })
  })

  it('refuses a revoked phone', async () => {
    const t = await setup()
    await t.pair()
    const id = await requested(t)
    await t.devices.revoke(t.phoneId, 'mac-ui', new Date(T0).toISOString())
    expect(await t.broker.answer(t.phoneApproves(id), { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'device-revoked',
    })
    expect(await t.broker.decline(id, { via: 'phone', deviceId: t.phoneId })).toBe(false)
  })

  it('never revokes the Mac', async () => {
    const t = await setup()
    expect(await t.devices.revoke(t.devices.macId, 'mac-ui', new Date(T0).toISOString())).toBe(false)
    expect(t.devices.revokedAt(t.devices.macId)).toBeNull()
  })
})

describe('a replayed approval fails', () => {
  it('counts a signature once', async () => {
    const t = await setup()
    await t.pair()
    const id = await requested(t)
    const signed = t.phoneApproves(id)
    expect(await t.broker.answer(signed, { via: 'phone', deviceId: t.phoneId })).toEqual({ ok: true })
    expect(await t.broker.answer(signed, { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'not-pending',
    })
    expect(t.applied).toHaveLength(1)
  })

  it('refuses a signature over another request', async () => {
    const t = await setup()
    await t.pair()
    const one = await requested(t, tool({ tool: 'get_a' }))
    const two = await requested(t, tool({ tool: 'get_b' }))
    const signed = t.phoneApproves(one)
    const swapped = JSON.parse(signed.payload) as Record<string, unknown>
    swapped['requestId'] = two
    const payload = JSON.stringify(swapped)
    expect(
      await t.broker.answer({ payload, signature: signed.signature }, { via: 'phone', deviceId: t.phoneId }),
    ).toEqual({ ok: false, reason: 'bad-signature' })
    // Signed properly for request two, but over request one's digest.
    const wrongDigest = { ...(JSON.parse(signed.payload) as object), requestId: two }
    const text = JSON.stringify(wrongDigest)
    expect(
      await t.broker.answer(
        { payload: text, signature: signWith(t.phone.approval, SIGNING_DOMAINS.approvalDecision, text) },
        { via: 'phone', deviceId: t.phoneId },
      ),
    ).toEqual({ ok: false, reason: 'wrong-request' })
  })

  it('refuses after expiry, withdrawal or a decline', async () => {
    const t = await setup()
    await t.pair()
    const expiring = await requested(t, tool({ tool: 'get_a' }))
    const signedLate = t.phoneApproves(expiring)
    t.advance(24 * 3600_000)
    expect(await t.broker.answer(signedLate, { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'expired',
    })
    await t.broker.expireDue()
    expect(t.broker.status(expiring, agent())).toMatchObject({ outcome: 'expired' })

    const withdrawn = await requested(t, tool({ tool: 'get_b' }))
    const signedW = t.phoneApproves(withdrawn)
    expect(await t.broker.withdraw(withdrawn, agent())).toBe(true)
    expect(await t.broker.answer(signedW, { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'not-pending',
    })

    const declined = await requested(t, tool({ tool: 'get_c' }))
    const signedD = t.phoneApproves(declined)
    await t.broker.decline(declined, { via: 'mac' })
    expect(await t.broker.answer(signedD, { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'not-pending',
    })
    expect(t.applied).toEqual([])
  })

  it('refuses a decision delivered long after it was signed, or dated ahead', async () => {
    const t = await setup()
    await t.pair()
    const id = await requested(t)
    const held = t.phoneApproves(id)
    t.advance(6 * 60_000)
    expect(await t.broker.answer(held, { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'expired',
    })
    const ahead = t.phoneApproves(id)
    t.advance(-3 * 60_000)
    expect(await t.broker.answer(ahead, { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(await t.broker.answer(t.phoneApproves(id), { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: true,
    })
  })

  it("refuses another Mac's signature", async () => {
    const t = await setup()
    const other = await setup()
    const id = await requested(t)
    const theirs = await requested(other)
    expect(id).toBe(theirs)
    // The other Mac approves its own request with the same id; replayed here it names another Mac.
    const request = other.broker.get(theirs)
    const payload = decisionPayload({
      v: 1,
      decision: 'approve',
      macId: other.devices.macId,
      requestId: theirs,
      requestDigest: request?.digest as string,
      deviceId: other.devices.macId,
      decidedAt: new Date(T0).toISOString(),
    })
    const signature = (await other.signer.sign(SIGNING_DOMAINS.approvalDecision, payload, 'x')) as string
    expect(await t.broker.answer({ payload, signature }, { via: 'mac' })).toEqual({
      ok: false,
      reason: 'unknown-device',
    })
  })

  it('a pending request survives a restart and is still single use', async () => {
    const t = await setup()
    await t.pair()
    const id = await requested(t)
    const signed = t.phoneApproves(id)
    const again = await t.reopen()
    expect(again.broker.get(id)).not.toBeNull()
    expect(await again.broker.answer(signed, { via: 'phone', deviceId: t.phoneId })).toEqual({ ok: true })
    const third = await t.reopen()
    expect(third.broker.get(id)).toBeNull()
    expect(await third.broker.answer(signed, { via: 'phone', deviceId: t.phoneId })).toEqual({
      ok: false,
      reason: 'not-pending',
    })
  })
})

describe('a written file fails', () => {
  async function approvedTool() {
    const t = await setup()
    const id = await requested(t)
    await t.broker.approveOnMac(id)
    expect(t.broker.honoured('tool-enable', (s) => s.tool === 'get_quote')).not.toBeNull()
    return t
  }

  it('honours approved records after a restart', async () => {
    const t = await approvedTool()
    const again = await t.reopen()
    expect(again.broker.tampered).toBeNull()
    expect(again.broker.honoured('tool-enable', (s) => s.tool === 'get_quote')).not.toBeNull()
    expect(again.broker.honoured('tool-enable', (s) => s.tool === 'other')).toBeNull()
  })

  it('locks down and trusts nothing when the file is edited', async () => {
    const t = await approvedTool()
    const text = t.files.files.get(PATH) as string
    t.files.files.set(PATH, text.replace('"pausedRemote":false', '"pausedRemote":true'))
    const again = await t.reopen()
    expect(again.broker.tampered).toBe('mismatch')
    expect(again.broker.isLockedDown()).toBe(true)
    expect(again.broker.honoured('tool-enable', () => true)).toBeNull()
    expect(again.events).toContainEqual({
      type: 'store-refused',
      store: 'trusted',
      reason: 'anchor-mismatch',
      records: 0,
    })
    expect(await again.broker.request('tool-enable', tool(), agent())).toEqual({
      ok: false,
      reason: 'locked-down',
    })
  })

  it('locks down when an old file is put back (a revocation rolled back)', async () => {
    const t = await approvedTool()
    const before = t.files.files.get(PATH) as string
    expect(await t.broker.revoke('tool-enable', () => true)).toBe(1)
    expect(t.broker.honoured('tool-enable', () => true)).toBeNull()
    t.files.files.set(PATH, before)
    const again = await t.reopen()
    expect(again.broker.tampered).toBe('mismatch')
    expect(again.broker.honoured('tool-enable', () => true)).toBeNull()
  })

  it('locks down when the file is deleted after a write', async () => {
    const t = await approvedTool()
    t.files.files.delete(PATH)
    const again = await t.reopen()
    expect(again.broker.tampered).toBe('mismatch')
  })

  it('ignores evidence that was copied onto another subject, even with the anchor moved', async () => {
    const t = await approvedTool()
    // A process that can write both (a dev build): rewrite the evidence's request text.
    const data = structuredClone(t.ledger.data)
    const evidence = data.evidence[0]
    if (evidence === undefined) throw new Error('no evidence')
    evidence.requestText = evidence.requestText.replace('get_quote', 'buy_now_')
    await t.ledger.commit((draft) => {
      draft.evidence = data.evidence
    })
    const again = await t.reopen()
    expect(again.broker.tampered).toBeNull()
    expect(again.broker.honoured('tool-enable', (s) => s.tool === 'buy_now_')).toBeNull()
    expect(again.events).toContainEqual({
      type: 'store-refused',
      store: 'trusted',
      reason: 'evidence',
      records: 1,
    })
  })

  it('ignores a pending request added to the file and anchor for another Mac', async () => {
    const t = await setup()
    const other = await setup()
    await requested(other)
    const text = other.ledger.data.pending[0]?.requestText as string
    await t.ledger.commit((draft) => {
      draft.pending.push({ requestText: text })
    })
    const again = await t.reopen()
    expect(again.broker.list()).toEqual([])
  })

  it('recovers a write the app crashed in the middle of', async () => {
    const t = await approvedTool()
    const state = await t.anchor.read('trusted')
    // Phase one happened and the file was written; the commit didn't.
    const text = t.files.files.get(PATH) as string
    const next = text.replace('"lockdown":false', '"lockdown":true')
    const { sha256Hex } = await import('@valet/core')
    await t.anchor.write('trusted', { ...(state as AnchorState), next: sha256Hex(next) })
    t.files.files.set(PATH, next)
    const again = await t.reopen()
    expect(again.broker.tampered).toBeNull()
    expect(again.broker.isLockedDown()).toBe(true)
    expect((await t.anchor.read('trusted'))?.next).toBeNull()
  })

  it('locks down when a write was begun and the old file is back, keeping what was committed', async () => {
    const t = await approvedTool()
    await t.pair()
    const state = await t.anchor.read('trusted')
    await t.anchor.write('trusted', { ...(state as AnchorState), next: 'f'.repeat(64) })
    const again = await t.reopen()
    expect(again.broker.tampered).toBe('interrupted')
    expect(again.broker.isLockedDown()).toBe(true)
    expect(again.devices.isActivePhone(t.phoneId)).toBe(true)
    const resume = await again.broker.request('resume', { from: 'lockdown' }, person)
    if (!resume.ok) throw new Error('refused')
    expect(await again.broker.approveOnMac(resume.requestId)).toEqual({ ok: true })
    const third = await t.reopen()
    expect(third.broker.tampered).toBeNull()
    expect(third.devices.isActivePhone(t.phoneId)).toBe(true)
  })

  it('a commit that fails after the file is in place still counts', async () => {
    const t = await setup()
    const id = await requested(t)
    const anchor = t.anchor
    const write = anchor.write.bind(anchor)
    let failing = 0
    anchor.write = async (store, state) => {
      if (state.next === null && failing > 0) {
        failing--
        throw new Error('keychain busy')
      }
      return write(store, state)
    }
    failing = 2
    expect(await t.broker.approveOnMac(id)).toEqual({ ok: true })
    expect((await anchor.read('trusted'))?.next).not.toBeNull()
    // The next write completes the commit first.
    await requested(t, tool({ tool: 'get_b' }))
    const again = await t.reopen()
    expect(again.broker.tampered).toBeNull()
    expect(again.broker.honoured('tool-enable', (s) => s.tool === 'get_quote')).not.toBeNull()
    expect(again.broker.list()).toHaveLength(1)
  })

  it('approves nothing when the ledger write fails', async () => {
    const t = await setup()
    const id = await requested(t)
    t.files.failWrites = true
    expect(await t.broker.approveOnMac(id)).toEqual({ ok: false, reason: 'unavailable' })
    expect(t.applied).toEqual([])
    expect(t.broker.get(id)).not.toBeNull()
    t.files.failWrites = false
    expect(await t.broker.approveOnMac(id)).toEqual({ ok: true })
  })

  it('a failed write still tightens in memory', async () => {
    const t = await approvedTool()
    t.files.failWrites = true
    await expect(t.broker.revoke('tool-enable', () => true)).rejects.toThrow()
    expect(t.broker.honoured('tool-enable', () => true)).toBeNull()
    await t.broker.lockdown()
    expect(t.broker.isLockedDown()).toBe(true)
  })

  it('refuses a phone record the Mac never signed', async () => {
    const t = await setup()
    const keys = { approval: p256(), transport: p256(), agreement: p256() }
    const payload = JSON.stringify({
      v: 1,
      deviceId: keyId(keys.approval.spki),
      macId: t.devices.macId,
      role: 'phone',
      platform: 'ios',
      name: 'Attacker',
      approvalKey: keys.approval.spki,
      transportKey: keys.transport.spki,
      agreementKey: keys.agreement.spki,
      pairedAt: new Date(T0).toISOString(),
    })
    const selfSigned = { payload, signature: signWith(keys.approval, SIGNING_DOMAINS.deviceRecord, payload) }
    await expect(t.devices.add(selfSigned)).rejects.toThrow()
    // Written straight into the ledger, it still isn't a device.
    await t.ledger.commit((draft) => {
      draft.devices.push(selfSigned)
    })
    expect(t.devices.device(keyId(keys.approval.spki))).toBeNull()
  })
})

describe('the rest of a request’s life', () => {
  it('withdraws a request whose subject changed before it was approved', async () => {
    let current = HASH_A
    const t = await setup({
      handlers: {
        'tool-enable': { precheck: (s) => s.adapterHash === current, apply: async () => undefined },
      },
    })
    const id = await requested(t)
    current = HASH_B
    expect(await t.broker.approveOnMac(id)).toEqual({ ok: false, reason: 'stale' })
    expect(t.broker.status(id, agent())).toMatchObject({ outcome: 'withdrawn', reason: 'stale' })
    expect(t.broker.honoured('tool-enable', () => true)).toBeNull()
  })

  it('keeps one approved hash per adapter', async () => {
    const t = await setup()
    const first = await t.broker.request('adapter-install', install(), agent())
    if (!first.ok) throw new Error('refused')
    await t.broker.approveOnMac(first.requestId)
    const second = await t.broker.request(
      'adapter-install',
      install({ adapterHash: HASH_B, previousHash: HASH_A }),
      agent(),
    )
    if (!second.ok) throw new Error('refused')
    await t.broker.approveOnMac(second.requestId)
    expect(t.broker.honoured('adapter-install', (s) => s.adapterHash === HASH_A)).toBeNull()
    expect(t.broker.honoured('adapter-install', (s) => s.adapterHash === HASH_B)).not.toBeNull()
  })

  it('withdraws only the asker’s own requests', async () => {
    const t = await setup()
    const id = await requested(t)
    expect(await t.broker.withdraw(id, agent('other'))).toBe(false)
    expect(t.broker.status(id, agent('other'))).toBeNull()
    expect(t.broker.status(id, agent())).toEqual({ state: 'pending' })
    expect(await t.broker.withdraw(id, agent())).toBe(true)
  })

  it('expires on its timer and tells waiters', async () => {
    const t = await setup()
    const id = await requested(t)
    const waiting = t.broker.wait(id)
    t.advance(24 * 3600_000)
    t.timers.fire()
    expect(await waiting).toMatchObject({ outcome: 'expired', deviceId: null })
    expect(t.ledger.data.pending).toEqual([])
  })

  it('keeps an irreversible call in memory only', async () => {
    const t = await setup()
    const result = await t.broker.request(
      'irreversible-call',
      {
        adapterId: 'woolworths',
        adapterHash: HASH_A,
        tool: 'checkout',
        callId: 'call_1',
        confirmationId: 'cf_1',
        preview: ['3 items'],
      },
      app,
    )
    if (!result.ok) throw new Error('refused')
    expect(result.expiresAt).toBe(new Date(T0 + 120_000).toISOString())
    expect(t.ledger.data.pending).toEqual([])
    expect(await t.broker.approveOnMac(result.requestId)).toEqual({ ok: true })
    expect(t.ledger.data.evidence).toEqual([])
  })

  it('lockdown withdraws everything and refuses new requests until a resume is approved', async () => {
    const t = await setup()
    const id = await requested(t)
    await t.broker.lockdown()
    expect(t.broker.status(id, agent())).toMatchObject({ outcome: 'withdrawn', reason: 'lockdown' })
    expect(await t.broker.request('tool-enable', tool(), agent())).toEqual({
      ok: false,
      reason: 'locked-down',
    })
    const resume = await t.broker.request('resume', { from: 'lockdown' }, person)
    if (!resume.ok) throw new Error('refused')
    expect(await t.broker.approveOnMac(resume.requestId)).toEqual({ ok: true })
    expect(t.broker.isLockedDown()).toBe(false)
    expect((await t.reopen()).broker.isLockedDown()).toBe(false)
  })

  it('only the Mac can undo a lockdown, and nothing else is approved while locked', async () => {
    const t = await setup()
    await t.pair()
    const id = await requested(t)
    const signed = t.phoneApproves(id)
    // Queued behind the lockdown: the approval lands after it and is refused.
    const lock = t.broker.lockdown()
    const late = t.broker.answer(signed, { via: 'phone', deviceId: t.phoneId })
    await lock
    expect(await late).toEqual({ ok: false, reason: 'not-pending' })
    const resume = await t.broker.request('resume', { from: 'lockdown' }, person)
    if (!resume.ok) throw new Error('refused')
    expect(
      await t.broker.answer(t.phoneApproves(resume.requestId), { via: 'phone', deviceId: t.phoneId }),
    ).toEqual({
      ok: false,
      reason: 'not-allowed-on-device',
    })
    expect(t.broker.isLockedDown()).toBe(true)
  })

  it('lockdown drops remote clients and authoring sessions for good', async () => {
    const t = await setup()
    const consent = await t.broker.request(
      'remote-client',
      { clientId: 'remote:abc', host: 'claude.ai', sourceAddress: null, tools: [] },
      app,
      { consentCode: 'ABCD-EFGH' },
    )
    if (!consent.ok) throw new Error('refused')
    expect(await t.broker.approveOnMac(consent.requestId, { typedCode: 'abcdefgh' })).toEqual({ ok: true })
    const kept = await requested(t)
    await t.broker.approveOnMac(kept)
    expect(t.broker.honoured('remote-client', () => true)).not.toBeNull()
    await t.broker.lockdown()
    expect(t.broker.honoured('remote-client', () => true)).toBeNull()
    expect(t.broker.honoured('tool-enable', () => true)).not.toBeNull()
  })

  it('a resume after tampering starts a fresh, anchored ledger', async () => {
    const t = await setup()
    await requested(t)
    t.files.files.set(PATH, '{}')
    const again = await t.reopen()
    expect(again.broker.tampered).toBe('mismatch')
    const resume = await again.broker.request('resume', { from: 'lockdown' }, person)
    if (!resume.ok) throw new Error('refused')
    expect(await again.broker.approveOnMac(resume.requestId)).toEqual({ ok: true })
    const third = await t.reopen()
    expect(third.broker.tampered).toBeNull()
    expect(third.broker.isLockedDown()).toBe(false)
    expect(third.broker.list()).toEqual([])
  })

  it('revoking a client withdraws its requests', async () => {
    const t = await setup()
    await requested(t)
    await requested(t, tool(), agent('other'))
    expect(await t.broker.withdrawClient('local:claude')).toBe(1)
    expect(t.broker.list()).toHaveLength(1)
  })
})

describe('the phone inbox', () => {
  async function inbox() {
    const t = await setup()
    await t.pair()
    const calls: string[] = []
    const box = new PhoneInbox(t.broker, t.devices, {
      pauseRemote: async (by) => void calls.push(`pause ${by}`),
      lockdown: async (by) => void calls.push(`lockdown ${by}`),
      revokeClient: async (id) => void calls.push(`revoke-client ${id}`),
      revokeDevice: async (id) => void calls.push(`revoke-device ${id}`),
    })
    return { ...t, box, calls }
  }

  it('passes a decision and a decline on to the broker', async () => {
    const t = await inbox()
    const id = await requested(t)
    const decision = t.phoneApproves(id)
    expect(
      await t.box.receive(t.phoneId, JSON.stringify({ type: 'approval-decision', seq: 1, decision })),
    ).toEqual({ handled: 'decision', result: { ok: true } })
    const other = await requested(t, tool({ tool: 'get_b' }))
    expect(
      await t.box.receive(t.phoneId, JSON.stringify({ type: 'approval-decline', seq: 2, requestId: other })),
    ).toEqual({ handled: 'decline', declined: true })
  })

  it('drops messages from unknown or revoked phones, and anything malformed', async () => {
    const t = await inbox()
    expect(await t.box.receive('9'.repeat(32), '{}')).toEqual({ handled: 'dropped', why: 'unknown-device' })
    expect(await t.box.receive(t.phoneId, 'not json')).toEqual({ handled: 'dropped', why: 'malformed' })
    expect(await t.box.receive(t.phoneId, JSON.stringify({ type: 'approve-all', seq: 1 }))).toEqual({
      handled: 'dropped',
      why: 'malformed',
    })
    await t.devices.revoke(t.phoneId, 'mac-ui', new Date(T0).toISOString())
    expect(
      await t.box.receive(
        t.phoneId,
        JSON.stringify({ type: 'command', seq: 3, command: { kind: 'lockdown' } }),
      ),
    ).toEqual({ handled: 'dropped', why: 'unknown-device' })
    expect(t.calls).toEqual([])
  })

  it('runs tightening commands, and never revokes the Mac', async () => {
    const t = await inbox()
    for (const [seq, command] of [
      { kind: 'pause-remote' },
      { kind: 'lockdown' },
      { kind: 'revoke-client', clientId: 'remote:abc' },
      { kind: 'revoke-device', deviceId: t.devices.macId },
    ].entries()) {
      await t.box.receive(t.phoneId, JSON.stringify({ type: 'command', seq: seq + 1, command }))
    }
    expect(t.calls).toEqual([`pause ${t.phoneId}`, `lockdown ${t.phoneId}`, 'revoke-client remote:abc'])
  })
})

describe('contracts v2', () => {
  const consent = (clientId = 'remote:abc') =>
    ({ clientId, host: 'claude.ai', sourceAddress: null, tools: [] }) as ApprovalSubject<'remote-client'>

  it('a consent needs the code typed, keeps the code out of the request, and three wrong codes end every consent', async () => {
    const t = await setup()
    expect(await t.broker.request('remote-client', consent(), app)).toEqual({
      ok: false,
      reason: 'not-allowed',
    })
    const one = await t.broker.request('remote-client', consent('remote:one'), app, {
      consentCode: 'ABCD-EFGH',
    })
    const two = await t.broker.request('remote-client', consent('remote:two'), app, {
      consentCode: 'JKLM-NPQR',
    })
    if (!one.ok || !two.ok) throw new Error('refused')
    expect(t.broker.get(one.requestId)?.text).not.toContain('ABCD')
    expect(await t.broker.approveOnMac(one.requestId)).toEqual({ ok: false, reason: 'wrong-code' })
    expect(await t.broker.approveOnMac(one.requestId, { typedCode: 'JKLMNPQR' })).toEqual({
      ok: false,
      reason: 'wrong-code',
    })
    expect(t.broker.list()).toHaveLength(2)
    expect(await t.broker.approveOnMac(two.requestId, { typedCode: 'ABCDEFGH' })).toEqual({
      ok: false,
      reason: 'wrong-code',
    })
    expect(t.broker.list()).toEqual([])
    expect(t.broker.status(two.requestId, app)).toMatchObject({ outcome: 'withdrawn', reason: 'wrong-codes' })
  })

  it('keeps consents in their own bucket, and drops them on a restart', async () => {
    const t = await setup()
    for (let n = 0; n < 5; n++) {
      expect(
        await t.broker.request('remote-client', consent(`remote:c${n}`), app, { consentCode: 'ABCD-EFGH' }),
      ).toMatchObject({ ok: true })
    }
    expect(
      await t.broker.request('remote-client', consent('remote:c9'), app, { consentCode: 'ABCD-EFGH' }),
    ).toEqual({
      ok: false,
      reason: 'too-many-consents',
    })
    // Agents' requests are counted apart.
    expect(await t.broker.request('tool-enable', tool(), agent())).toMatchObject({ ok: true })
    const again = await t.reopen()
    expect(again.broker.list().map((r) => r.request.kind)).toEqual(['tool-enable'])
  })

  it('signs the choice the person made on a setting card', async () => {
    const t = await setup()
    const store = await t.broker.request(
      'setting',
      {
        scope: 'adapter',
        adapterId: 'woolworths',
        setting: 'store',
        label: 'Store',
        from: 'None',
        to: 'Chosen on the card',
        choices: [
          { value: '1234', label: 'Bondi Junction' },
          { value: '5678', label: 'Surry Hills' },
        ],
      },
      agent(),
    )
    if (!store.ok) throw new Error('refused')
    expect(await t.broker.approveOnMac(store.requestId, { choice: '9999' })).toEqual({
      ok: false,
      reason: 'bad-choice',
    })
    expect(await t.broker.approveOnMac(store.requestId, { choice: '5678' })).toEqual({ ok: true })
    const evidence = t.broker.honoured('setting', (s) => s.setting === 'store')
    expect(JSON.parse(evidence?.decision.payload ?? '{}')).toMatchObject({ choice: '5678' })
  })

  it('signs the context and display the Mac adds', async () => {
    const t = await setup()
    const result = await t.broker.request('tool-enable', tool(), agent(), {
      agentNote: 'for the repair',
      context: { kind: 'repair', repairId: 'R-4E1C' },
      display: { because: 'Repair R-4E1C', domain: 'yahoo.com' },
    })
    if (!result.ok) throw new Error('refused')
    expect(t.broker.get(result.requestId)?.request).toMatchObject({
      agentNote: 'for the repair',
      context: { kind: 'repair', repairId: 'R-4E1C' },
      display: { because: 'Repair R-4E1C' },
    })
  })

  it('lets an agent ask for a private network address', async () => {
    const t = await setup()
    const result = await t.broker.request(
      'private-network',
      { adapterId: 'home-hub', draftId: 'd1', address: '192.168.1.20', port: 8080, minutes: 30 },
      agent(),
    )
    if (!result.ok) throw new Error('refused')
    expect(promptReason(t.broker.get(result.requestId) as never)).toBe(
      `let an agent's scratch browser reach your home network (192.168.1.20 port 8080) (request ${result.ref})`,
    )
  })

  it('passes a decline note to the agent, which pauses it only when the person says stop asking', async () => {
    const t = await setup()
    for (const name of ['get_a', 'get_b', 'get_c']) {
      const id = await requested(t, tool({ tool: name }))
      await t.broker.decline(id, { via: 'mac' }, { note: 'query1 is enough' })
      expect(t.broker.status(id, agent())).toMatchObject({ outcome: 'declined', note: 'query1 is enough' })
    }
    expect(await t.broker.request('tool-enable', tool({ tool: 'get_d' }), agent())).toMatchObject({
      ok: true,
    })
    const id = await requested(t, tool({ tool: 'get_e' }))
    await t.broker.decline(id, { via: 'mac' }, { note: 'no more', stopAsking: true })
    expect(await t.broker.request('tool-enable', tool({ tool: 'get_f' }), agent())).toMatchObject({
      ok: false,
      reason: 'cooling-down',
    })
  })
})
