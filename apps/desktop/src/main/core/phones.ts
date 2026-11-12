// Paired phones, as the app runs them (docs/phone-channel.md): the relay connection, which only
// dials out, and the phone channel over it. Off unless a relay is set up. Keys that can't do the
// channel's operations say so instead of pairing in some weaker way.

import { readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { type DeviceRecord, SIGNING_DOMAINS, verifyP256 } from '@valet/core'
import { RelayClient, type RelayClientStatus } from '@valet/mcp-server'
import type { PairingView, PhonesStatus } from '../../shared/api'
import type { ApprovalBroker, MacToPhoneBody, PhoneOutbox } from './approvals/broker'
import type { DeviceStore } from './approvals/devices'
import { PhoneChannel, type PhoneChannelOptions } from './approvals/phone-channel'
import { PhoneInbox, type SafetySwitches } from './approvals/phone-inbox'
import type { MacSigner } from './approvals/signer'

export interface RelaySetup {
  /** The relay's origin, https://<host>: named in the QR code and in every challenge. */
  readonly origin: string
  /** Where to dial when that isn't the origin itself (a local relay in development). */
  readonly connectUrl?: string
}

export interface PhonesOptions {
  readonly relay: RelaySetup | null
  readonly macName: string
  /** The channel's counters (phone-channel.json) and the relay binding (relay-binding.json). */
  readonly statePath: string
  readonly bindingPath: string
  readonly emit: () => void
  readonly log?: (line: string) => void
}

export interface PhonesParts {
  readonly broker: ApprovalBroker
  readonly devices: DeviceStore
  readonly signer: MacSigner
  readonly safety: SafetySwitches
  readonly approvePairing: PhoneChannelOptions['approvePairing']
  readonly paired: (record: DeviceRecord) => Promise<void>
  readonly status: PhoneChannelOptions['status']
}

export class Phones implements PhoneOutbox {
  private channel: PhoneChannel | null = null
  private client: RelayClient | null = null
  private relayStatus: RelayClientStatus = { state: 'stopped' }
  private online = new Set<string>()
  private devices: DeviceStore | null = null
  private unavailable: PhonesStatus['unavailableReason'] = 'approvals-unavailable'
  private relay: RelaySetup | null
  private parts: PhonesParts | null = null

  constructor(private readonly options: PhonesOptions) {
    this.relay = options.relay
    if (options.relay === null) this.unavailable = 'no-relay'
  }

  /**
   * A different relay (the person changed it in Settings › Devices): the channel restarts on it.
   * Phones paired through the old one keep dialling it until they pair again.
   */
  async setRelay(relay: RelaySetup | null): Promise<void> {
    const same = relay?.origin === this.relay?.origin && relay?.connectUrl === this.relay?.connectUrl
    // The same relay again restarts only after a cancelled Touch ID, so the person is asked again.
    if (same && this.unavailable !== 'no-keys') return
    this.relay = relay
    if (this.parts !== null) await this.open(this.parts)
    else if (relay === null) this.unavailable = 'no-relay'
    this.options.emit()
  }

  /** Starts the channel once the broker is open. Safe to call again after a reopen. */
  async open(parts: PhonesParts): Promise<void> {
    this.stop()
    this.parts = parts
    this.devices = parts.devices
    this.relayStatus = { state: 'stopped' }
    const relay = this.relay
    if (relay === null) {
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
    this.unavailable = null
    const inbox = new PhoneInbox(parts.broker, parts.devices, parts.safety)
    const client = new RelayClient({
      relay: relay.origin,
      macId: parts.devices.macId,
      signer: { publicKey: keys.transportKey, sign: (payload) => keysOps.signTransport(payload) },
      binding,
      // Remote MCP over the relay isn't wired into the app yet: only the phone channel runs.
      listener: () => null,
      consent: () => ({ state: 'declined' }),
      ...(relay.connectUrl === undefined ? {} : { connectUrl: relay.connectUrl }),
      onStatus: (status) => {
        // A local relay (VALET_RELAY_CONNECT, dev builds only): say what it does, for the walkthrough.
        if (relay.connectUrl !== undefined) console.log(`[relay] ${status.state}`)
        this.relayStatus = status
        if (status.state !== 'online') this.online.clear()
        this.options.emit()
      },
      onEvent: (event) => {
        if (relay.connectUrl !== undefined)
          console.log(
            `[relay] ${event.type}${event.type === 'device-online' ? ` ${event.deviceId} ${event.online}` : ''}`,
          )
        if (event.type === 'device-online') {
          if (event.online) this.online.add(event.deviceId)
          else this.online.delete(event.deviceId)
          this.options.emit()
        }
        this.channel?.handle(event)
      },
    })
    this.channel = await PhoneChannel.open({
      devices: parts.devices,
      keys,
      channel: keysOps,
      relayOrigin: relay.origin,
      link: client,
      receive: (from, text) => inbox.receive(from, text),
      approvePairing: parts.approvePairing,
      paired: parts.paired,
      macName: this.options.macName,
      status: parts.status,
      statePath: this.options.statePath,
      onChange: () => this.options.emit(),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    })
    this.client = client
    client.start()
  }

  stop(): void {
    this.client?.stop()
    this.client = null
    this.channel = null
    this.online.clear()
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
      relay: this.relayStatus.state === 'replaced' ? 'refused' : this.relayStatus.state,
      relayOrigin: this.relay?.origin ?? null,
      phones: phones.map((p) => ({
        deviceId: p.deviceId,
        name: p.name,
        pairedAt: p.pairedAt,
        online: this.online.has(p.deviceId),
      })),
      pairing: this.channel?.pairing ?? { step: 'idle' },
    }
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

/** VALET_RELAY_ORIGIN (https://…) and, for a local relay, VALET_RELAY_CONNECT (where to dial). */
export function relayFromEnv(env: NodeJS.ProcessEnv): RelaySetup | null {
  const origin = env['VALET_RELAY_ORIGIN']
  if (origin === undefined || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) return null
  const connect = env['VALET_RELAY_CONNECT']
  return connect !== undefined && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(connect)
    ? { origin, connectUrl: connect }
    : { origin }
}

/** The relay a host name in Settings names: always https, on the default port. */
export function relayFromHost(host: string | null): RelaySetup | null {
  return host === null ? null : { origin: `https://${host}` }
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
