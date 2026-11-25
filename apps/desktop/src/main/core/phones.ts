// Paired phones, as the app runs them (docs/phone-channel.md): they reach this Mac at its own
// address through the blind relay (docs/blind-relay.md#phones), which the Mac only dials out to.
// Keys that can't do the channel's operations say so instead of pairing in some weaker way.

import { readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { type DeviceRecord, SIGNING_DOMAINS, verifyP256 } from '@valet/core'
import type { PairingView, PhonesStatus } from '../../shared/api'
import type { ApnsSender } from './approvals/apns'
import type { ApprovalBroker, MacToPhoneBody, PhoneOutbox } from './approvals/broker'
import type { DeviceStore } from './approvals/devices'
import {
  type ChannelEvent,
  PhoneChannel,
  type PhoneChannelOptions,
  type RelayLink,
} from './approvals/phone-channel'
import { PhoneDoor } from './approvals/phone-door'
import { PhoneInbox, type SafetySwitches } from './approvals/phone-inbox'
import type { MacSigner } from './approvals/signer'
import type { BlindTunnel } from './blind-tunnel'

export interface PhonesOptions {
  readonly macName: string
  /** The channel's counters (phone-channel.json) and the relay binding (relay-binding.json). */
  readonly statePath: string
  readonly bindingPath: string
  readonly emit: () => void
  readonly log?: (line: string) => void
  /** This Mac at the blind relay, started with the transport key and binding once they're ready. */
  readonly tunnel: BlindTunnel | null
  /** Wakes a phone that isn't connected when a card waits for it. Null: phones fetch on open only. */
  readonly apns?: ApnsSender | null
}

export interface PhonesParts {
  readonly broker: ApprovalBroker
  readonly devices: DeviceStore
  readonly signer: MacSigner
  readonly safety: SafetySwitches
  readonly approvePairing: PhoneChannelOptions['approvePairing']
  readonly paired: (record: DeviceRecord) => Promise<void>
  readonly status: PhoneChannelOptions['status']
  readonly now: () => number
}

export class Phones implements PhoneOutbox {
  private channel: PhoneChannel | null = null
  /** Phones connected at this Mac's own address. */
  private online = new Set<string>()
  private door: PhoneDoor | null = null
  private devices: DeviceStore | null = null
  private unavailable: PhonesStatus['unavailableReason'] = 'approvals-unavailable'

  constructor(private readonly options: PhonesOptions) {
    if (options.tunnel === null) this.unavailable = 'no-relay'
  }

  /** Starts the channel once the broker is open. Safe to call again after a reopen. */
  async open(parts: PhonesParts): Promise<void> {
    this.stop()
    this.devices = parts.devices
    const tunnel = this.options.tunnel
    if (tunnel === null) {
      this.unavailable = 'no-relay'
      return
    }
    const keysOps = parts.signer.channel
    if (keysOps === undefined) {
      this.unavailable = 'no-keys'
      return
    }
    const keys = await parts.signer.keys()
    const binding = await this.binding(parts.signer, keys.approvalKey, keys.transportKey)
    if (binding === null) {
      this.unavailable = 'no-keys'
      return
    }
    tunnel.start(
      parts.devices.macId,
      { publicKey: keys.transportKey, sign: (payload) => keysOps.signTransport(payload) },
      binding,
    )
    this.unavailable = null
    const inbox = new PhoneInbox(parts.broker, parts.devices, parts.safety)
    const door = new PhoneDoor({
      devices: parts.devices,
      origin: () => tunnel.origin,
      onEvent: (event) => this.doorEvent(event),
      onPushToken: (deviceId, token) => {
        void this.options.apns?.setToken(deviceId, token).catch(() => undefined)
      },
      now: parts.now,
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    })
    this.door = door
    const link: RelayLink = {
      send: (frame) => {
        if (frame.type !== 'push') return door.send(frame)
        // A connected phone has the card already; one that isn't is woken through Apple.
        const apns = this.options.apns
        if (apns === undefined || apns === null || door.online(frame.deviceId)) return false
        void apns.wake(frame.deviceId)
        return true
      },
    }
    this.channel = await PhoneChannel.open({
      devices: parts.devices,
      keys,
      channel: keysOps,
      // Where a new phone dials, named in the QR code: this Mac's own address.
      relayOrigin: () => tunnel.origin ?? '',
      link,
      receive: (from, text) => inbox.receive(from, text),
      approvePairing: parts.approvePairing,
      paired: parts.paired,
      macName: this.options.macName,
      status: parts.status,
      statePath: this.options.statePath,
      onChange: () => this.options.emit(),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    })
    // Once the channel is there to hear them.
    tunnel.setPhoneDoor((socket) => door.accept(socket))
  }

  private doorEvent(event: ChannelEvent): void {
    if (event.type === 'device-online') {
      if (event.online) this.online.add(event.deviceId)
      else this.online.delete(event.deviceId)
      this.options.emit()
    }
    this.channel?.handle(event)
  }

  stop(): void {
    this.door?.stop()
    this.door = null
    this.online.clear()
    this.options.tunnel?.setPhoneDoor(null)
    this.options.tunnel?.stop()
    this.channel = null
  }

  send(deviceId: string, message: MacToPhoneBody): void {
    this.channel?.send(deviceId, message)
  }

  /** The tabs' status, to every phone, after something they show changed. */
  statusChanged(): void {
    this.channel?.sendStatus()
  }

  status(): PhonesStatus {
    const phones = this.devices?.activePhones() ?? []
    return {
      available: this.unavailable === null,
      unavailableReason: this.unavailable,
      relay: this.connection(),
      relayOrigin: this.options.tunnel?.origin ?? null,
      worksLocked: null,
      phones: phones.map((p) => ({
        deviceId: p.deviceId,
        name: p.name,
        pairedAt: p.pairedAt,
        online: this.online.has(p.deviceId),
      })),
      pairing: this.channel?.pairing ?? { step: 'idle' },
    }
  }

  /** How phones reach this Mac: the blind relay's connection. */
  private connection(): PhonesStatus['relay'] {
    const state = this.options.tunnel?.view?.relay ?? 'stopped'
    if (state === 'online') return this.options.tunnel?.servingPhones === true ? 'online' : 'connecting'
    return state === 'replaced' ? 'refused' : state
  }

  startPairing(): PairingView {
    if (this.channel === null) return { step: 'failed', why: 'unavailable' }
    return this.channel.startPairing()
  }

  async confirmPairing(code: string | null): Promise<PairingView> {
    if (this.channel === null) return { step: 'failed', why: 'unavailable' }
    return this.channel.confirmPairing(code)
  }

  cancelPairing(): void {
    this.channel?.cancelPairing()
  }

  /** Tells the phone, and stops the relay letting it in. The caller revokes its record. */
  unpair(deviceId: string): void {
    this.channel?.unpair(deviceId)
    void this.options.apns?.forget(deviceId).catch(() => undefined)
    this.door?.devicesChanged()
  }

  /**
   * The approval key vouching for the transport key (verifyRelayBinding). Signed once and kept;
   * signed again only if the transport key changed. Null if it can't be signed.
   */
  private async binding(
    signer: MacSigner,
    approvalKey: string,
    transportKey: string,
  ): Promise<{ approvalKey: string; signature: string } | null> {
    try {
      const kept = JSON.parse(await readFile(this.options.bindingPath, 'utf8')) as {
        transportKey?: unknown
        signature?: unknown
      }
      if (
        kept.transportKey === transportKey &&
        typeof kept.signature === 'string' &&
        verifyP256(approvalKey, SIGNING_DOMAINS.relayBinding, transportKey, kept.signature)
      )
        return { approvalKey, signature: kept.signature }
    } catch {
      // None kept yet.
    }
    const signature = await signer.channel
      ?.signApproval(SIGNING_DOMAINS.relayBinding, transportKey, 'connect Valet to its relay')
      .catch(() => null)
    if (signature === null || signature === undefined) return null
    const path = this.options.bindingPath
    await writeFile(`${path}.tmp`, JSON.stringify({ transportKey, signature }), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
    return { approvalKey, signature }
  }
}

/** The Mac's name as a paired phone shows it. */
export function macName(env: NodeJS.ProcessEnv): string {
  const named = env['VALET_MAC_NAME']
  if (named !== undefined && /^[\p{L}\p{N} '’.-]{1,60}$/u.test(named)) return named
  return (
    hostname()
      .replace(/\.local$/, '')
      .replace(/-/g, ' ') || 'This Mac'
  ).slice(0, 60)
}
