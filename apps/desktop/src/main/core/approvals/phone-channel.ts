// The Mac's end of the channel to its phones, over the relay (docs/phone-channel.md). It is the
// broker's PhoneOutbox and the PhoneInbox's source:
//
// - Out: each message gets the next seq for that phone, is kept until the phone acks it, sealed
//   with HPKE auth mode from the Mac's agreement key to the phone's, and sent as an `envelope`
//   frame. Unacked messages go again whenever the phone (or the relay) comes back, which is how a
//   phone that was closed, with no push, gets what is waiting the moment it is opened.
// - In: an envelope is opened only if it is from a paired, unrevoked phone, sealed by the key
//   pinned at pairing. Seqs are taken in order: a duplicate is acked again, a gap is held.
// - Pairing (J1): the QR offer, the sealed reply, the signed challenge, the three codes the Mac
//   shows, the person's pick and Touch ID (`device-pair`), then the signed records back.
//
// Seq counters and unacked messages are kept in a small file, so a restart doesn't make every
// later message look old to the phone. The file isn't trusted for anything: the relay and the
// phone check everything that matters, and a damaged file only delays delivery.

import { randomBytes, randomInt } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import {
  type Agree,
  type DeviceRecord,
  deviceRecordSchema,
  type Envelope,
  envelopeSchema,
  keyId,
  type MacToPhoneMessage,
  type MacToRelay,
  openEnvelope,
  openSealed,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_QR_TTL_MS,
  type PairingReply,
  type PairingResult,
  pairingAad,
  pairingChallengePayload,
  pairingCode,
  pairingOfferId,
  pairingReplySchema,
  pairingSealKey,
  type RelayToMac,
  SIGNING_DOMAINS,
  type SignedText,
  sealEnvelope,
  sealPairing,
  seqVerdict,
} from '@valet/core'
import { z } from 'zod'
import type { MacToPhoneBody, PhoneOutbox } from './broker'
import type { DeviceStore } from './devices'
import type { ChannelKeys, MacKeys } from './signer'

/** What the QR code's text starts with; the phone's scanner passes on only text with it. */
export const PAIRING_QR_PREFIX = 'valet-pair:'

/** Frames for the relay; false if it isn't connected now. */
export interface RelayLink {
  send(frame: Exclude<MacToRelay, { type: 'hello' }>): boolean
}

/** The relay events the channel acts on (RelayClient's onEvent). */
export type ChannelEvent = Extract<
  RelayToMac,
  { type: 'envelope' | 'device-online' | 'ready' | 'pairing-reply' | 'relay-locked' }
>

/** What the Mac's Pair an iPhone sheet shows. */
export type PairingState =
  | { readonly step: 'idle' }
  | { readonly step: 'scan'; readonly qr: string; readonly expiresAt: string }
  /** A phone answered: the person picks the code the phone shows, then approves with Touch ID. */
  | {
      readonly step: 'confirm'
      readonly deviceName: string
      readonly codes: readonly string[]
      readonly attemptsLeft: number
      readonly expiresAt: string
    }
  | { readonly step: 'approving'; readonly deviceName: string }
  | { readonly step: 'paired'; readonly deviceId: string; readonly deviceName: string }
  | {
      readonly step: 'failed'
      readonly why: 'expired' | 'declined' | 'too-many-attempts' | 'cancelled' | 'not-sent' | 'unavailable'
    }

export interface PairApproval {
  readonly deviceId: string
  readonly deviceName: string
  readonly confirmation: string
}

export interface PhoneChannelOptions {
  readonly devices: DeviceStore
  readonly keys: MacKeys
  readonly channel: ChannelKeys
  /** The relay origin, named in the QR code. */
  readonly relayOrigin: string
  readonly link: RelayLink
  /** The phone's opened message, for the PhoneInbox. */
  readonly receive: (from: string, plaintext: string) => Promise<unknown>
  /** Asks the person to approve the pairing (a `device-pair` request, Touch ID). True if approved. */
  readonly approvePairing: (pair: PairApproval) => Promise<boolean>
  /** Audits and announces a new phone. */
  readonly paired: (record: DeviceRecord) => Promise<void>
  /** The Mac's own name, shown on the phone. */
  readonly macName: string
  /** The status message the phone's tabs show, built fresh each time. */
  readonly status?: () => Omit<Extract<MacToPhoneMessage, { type: 'status' }>, 'type' | 'seq'> | undefined
  readonly statePath: string
  readonly now?: () => number
  readonly onChange?: () => void
  readonly log?: (line: string) => void
}

const stateSchema = z
  .object({
    v: z.literal(1),
    phones: z.record(
      z.string(),
      z
        .object({
          nextSeq: z.number().int().min(1),
          lastInbound: z.number().int().min(0),
          outbox: z.array(z.object({ seq: z.number().int().min(1), text: z.string() }).strict()),
        })
        .strict(),
    ),
  })
  .strict()
type ChannelState = z.infer<typeof stateSchema>
type PhoneState = ChannelState['phones'][string]

/** Messages kept for a phone that isn't acking, oldest dropped first (status first of all). */
const OUTBOX_MAX = 200

interface Offer {
  readonly secret: string
  readonly offerId: string
  readonly text: string
  readonly expiresAt: number
  reply: { readonly text: string; readonly parsed: PairingReply; readonly code: string } | null
  attempts: number
}

export class PhoneChannel implements PhoneOutbox {
  private state: ChannelState = { v: 1, phones: {} }
  private readonly held = new Map<string, Map<number, string>>()
  private offer: Offer | null = null
  private pairingState: PairingState = { step: 'idle' }
  private saving: Promise<void> = Promise.resolve()
  private inbound: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly agree: Agree

  private constructor(private readonly options: PhoneChannelOptions) {
    this.now = options.now ?? Date.now
    this.agree = (peer) => options.channel.agree(peer)
  }

  static async open(options: PhoneChannelOptions): Promise<PhoneChannel> {
    const channel = new PhoneChannel(options)
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await readFile(options.statePath, 'utf8')))
      if (parsed.success) channel.state = parsed.data
    } catch {
      // No file yet, or a damaged one: start the counters again. A phone that already saw higher
      // seqs from this Mac will hold these as duplicates until pairing again; the log says so.
    }
    return channel
  }

  get macId(): string {
    return this.options.devices.macId
  }

  get pairing(): PairingState {
    return this.pairingState
  }

  // MARK: Out

  /** The broker's outbox: number, keep and send one message to one phone. */
  send(deviceId: string, message: MacToPhoneBody): void {
    if (!this.options.devices.isActivePhone(deviceId)) return
    const phone = this.phone(deviceId)
    const seq = phone.nextSeq
    phone.nextSeq += 1
    const text = JSON.stringify({ ...message, seq })
    // A newer status replaces any older one still unacked: the phone shows only the last.
    if (message.type === 'status')
      phone.outbox = phone.outbox.filter((m) => !m.text.startsWith('{"type":"status"'))
    phone.outbox.push({ seq, text })
    if (phone.outbox.length > OUTBOX_MAX) phone.outbox.splice(0, phone.outbox.length - OUTBOX_MAX)
    this.save()
    void this.transmit(deviceId, text)
    if (message.type === 'approval-request' || message.type === 'handoff')
      this.options.link.send({ type: 'push', deviceId, kind: 'needs-you' })
  }

  /** Sends the phone's tabs their current status. */
  sendStatus(deviceId?: string): void {
    const status = this.options.status?.()
    if (status === undefined) return
    const ids =
      deviceId === undefined ? this.options.devices.activePhones().map((p) => p.deviceId) : [deviceId]
    for (const id of ids) this.send(id, { type: 'status', ...status })
  }

  /** Tells a phone it was removed, then stops the relay letting it in. */
  unpair(deviceId: string): void {
    const phone = this.state.phones[deviceId]
    const record = this.options.devices.device(deviceId)
    if (phone !== undefined && record !== null) {
      const text = JSON.stringify({
        type: 'unpaired',
        seq: phone.nextSeq,
        at: new Date(this.now()).toISOString(),
      })
      phone.nextSeq += 1
      void this.seal(record, text).then((envelope) => {
        if (envelope !== null) this.options.link.send({ type: 'envelope', envelope })
        this.options.link.send({ type: 'device-unregister', deviceId })
      })
    } else this.options.link.send({ type: 'device-unregister', deviceId })
    delete this.state.phones[deviceId]
    this.save()
  }

  private async transmit(deviceId: string, text: string): Promise<void> {
    const record = this.options.devices.device(deviceId)
    if (record === null) return
    const envelope = await this.seal(record, text)
    if (envelope !== null) this.options.link.send({ type: 'envelope', envelope })
  }

  private async seal(record: DeviceRecord, text: string): Promise<Envelope | null> {
    try {
      return await sealEnvelope(
        text,
        {
          from: this.macId,
          to: record.deviceId,
          senderKey: this.options.keys.agreementKey,
          recipientKey: record.agreementKey,
        },
        this.agree,
      )
    } catch {
      this.options.log?.('phone channel: could not seal a message')
      return null
    }
  }

  /** Everything unacked, again, in order: the phone drops what it already has. */
  private resend(deviceId: string): void {
    const phone = this.state.phones[deviceId]
    if (phone === undefined) return
    void (async () => {
      for (const message of [...phone.outbox]) await this.transmit(deviceId, message.text)
    })()
  }

  // MARK: In

  /** Everything the relay client passes on. */
  handle(event: ChannelEvent): void {
    switch (event.type) {
      case 'ready': {
        // Register any phone the relay doesn't know (it lost its storage, or the Mac paired while
        // offline), and send each what is waiting.
        for (const phone of this.options.devices.activePhones()) {
          if (!event.devices.includes(phone.deviceId))
            this.options.link.send({
              type: 'device-register',
              deviceId: phone.deviceId,
              transportKey: phone.transportKey,
            })
          this.resend(phone.deviceId)
        }
        // A revoked phone the relay still lets in: stop it.
        for (const id of event.devices)
          if (!this.options.devices.isActivePhone(id))
            this.options.link.send({ type: 'device-unregister', deviceId: id })
        if (this.offer !== null && this.pairingState.step === 'scan')
          this.options.link.send({
            type: 'pairing-open',
            offerId: this.offer.offerId,
            expiresAt: new Date(this.offer.expiresAt).toISOString(),
          })
        return
      }
      case 'device-online':
        if (event.online && this.options.devices.isActivePhone(event.deviceId)) {
          this.resend(event.deviceId)
          this.sendStatus(event.deviceId)
        }
        return
      case 'envelope':
        this.inbound = this.inbound.then(() => this.receiveEnvelope(event.envelope)).catch(() => undefined)
        return
      case 'pairing-reply':
        void this.receivePairingReply(event.offerId, event.sealed)
        return
      case 'relay-locked':
        return
    }
  }

  private async receiveEnvelope(raw: Envelope): Promise<void> {
    const envelope = envelopeSchema.safeParse(raw)
    if (!envelope.success || envelope.data.to !== this.macId) return
    const from = envelope.data.from
    if (!this.options.devices.isActivePhone(from)) return
    const record = this.options.devices.device(from)
    if (record === null) return
    const text = await openEnvelope(
      envelope.data,
      { from, to: this.macId, senderKey: record.agreementKey, recipientKey: this.options.keys.agreementKey },
      this.agree,
    )
    if (text === null) return
    let message: { type?: unknown; seq?: unknown; ackSeq?: unknown }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    const phone = this.phone(from)
    if (message.type === 'ack') {
      if (typeof message.ackSeq === 'number') {
        phone.outbox = phone.outbox.filter((m) => m.seq !== message.ackSeq)
        this.save()
      }
      return
    }
    if (typeof message.seq !== 'number' || !Number.isInteger(message.seq)) return
    const verdict = seqVerdict(phone.lastInbound, message.seq)
    if (verdict === 'duplicate') return this.ack(from, message.seq)
    if (verdict === 'gap') {
      const held = this.held.get(from) ?? new Map<number, string>()
      if (held.size < 50) held.set(message.seq, text)
      this.held.set(from, held)
      return
    }
    await this.accept(from, message.seq, text)
    // Whatever was held behind the gap, in order.
    const held = this.held.get(from)
    while (held?.has(phone.lastInbound + 1)) {
      const seq = phone.lastInbound + 1
      const next = held.get(seq) as string
      held.delete(seq)
      await this.accept(from, seq, next)
    }
  }

  private async accept(from: string, seq: number, text: string): Promise<void> {
    const phone = this.phone(from)
    phone.lastInbound = seq
    this.save()
    this.ack(from, seq)
    try {
      await this.options.receive(from, text)
    } catch {
      this.options.log?.('phone channel: a phone message failed')
    }
  }

  private ack(deviceId: string, ackSeq: number): void {
    const phone = this.phone(deviceId)
    // Acks never take a number: they carry the last seq the Mac sent.
    void this.transmit(deviceId, JSON.stringify({ type: 'ack', seq: Math.max(1, phone.nextSeq - 1), ackSeq }))
  }

  // MARK: Pairing

  /** A new QR code. Any pairing in progress is abandoned. */
  startPairing(): PairingState {
    this.abandonPairing()
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + PAIRING_QR_TTL_MS
    const text = JSON.stringify({
      v: 1,
      macId: this.macId,
      macApprovalKey: this.options.keys.approvalKey,
      macAgreementKey: this.options.keys.agreementKey,
      relay: this.options.relayOrigin,
      secret,
      expiresAt: new Date(expiresAt).toISOString(),
    })
    const offerId = pairingOfferId(secret)
    this.offer = { secret, offerId, text, expiresAt, reply: null, attempts: 0 }
    const sent = this.options.link.send({
      type: 'pairing-open',
      offerId,
      expiresAt: new Date(expiresAt).toISOString(),
    })
    if (!sent) {
      this.offer = null
      return this.setPairing({ step: 'failed', why: 'not-sent' })
    }
    return this.setPairing({
      step: 'scan',
      qr: PAIRING_QR_PREFIX + Buffer.from(text).toString('base64url'),
      expiresAt: new Date(expiresAt).toISOString(),
    })
  }

  /** The person closed the sheet. */
  cancelPairing(): void {
    this.abandonPairing()
    this.setPairing({ step: 'idle' })
  }

  /**
   * The person picked a code. The right one asks for Touch ID and pairs; a wrong one counts
   * against the offer, and the third abandons it. `null` is "None of these".
   */
  async confirmPairing(code: string | null): Promise<PairingState> {
    const offer = this.offer
    if (offer === null || offer.reply === null || this.pairingState.step !== 'confirm')
      return this.pairingState
    if (this.now() > offer.expiresAt) return this.failPairing(offer, 'expired')
    if (code === null) return this.failPairing(offer, 'declined')
    if (code !== offer.reply.code) {
      offer.attempts += 1
      if (offer.attempts >= PAIRING_MAX_ATTEMPTS) return this.failPairing(offer, 'too-many-attempts')
      return this.setPairing({ ...this.pairingState, attemptsLeft: PAIRING_MAX_ATTEMPTS - offer.attempts })
    }
    const reply = offer.reply.parsed
    const deviceId = keyId(reply.approvalKey)
    this.setPairing({ step: 'approving', deviceName: reply.deviceName })
    let approved = false
    try {
      approved = await this.options.approvePairing({
        deviceId,
        deviceName: reply.deviceName,
        confirmation: offer.reply.code,
      })
    } catch {
      approved = false
    }
    if (this.offer !== offer) return this.pairingState
    if (!approved) {
      // Cancelled at Touch ID: the codes stay up, so the person can try again.
      return this.setPairing({
        step: 'confirm',
        deviceName: reply.deviceName,
        codes: this.decoys(offer.reply.code),
        attemptsLeft: PAIRING_MAX_ATTEMPTS - offer.attempts,
        expiresAt: new Date(offer.expiresAt).toISOString(),
      })
    }
    return this.finishPairing(offer, reply, deviceId)
  }

  private async finishPairing(offer: Offer, reply: PairingReply, deviceId: string): Promise<PairingState> {
    const pairedAt = new Date(this.now()).toISOString()
    const record = (fields: Record<string, unknown>) => JSON.stringify({ v: 1, ...fields, pairedAt })
    const phoneText = record({
      deviceId,
      macId: this.macId,
      role: 'phone',
      platform: 'ios',
      name: reply.deviceName,
      approvalKey: reply.approvalKey,
      transportKey: reply.transportKey,
      agreementKey: reply.agreementKey,
    })
    const macText = record({
      deviceId: this.macId,
      macId: this.macId,
      role: 'mac',
      platform: 'macos',
      name: this.options.macName,
      approvalKey: this.options.keys.approvalKey,
      transportKey: this.options.keys.transportKey,
      agreementKey: this.options.keys.agreementKey,
    })
    const reason = `pair ${reply.deviceName}`
    const phoneSig = await this.options.channel.signApproval(SIGNING_DOMAINS.deviceRecord, phoneText, reason)
    const macSig =
      phoneSig === null
        ? null
        : await this.options.channel.signApproval(SIGNING_DOMAINS.deviceRecord, macText, reason)
    if (phoneSig === null || macSig === null) return this.failPairing(offer, 'unavailable')
    const deviceRecord: SignedText = { payload: phoneText, signature: phoneSig }
    let added: DeviceRecord
    try {
      added = await this.options.devices.add(deviceRecord)
    } catch {
      return this.failPairing(offer, 'unavailable')
    }
    // Fresh counters: a phone paired again starts its own seqs from 1.
    this.state.phones[deviceId] = { nextSeq: 1, lastInbound: 0, outbox: [] }
    this.held.delete(deviceId)
    this.save()
    // Registered before the result goes, so the phone's first hello is let in.
    this.options.link.send({ type: 'device-register', deviceId, transportKey: reply.transportKey })
    this.sendResult(offer, {
      outcome: 'paired',
      deviceRecord,
      macRecord: { payload: macText, signature: macSig },
    })
    this.offer = null
    await this.options.paired(added).catch(() => undefined)
    this.sendStatus(deviceId)
    return this.setPairing({ step: 'paired', deviceId, deviceName: reply.deviceName })
  }

  private async receivePairingReply(offerId: string, sealed: { iv: string; ct: string }): Promise<void> {
    const offer = this.offer
    // The first reply spends the offer; any later one is ignored (the relay refuses them too).
    if (offer === null || offer.offerId !== offerId || offer.reply !== null) return
    if (this.now() > offer.expiresAt) return void this.failPairing(offer, 'expired')
    const key = pairingSealKey(offer.secret, this.macId)
    const text = openSealed(key, sealed, pairingAad('reply', offerId))
    let parsed: PairingReply | null = null
    if (text !== null) {
      try {
        const result = pairingReplySchema.safeParse(JSON.parse(text))
        if (result.success) parsed = result.data
      } catch {
        parsed = null
      }
    }
    const deviceId = parsed === null ? null : keyId(parsed.approvalKey)
    const valid =
      parsed !== null &&
      deviceId !== null &&
      deviceRecordSchema.safeParse({
        v: 1,
        deviceId,
        macId: this.macId,
        role: 'phone',
        platform: 'ios',
        name: parsed.deviceName,
        approvalKey: parsed.approvalKey,
        transportKey: parsed.transportKey,
        agreementKey: parsed.agreementKey,
        pairedAt: new Date(this.now()).toISOString(),
      }).success
    if (text === null || parsed === null || !valid) return void this.failPairing(offer, 'declined')
    const macNonce = randomBytes(32).toString('base64url')
    const code = pairingCode(offer.secret, this.macId, offer.text, text, macNonce)
    offer.reply = { text, parsed, code }
    const signature = await this.options.channel.signApproval(
      SIGNING_DOMAINS.pairingChallenge,
      pairingChallengePayload(offerId, macNonce, text),
      `pair ${parsed.deviceName}`,
    )
    if (this.offer !== offer) return
    if (signature === null) return void this.failPairing(offer, 'unavailable')
    this.options.link.send({ type: 'pairing-challenge', offerId, macNonce, signature })
    this.setPairing({
      step: 'confirm',
      deviceName: parsed.deviceName,
      codes: this.decoys(code),
      attemptsLeft: PAIRING_MAX_ATTEMPTS - offer.attempts,
      expiresAt: new Date(offer.expiresAt).toISOString(),
    })
  }

  /** The code among two others, in a random order, so the person has to look at the phone. */
  private decoys(code: string): string[] {
    const codes = new Set([code])
    while (codes.size < 3) codes.add(String(randomInt(0, 1_000_000)).padStart(6, '0'))
    return [...codes].sort(() => randomInt(0, 3) - 1)
  }

  private sendResult(offer: Offer, result: PairingResult): void {
    const sealed = sealPairing(
      pairingSealKey(offer.secret, this.macId),
      JSON.stringify(result),
      pairingAad('result', offer.offerId),
    )
    this.options.link.send({ type: 'pairing-result', offerId: offer.offerId, sealed })
  }

  private failPairing(offer: Offer, why: Extract<PairingState, { step: 'failed' }>['why']): PairingState {
    if (offer.reply !== null) {
      const outcome =
        why === 'expired' ? 'expired' : why === 'too-many-attempts' ? 'too-many-attempts' : 'declined'
      this.sendResult(offer, { outcome })
    }
    if (this.offer === offer) this.offer = null
    return this.setPairing({ step: 'failed', why })
  }

  private abandonPairing(): void {
    if (this.offer !== null) this.failPairing(this.offer, 'cancelled')
  }

  private setPairing(state: PairingState): PairingState {
    this.pairingState = state
    this.options.onChange?.()
    return state
  }

  // MARK: State

  private phone(deviceId: string): PhoneState {
    let phone = this.state.phones[deviceId]
    if (phone === undefined) {
      phone = { nextSeq: 1, lastInbound: 0, outbox: [] }
      this.state.phones[deviceId] = phone
    }
    return phone
  }

  private save(): void {
    const text = JSON.stringify(this.state)
    const path = this.options.statePath
    this.saving = this.saving
      .then(async () => {
        await writeFile(`${path}.tmp`, text, { mode: 0o600 })
        await rename(`${path}.tmp`, path)
      })
      .catch(() => this.options.log?.('phone channel: could not save its counters'))
  }

  /** For tests: resolves once queued writes and messages are done. */
  async settled(): Promise<void> {
    await this.inbound
    await this.saving
  }
}
