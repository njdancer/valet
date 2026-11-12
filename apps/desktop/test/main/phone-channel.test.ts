// The Mac's end of the phone channel (docs/phone-channel.md): a phone written here with core's
// primitives pairs through it, gets a card sealed to its key, approves and declines, and gets what
// was waiting when it comes back online. The relay is a list of frames.

import { diffieHellman, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AuditEvent,
  type AuditRecord,
  decisionPayload,
  type Envelope,
  keyId,
  type MacToRelay,
  openEnvelope,
  openSealed,
  pairingAad,
  pairingCode,
  pairingOfferId,
  pairingSealKey,
  SIGNING_DOMAINS,
  sealEnvelope,
  sealPairing,
  signingInput,
  verifyDeviceRecord,
  verifyPairingChallenge,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  AnchoredFile,
  ApprovalBroker,
  DeviceStore,
  type FileOps,
  MemoryAnchor,
  PAIRING_QR_PREFIX,
  PhoneChannel,
  PhoneInbox,
  SoftwareSigner,
  TrustedLedger,
} from '../../src/main/core/approvals'

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
const tick = () => new Promise((r) => setTimeout(r, 20))

async function setup() {
  const signer = new SoftwareSigner(() => true)
  const keys = await signer.keys()
  const ledger = await TrustedLedger.open(
    new AnchoredFile('/t.json', 'trusted', new MemoryAnchor(), new MemoryFiles()),
  )
  const devices = new DeviceStore(ledger, keys)
  const frames: MacToRelay[] = []
  let online = true
  const link = {
    send: (frame: Exclude<MacToRelay, { type: 'hello' }>) => {
      if (!online) return false
      frames.push(frame)
      return true
    },
  }
  const events: AuditEvent[] = []
  let channel: PhoneChannel | null = null
  const broker = await ApprovalBroker.open({
    ledger,
    devices,
    signer,
    audit: { append: async (e: AuditEvent) => (events.push(e), { event: e } as unknown as AuditRecord) },
    handlers: {
      'tool-enable': { apply: async () => undefined },
      'device-pair': { apply: async () => undefined },
    },
    outbox: { send: (id, m) => channel?.send(id, m) },
  })
  const inbox = new PhoneInbox(broker, devices, {
    pauseRemote: async () => undefined,
    lockdown: async () => undefined,
    revokeClient: async () => undefined,
    revokeDevice: async () => undefined,
  })
  channel = await PhoneChannel.open({
    devices,
    keys,
    channel: signer.channel,
    relayOrigin: 'https://relay.test',
    link,
    receive: (from, text) => inbox.receive(from, text),
    approvePairing: async (pair) => {
      const asked = await broker.request('device-pair', { ...pair, platform: 'ios' }, { kind: 'person' })
      if (!asked.ok) return false
      return (await broker.approveOnMac(asked.requestId)).ok
    },
    paired: async (r) => void events.push({ type: 'device-paired', deviceId: r.deviceId, platform: 'ios' }),
    macName: 'Test Mac',
    statePath: join(mkdtempSync(join(tmpdir(), 'channel-')), 'phone-channel.json'),
  })
  return { signer, keys, devices, broker, channel, frames, events, setOnline: (v: boolean) => (online = v) }
}

/** A phone, as the iPhone app does it. */
function phone() {
  const approval = p256()
  const transport = p256()
  const agreement = p256()
  const deviceId = keyId(approval.spki)
  const agree = async (peer: KeyObject) =>
    diffieHellman({ privateKey: agreement.privateKey, publicKey: peer })
  return { approval, transport, agreement, deviceId, agree }
}

async function pair(t: Awaited<ReturnType<typeof setup>>, p = phone()) {
  const scan = t.channel.startPairing()
  if (scan.step !== 'scan') throw new Error(scan.step)
  expect(scan.qr.startsWith(PAIRING_QR_PREFIX)).toBe(true)
  const offerText = Buffer.from(scan.qr.slice(PAIRING_QR_PREFIX.length), 'base64url').toString()
  const offer = JSON.parse(offerText)
  const offerId = pairingOfferId(offer.secret)
  expect(t.frames.at(-1)).toMatchObject({ type: 'pairing-open', offerId })
  const reply = JSON.stringify({
    v: 1,
    deviceName: "Riley's iPhone",
    platform: 'ios',
    approvalKey: p.approval.spki,
    transportKey: p.transport.spki,
    agreementKey: p.agreement.spki,
  })
  const key = pairingSealKey(offer.secret, offer.macId)
  t.channel.handle({
    type: 'pairing-reply',
    offerId,
    sealed: sealPairing(key, reply, pairingAad('reply', offerId)),
  })
  await tick()
  const challenge = t.frames.findLast((f) => f.type === 'pairing-challenge')
  if (challenge?.type !== 'pairing-challenge') throw new Error('no challenge')
  expect(
    verifyPairingChallenge(offer.macApprovalKey, offerId, challenge.macNonce, reply, challenge.signature),
  ).toBe(true)
  const code = pairingCode(offer.secret, offer.macId, offerText, reply, challenge.macNonce)
  const confirm = t.channel.pairing
  if (confirm.step !== 'confirm') throw new Error(confirm.step)
  expect(confirm.codes).toHaveLength(3)
  expect(confirm.codes).toContain(code)
  return { p, offer, offerId, key, code, confirm }
}

function lastEnvelopes(t: Awaited<ReturnType<typeof setup>>, to: string): Envelope[] {
  return t.frames.flatMap((f) => (f.type === 'envelope' && f.envelope.to === to ? [f.envelope] : []))
}

async function openAll(t: Awaited<ReturnType<typeof setup>>, p: ReturnType<typeof phone>) {
  const out: Record<string, unknown>[] = []
  for (const e of lastEnvelopes(t, p.deviceId)) {
    const text = await openEnvelope(
      e,
      {
        from: t.keys.agreementKey === '' ? '' : t.devices.macId,
        to: p.deviceId,
        senderKey: t.keys.agreementKey,
        recipientKey: p.agreement.spki,
      },
      p.agree,
    )
    if (text !== null) out.push(JSON.parse(text))
  }
  return out
}

async function fromPhone(t: Awaited<ReturnType<typeof setup>>, p: ReturnType<typeof phone>, message: object) {
  const envelope = await sealEnvelope(
    JSON.stringify(message),
    { from: p.deviceId, to: t.devices.macId, senderKey: p.agreement.spki, recipientKey: t.keys.agreementKey },
    p.agree,
  )
  t.channel.handle({ type: 'envelope', envelope })
  await t.channel.settled()
  await tick()
}

describe('the phone channel', () => {
  it('pairs a phone: the right code and Touch ID give it signed records, sealed to its QR', async () => {
    const t = await setup()
    const { p, offerId, key, code } = await pair(t)
    expect(await t.channel.confirmPairing(code)).toMatchObject({ step: 'paired', deviceId: p.deviceId })
    expect(t.devices.isActivePhone(p.deviceId)).toBe(true)
    expect(t.frames).toContainEqual({
      type: 'device-register',
      deviceId: p.deviceId,
      transportKey: p.transport.spki,
    })
    const result = t.frames.findLast((f) => f.type === 'pairing-result')
    if (result?.type !== 'pairing-result') throw new Error('no result')
    const opened = JSON.parse(openSealed(key, result.sealed, pairingAad('result', offerId)) as string)
    expect(opened.outcome).toBe('paired')
    expect(verifyDeviceRecord(opened.deviceRecord, t.keys.approvalKey)).toMatchObject({ ok: true })
    expect(verifyDeviceRecord(opened.macRecord, t.keys.approvalKey)).toMatchObject({
      ok: true,
      record: { role: 'mac' },
    })
    expect(t.events.map((e) => e.type)).toContain('device-paired')
  })

  it('a wrong code counts; three abandon the offer; None of these declines', async () => {
    const t = await setup()
    const { confirm, code } = await pair(t)
    const wrong = confirm.codes.find((c) => c !== code) as string
    expect(await t.channel.confirmPairing(wrong)).toMatchObject({ step: 'confirm', attemptsLeft: 2 })
    await t.channel.confirmPairing(wrong)
    expect(await t.channel.confirmPairing(wrong)).toEqual({ step: 'failed', why: 'too-many-attempts' })
    const again = await pair(t)
    expect(await t.channel.confirmPairing(null)).toEqual({ step: 'failed', why: 'declined' })
    expect(t.devices.isActivePhone(again.p.deviceId)).toBe(false)
  })

  it('sends a card sealed to the phone, takes its signed approval, and closes the card', async () => {
    const t = await setup()
    const { p, code } = await pair(t)
    await t.channel.confirmPairing(code)
    const asked = await t.broker.request(
      'tool-enable',
      {
        adapterId: 'gumleaf',
        adapterHash: 'a'.repeat(64),
        tool: 'search',
        scope: 'local',
        clientId: null,
        sideEffect: 'read',
      },
      { kind: 'agent', clientId: 'local:claude', clientName: 'Claude Code' },
    )
    if (!asked.ok) throw new Error(asked.reason)
    await tick()
    const messages = await openAll(t, p)
    const card = messages.find((m) => m['type'] === 'approval-request') as {
      requestText: string
      seq: number
    }
    expect(card).toBeDefined()
    expect(t.frames).toContainEqual({ type: 'push', deviceId: p.deviceId, kind: 'needs-you' })
    const request = t.broker.get(asked.requestId)
    const payload = decisionPayload({
      v: 1,
      decision: 'approve',
      macId: t.devices.macId,
      requestId: asked.requestId,
      requestDigest: request?.digest as string,
      deviceId: p.deviceId,
      decidedAt: new Date().toISOString(),
    })
    const signature = sign('sha256', signingInput(SIGNING_DOMAINS.approvalDecision, payload), {
      key: p.approval.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    await fromPhone(t, p, { type: 'approval-decision', seq: 1, decision: { payload, signature } })
    expect(await t.broker.wait(asked.requestId)).toMatchObject({ outcome: 'approved', deviceId: p.deviceId })
    const after = await openAll(t, p)
    expect(after).toContainEqual(expect.objectContaining({ type: 'ack', ackSeq: 1 }))
    expect(after).toContainEqual(
      expect.objectContaining({ type: 'approval-closed', requestId: asked.requestId, outcome: 'approved' }),
    )
  })

  it('holds a gap, and resends what is unacked when the phone comes back', async () => {
    const t = await setup()
    const { p, code } = await pair(t)
    await t.channel.confirmPairing(code)
    const subject = {
      adapterId: 'gumleaf',
      adapterHash: 'a'.repeat(64),
      tool: 'x',
      scope: 'local' as const,
      clientId: null,
      sideEffect: 'read' as const,
    }
    const a = await t.broker.request(
      'tool-enable',
      { ...subject, tool: 'a' },
      { kind: 'agent', clientId: 'local:c', clientName: 'C' },
    )
    const b = await t.broker.request(
      'tool-enable',
      { ...subject, tool: 'b' },
      { kind: 'agent', clientId: 'local:c', clientName: 'C' },
    )
    if (!a.ok || !b.ok) throw new Error('not asked')
    // Seq 2 before seq 1: held, then both taken in order.
    await fromPhone(t, p, { type: 'approval-decline', seq: 2, requestId: b.requestId })
    expect(t.broker.get(b.requestId)).not.toBeNull()
    await fromPhone(t, p, { type: 'approval-decline', seq: 1, requestId: a.requestId })
    expect(t.broker.get(a.requestId)).toBeNull()
    expect(t.broker.get(b.requestId)).toBeNull()
    // The phone comes back: every unacked message is sent again.
    const before = lastEnvelopes(t, p.deviceId).length
    t.channel.handle({ type: 'device-online', deviceId: p.deviceId, online: true })
    await tick()
    expect(lastEnvelopes(t, p.deviceId).length).toBeGreaterThan(before)
  })

  it('ignores envelopes from phones that are not paired', async () => {
    const t = await setup()
    const stranger = phone()
    await fromPhone(t, stranger, { type: 'command', seq: 1, command: { kind: 'lockdown' } })
    expect(lastEnvelopes(t, stranger.deviceId)).toHaveLength(0)
  })
})
