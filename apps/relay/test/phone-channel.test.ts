// The phone channel through the real relay (docs/phone-channel.md): the Mac app's PhoneChannel
// and broker behind the real relay client, a local Workers runtime, and a phone written here that
// speaks the relay's phone frames exactly as the iPhone app does: dial /v1/phone/<macId>, send the
// sealed pairing reply after the challenge, then, once registered, a signed hello.

import { diffieHellman, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type AuditEvent,
  type AuditRecord,
  decisionPayload,
  keyId,
  openEnvelope,
  openSealed,
  pairingAad,
  pairingCode,
  pairingOfferId,
  pairingSealKey,
  relayAuthPayload,
  SIGNING_DOMAINS,
  sealEnvelope,
  sealPairing,
  signingInput,
} from '@valet/core'
import { RelayClient } from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
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
} from '../../desktop/src/main/core/approvals'
import { RELAY_ORIGIN, type Runtime, startRelay } from './runtime'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

class MemoryFiles implements FileOps {
  readonly files = new Map<string, string>()
  async read(path: string) {
    return this.files.get(path) ?? null
  }
  async write(path: string, text: string) {
    this.files.set(path, text)
  }
}

async function until<T>(check: () => T | null | undefined | false, ms = 5_000): Promise<T> {
  const where = new Error('timed out').stack
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out ${where}`)
    await delay(20)
  }
}

async function startMac(relay: Runtime) {
  const signer = new SoftwareSigner(() => true)
  const keys = await signer.keys()
  const ledger = await TrustedLedger.open(
    new AnchoredFile('/t.json', 'trusted', new MemoryAnchor(), new MemoryFiles()),
  )
  const devices = new DeviceStore(ledger, keys)
  let channel: PhoneChannel | null = null
  const broker = await ApprovalBroker.open({
    ledger,
    devices,
    signer,
    audit: { append: async (e: AuditEvent) => ({ event: e }) as unknown as AuditRecord },
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
  const binding = await signer.sign(SIGNING_DOMAINS.relayBinding, keys.transportKey, 'bind')
  const client = new RelayClient({
    relay: RELAY_ORIGIN,
    connectUrl: relay.url,
    macId: devices.macId,
    signer: { publicKey: keys.transportKey, sign: (p) => signer.channel.signTransport(p) },
    binding: { approvalKey: keys.approvalKey, signature: binding as string },
    listener: () => null,
    consent: () => ({ state: 'declined' }),
    onEvent: (event) => channel?.handle(event),
    backoff: { minMs: 50, maxMs: 200 },
  })
  channel = await PhoneChannel.open({
    devices,
    keys,
    channel: signer.channel,
    relayOrigin: RELAY_ORIGIN,
    link: client,
    receive: (from, text) => inbox.receive(from, text),
    approvePairing: async (pair) => {
      const asked = await broker.request('device-pair', { ...pair, platform: 'ios' }, { kind: 'person' })
      return asked.ok && (await broker.approveOnMac(asked.requestId)).ok
    },
    paired: async () => undefined,
    macName: 'Test Mac',
    status: () => ({
      at: new Date().toISOString(),
      safety: 'running',
      sites: [],
      agents: [],
      devices: [],
      recent: [],
    }),
    statePath: join(mkdtempSync(join(tmpdir(), 'channel-')), 'phone-channel.json'),
  })
  cleanup.push(() => client.stop())
  client.start()
  await until(() => client.status.state === 'online')
  return { signer, keys, devices, broker, channel, client, macChannel: channel }
}

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
}

/** A phone over a real WebSocket, as the iPhone app speaks to the relay. */
class Phone {
  readonly approval = p256()
  readonly transport = p256()
  readonly agreement = p256()
  readonly deviceId = keyId(this.approval.spki)
  readonly frames: Record<string, unknown>[] = []
  readonly messages: Record<string, unknown>[] = []
  socket: WebSocket | null = null
  private seq = 0
  constructor(
    private readonly relay: Runtime,
    private readonly macId: string,
    private readonly macAgreementKey: string,
  ) {}

  agree = async (peer: KeyObject) => diffieHellman({ privateKey: this.agreement.privateKey, publicKey: peer })

  dial(onChallenge: (nonce: string) => void): Promise<void> {
    const socket = new WebSocket(`${this.relay.url.replace(/^http/, 'ws')}/v1/phone/${this.macId}`)
    this.socket = socket
    cleanup.push(() => socket.close())
    socket.addEventListener('message', (event) => {
      if (event.data === 'pong') return
      const frame = JSON.parse(String(event.data))
      this.frames.push(frame)
      if (frame.type === 'challenge') onChallenge(frame.nonce)
      if (frame.type === 'envelope') void this.open(frame.envelope)
    })
    return new Promise((resolve) => socket.addEventListener('open', () => resolve()))
  }

  hello(nonce: string) {
    const payload = relayAuthPayload({ nonce, relay: RELAY_ORIGIN, role: 'phone', id: this.deviceId })
    const signature = sign('sha256', signingInput(SIGNING_DOMAINS.relayAuth, payload), {
      key: this.transport.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    this.socket?.send(JSON.stringify({ type: 'hello', role: 'phone', id: this.deviceId, signature }))
  }

  private async open(envelope: never) {
    const text = await openEnvelope(
      envelope,
      {
        from: this.macId,
        to: this.deviceId,
        senderKey: this.macAgreementKey,
        recipientKey: this.agreement.spki,
      },
      this.agree,
    )
    if (text !== null) this.messages.push(JSON.parse(text))
  }

  async send(message: Record<string, unknown>) {
    // Acks never take a number: they carry the last seq sent.
    if (message['type'] !== 'ack') this.seq += 1
    const envelope = await sealEnvelope(
      JSON.stringify({ ...message, seq: Math.max(1, this.seq) }),
      {
        from: this.deviceId,
        to: this.macId,
        senderKey: this.agreement.spki,
        recipientKey: this.macAgreementKey,
      },
      this.agree,
    )
    this.socket?.send(JSON.stringify({ type: 'envelope', envelope }))
  }
}

describe('the phone channel through the relay', () => {
  it('pairs a phone, delivers a card, takes its approval, and resends what waited while it was away', async () => {
    const relay = await startRelay()
    cleanup.push(() => relay.close())
    const mac = await startMac(relay)

    // Pairing: the QR, the sealed reply, the challenge, the code, Touch ID, the result.
    const scan = mac.channel.startPairing()
    if (scan.step !== 'scan') throw new Error(scan.step)
    const offerText = Buffer.from(scan.qr.slice(PAIRING_QR_PREFIX.length), 'base64url').toString()
    const offer = JSON.parse(offerText)
    expect(offer.relay).toBe(RELAY_ORIGIN)
    const offerId = pairingOfferId(offer.secret)
    const phone = new Phone(relay, offer.macId, offer.macAgreementKey)
    const reply = JSON.stringify({
      v: 1,
      deviceName: 'Test iPhone',
      platform: 'ios',
      approvalKey: phone.approval.spki,
      transportKey: phone.transport.spki,
      agreementKey: phone.agreement.spki,
    })
    const key = pairingSealKey(offer.secret, offer.macId)
    await delay(100)
    await phone.dial(() => undefined)
    phone.socket?.send(
      JSON.stringify({
        type: 'pairing-reply',
        macId: offer.macId,
        offerId,
        sealed: sealPairing(key, reply, pairingAad('reply', offerId)),
      }),
    )
    const challenge = await until(() => phone.frames.find((f) => f['type'] === 'pairing-challenge'))
    const code = pairingCode(offer.secret, offer.macId, offerText, reply, challenge['macNonce'] as string)
    await until(() => mac.channel.pairing.step === 'confirm')
    expect(await mac.channel.confirmPairing(code)).toMatchObject({ step: 'paired' })
    const result = await until(() => phone.frames.find((f) => f['type'] === 'pairing-result'))
    const opened = JSON.parse(
      openSealed(key, result['sealed'] as never, pairingAad('result', offerId)) as string,
    )
    expect(opened.outcome).toBe('paired')
    phone.socket?.close()

    // The channel: dial again, hello, and the status arrives.
    await phone.dial((nonce) => phone.hello(nonce))
    await until(() => phone.frames.find((f) => f['type'] === 'ready'))
    await until(() => phone.messages.find((m) => m['type'] === 'status'))

    // A card, approved on the phone.
    const subject = {
      adapterId: 'gumleaf',
      adapterHash: 'a'.repeat(64),
      tool: 'search',
      scope: 'local' as const,
      clientId: null,
      sideEffect: 'read' as const,
    }
    const agent = { kind: 'agent' as const, clientId: 'local:claude', clientName: 'Claude Code' }
    const asked = await mac.broker.request('tool-enable', subject, agent)
    if (!asked.ok) throw new Error(asked.reason)
    const card = await until(() => phone.messages.find((m) => m['type'] === 'approval-request'))
    await phone.send({ type: 'ack', ackSeq: card['seq'] })
    const request = mac.broker.get(asked.requestId)
    const payload = decisionPayload({
      v: 1,
      decision: 'approve',
      macId: offer.macId,
      requestId: asked.requestId,
      requestDigest: request?.digest as string,
      deviceId: phone.deviceId,
      decidedAt: new Date().toISOString(),
    })
    const signature = sign('sha256', signingInput(SIGNING_DOMAINS.approvalDecision, payload), {
      key: phone.approval.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    await phone.send({ type: 'approval-decision', decision: { payload, signature } })
    expect(await mac.broker.wait(asked.requestId)).toMatchObject({
      outcome: 'approved',
      deviceId: phone.deviceId,
    })

    // The phone is closed (no push). A request waits; opening the phone delivers it.
    phone.socket?.close()
    await delay(200)
    const later = await mac.broker.request('tool-enable', { ...subject, tool: 'order' }, agent)
    if (!later.ok) throw new Error(later.reason)
    const before = phone.messages.length
    await phone.dial((nonce) => phone.hello(nonce))
    const waiting = await until(() =>
      phone.messages
        .slice(before)
        .find((m) => m['type'] === 'approval-request' && String(m['requestText']).includes(later.requestId)),
    )
    expect(waiting).toBeDefined()
    await phone.send({ type: 'approval-decline', requestId: later.requestId, note: 'Not now' })
    expect(await mac.broker.wait(later.requestId)).toMatchObject({ outcome: 'declined', note: 'Not now' })
  })
})
