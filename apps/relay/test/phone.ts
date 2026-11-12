// A phone written with core's primitives, speaking the relay's phone frames exactly as the iPhone
// app does: dial /v1/phone/<macId>, send the sealed pairing reply after the challenge, then, once
// registered, a signed hello. The relay suite and the desktop end-to-end suite both use it.

import { diffieHellman, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import {
  decisionPayload,
  domainDigest,
  type Envelope,
  keyId,
  openEnvelope,
  pairingAad,
  relayAuthPayload,
  SIGNING_DOMAINS,
  sealEnvelope,
  sealPairing,
  signingInput,
} from '@valet/core'

export function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
}

/** A phone over a real WebSocket, as the iPhone app speaks to the relay. */
export class Phone {
  readonly approval = p256()
  readonly transport = p256()
  readonly agreement = p256()
  readonly deviceId = keyId(this.approval.spki)
  readonly frames: Record<string, unknown>[] = []
  readonly messages: Record<string, unknown>[] = []
  socket: WebSocket | null = null
  private seq = 0
  private lastInbound = 0
  private readonly held = new Map<number, Record<string, unknown>>()
  constructor(
    /** Where to dial: http://127.0.0.1:<port>. */
    private readonly url: string,
    private readonly macId: string,
    private readonly macAgreementKey: string,
    /** The relay's origin, named in its challenges. */
    private readonly origin: string,
    private readonly onClose: (close: () => void) => void = () => undefined,
  ) {}

  agree = async (peer: KeyObject) => diffieHellman({ privateKey: this.agreement.privateKey, publicKey: peer })

  dial(onChallenge: (nonce: string) => void): Promise<void> {
    const socket = new WebSocket(`${this.url.replace(/^http/, 'ws')}/v1/phone/${this.macId}`)
    this.socket = socket
    this.onClose(() => socket.close())
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
    const payload = relayAuthPayload({ nonce, relay: this.origin, role: 'phone', id: this.deviceId })
    const signature = sign('sha256', signingInput(SIGNING_DOMAINS.relayAuth, payload), {
      key: this.transport.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    this.socket?.send(JSON.stringify({ type: 'hello', role: 'phone', id: this.deviceId, signature }))
  }

  private async open(envelope: Envelope) {
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
    if (text === null) return
    // In order, as the iPhone app takes them: a duplicate is ignored, a gap is held until it fills.
    const message = JSON.parse(text) as Record<string, unknown>
    const seq = message['seq']
    if (message['type'] === 'ack' || typeof seq !== 'number') return void this.messages.push(message)
    if (seq <= this.lastInbound) return
    this.held.set(seq, message)
    for (
      let next = this.held.get(this.lastInbound + 1);
      next !== undefined;
      next = this.held.get(this.lastInbound + 1)
    ) {
      this.held.delete(this.lastInbound + 1)
      this.lastInbound += 1
      this.messages.push(next)
    }
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

  /** The sealed pairing reply for an offer, sent on the open socket. */
  sendPairingReply(
    offer: { macId: string; secret: string },
    offerId: string,
    key: Buffer,
    name: string,
  ): string {
    const reply = JSON.stringify({
      v: 1,
      deviceName: name,
      platform: 'ios',
      approvalKey: this.approval.spki,
      transportKey: this.transport.spki,
      agreementKey: this.agreement.spki,
    })
    this.socket?.send(
      JSON.stringify({
        type: 'pairing-reply',
        macId: offer.macId,
        offerId,
        sealed: sealPairing(key, reply, pairingAad('reply', offerId)),
      }),
    )
    return reply
  }

  /** Signs an approval of a request text the Mac sent, as the phone does after Face ID. */
  approve(requestText: string, macId: string) {
    const request = JSON.parse(requestText) as { id: string }
    const payload = decisionPayload({
      v: 1,
      decision: 'approve',
      macId,
      requestId: request.id,
      requestDigest: domainDigest(SIGNING_DOMAINS.approvalRequest, requestText),
      deviceId: this.deviceId,
      decidedAt: new Date().toISOString(),
    })
    const signature = sign('sha256', signingInput(SIGNING_DOMAINS.approvalDecision, payload), {
      key: this.approval.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    return { payload, signature }
  }
}
