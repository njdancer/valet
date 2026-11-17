// Paired phones, as the app runs them (docs/phone-channel.md): the relay connection, which only
// dials out, and the phone channel over it. Off unless a relay is set up. Keys that can't do the
// channel's operations say so instead of pairing in some weaker way.

import { readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { type DeviceRecord, SIGNING_DOMAINS, verifyP256 } from '@valet/core'
import { RelayClient, type RelayClientStatus, type RelayConsentView } from '@valet/mcp-server'
import type { HubView, PairingView, PhonesStatus } from '../../shared/api'
import type { ApprovalBroker, MacToPhoneBody, PhoneOutbox } from './approvals/broker'
import type { DeviceStore } from './approvals/devices'
import { HubAgents } from './approvals/hub-agents'
import type { TrustedLedger } from './approvals/ledger'
import { PhoneChannel, type PhoneChannelOptions } from './approvals/phone-channel'
import { PhoneInbox, type SafetySwitches } from './approvals/phone-inbox'
import { RosterKeeper } from './approvals/roster-keeper'
import type { MacSigner } from './approvals/signer'

export interface RelaySetup {
  /** The relay's origin, https://<host>: named in the QR code and in every challenge. */
  readonly origin: string
  /** Where to dial when that isn't the origin itself (a local relay in development). */
  readonly connectUrl?: string
  /**
   * The base of this Mac's own host for cloud agents, when the relay names Macs under another
   * domain (its RELAY_MAC_HOST): `<macId>.<macHost>`.
   */
  readonly macHost?: string
}

export interface PhonesOptions {
  readonly relay: RelaySetup | null
  readonly macName: string
  /** The channel's counters (phone-channel.json) and the relay binding (relay-binding.json). */
  readonly statePath: string
  readonly bindingPath: string
  readonly emit: () => void
  readonly log?: (line: string) => void
  /**
   * Remote access, for agents that reach this Mac through the relay (docs/relay-worker.md): the
   * relay client forwards their requests to its listener, byte for byte, and asks it about the
   * relay's consent pages. Without it the relay carries only the phone channel.
   */
  readonly remote?: RelayRemote
}

export interface RelayRemote {
  /** The relay's public name for this Mac, while the relay client runs; null when it stops. */
  setRelayHost(host: string | null): void
  /** The listener's loopback URL, or null while remote access is off. */
  relayListener(): string | null
  relayConsent(id: string, query: string, source: string | null): RelayConsentView
  /** For an agent through the hub whose grant this Mac checked: a credential, or null (remote.ts). */
  hubAuthorization(grantId: string): string | null
  /** The hub's grants this Mac honours now. */
  hubGrantsChanged(live: ReadonlySet<string>): void
}

export interface PhonesParts {
  readonly broker: ApprovalBroker
  readonly devices: DeviceStore
  readonly signer: MacSigner
  readonly safety: SafetySwitches
  readonly approvePairing: PhoneChannelOptions['approvePairing']
  readonly paired: (record: DeviceRecord) => Promise<void>
  readonly status: PhoneChannelOptions['status']
  /** Where the Mac pins the account's device list. */
  readonly ledger: TrustedLedger
  /** A phone paired here that another device removed from the account's list: revoke it. */
  readonly removedFromAccount: (deviceId: string, by: string) => Promise<void>
  readonly now: () => number
  /** Agents' sign-ins at the hub changed; `opened` when a new one arrived (show the sheet). */
  readonly hubConsents: (opened: boolean) => void
}

export class Phones implements PhoneOutbox {
  private channel: PhoneChannel | null = null
  private client: RelayClient | null = null
  private relayStatus: RelayClientStatus = { state: 'stopped' }
  private hub: HubView | null = null
  private online = new Set<string>()
  private devices: DeviceStore | null = null
  private unavailable: PhonesStatus['unavailableReason'] = 'approvals-unavailable'
  private relay: RelaySetup | null
  private parts: PhonesParts | null = null
  private roster: RosterKeeper | null = null
  private agents: HubAgents | null = null

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
    this.hub = null
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
    const roster = new RosterKeeper({
      ledger: parts.ledger,
      devices: parts.devices,
      keys,
      channel: keysOps,
      macName: this.options.macName,
      send: (changes) => this.client?.send({ type: 'hub-roster-append', changes: [...changes] }) ?? false,
      sendJoin: (record) => this.client?.send({ type: 'hub-roster-join', record }) ?? false,
      removed: parts.removedFromAccount,
      now: parts.now,
      onChange: () => {
        // The phones hear which account they are on once this Mac is on its list.
        this.channel?.sendStatus()
        this.options.emit()
      },
      // Phones on the account's list: trusted here like paired ones, let in by the relay.
      onPhones: (phones) => {
        parts.devices.setAccountPhones(phones)
        this.channel?.devicesChanged()
        this.options.emit()
      },
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    })
    const agents = new HubAgents({
      macId: parts.devices.macId,
      channel: keysOps,
      roster: () => roster.roster,
      send: (frame) => this.client?.send(frame) ?? false,
      now: parts.now,
      onChange: (opened) => parts.hubConsents(opened),
    })
    const client = new RelayClient({
      relay: relay.origin,
      macId: parts.devices.macId,
      signer: { publicKey: keys.transportKey, sign: (payload) => keysOps.signTransport(payload) },
      binding,
      // Remote agents: a byte pipe to the same listener, OAuth server and policy as a tunnel's.
      listener: () => this.options.remote?.relayListener() ?? null,
      consent: (id, query, source) =>
        this.options.remote?.relayConsent(id, query, source) ?? { state: 'declined' },
      // Agents through the hub: only for a grant this Mac checks against the account's list now.
      hubAuthorization: (grantId) =>
        agents.grants().some((g) => g.id === grantId)
          ? (this.options.remote?.hubAuthorization(grantId) ?? null)
          : null,
      ...(relay.connectUrl === undefined ? {} : { connectUrl: relay.connectUrl }),
      ...(relay.macHost === undefined ? {} : { macHost: relay.macHost }),
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
        if (event.type === 'hub-status') {
          // Linking, then linked: the person just added this Mac with the code it showed.
          const fresh = this.hub?.state === 'linking' && event.hub.state === 'linked'
          this.hub = event.hub
          void roster
            .linked(event.hub.state === 'linked' ? event.hub.accountId : null, fresh)
            .catch(() => undefined)
          this.options.emit()
          return
        }
        if (event.type === 'hub-consents') {
          agents.received(event.consents)
          return
        }
        if (event.type === 'hub-grants') {
          agents.grantsReceived(event.grants)
          this.options.remote?.hubGrantsChanged(new Set(agents.grants().map((g) => g.id)))
          return
        }
        if (event.type === 'hub-roster') {
          void roster
            .received(event.changes, event.refused)
            .catch((error) => this.options.log?.(`[roster] ${String(error)}`))
          return
        }
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
      paired: async (record) => {
        await parts.paired(record)
        void roster.changed().catch(() => undefined)
      },
      macName: this.options.macName,
      status: () => {
        const status = parts.status?.()
        const account = this.account()
        return status === undefined || account === null ? status : { ...status, account }
      },
      statePath: this.options.statePath,
      onChange: () => this.options.emit(),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    })
    this.client = client
    this.roster = roster
    this.agents = agents
    this.options.remote?.setRelayHost(client.publicHost)
    client.start()
  }

  stop(): void {
    this.options.remote?.setRelayHost(null)
    this.client?.stop()
    this.client = null
    this.channel = null
    this.roster = null
    this.agents?.received([])
    this.agents = null
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
      worksLocked: null,
      hub: this.hub,
      roster: this.roster?.view ?? { state: 'off', devices: 0 },
      phones: phones.map((p) => ({
        deviceId: p.deviceId,
        name: p.name,
        pairedAt: p.pairedAt,
        online: this.online.has(p.deviceId),
      })),
      pairing: this.channel?.pairing ?? { step: 'idle' },
    }
  }

  /** The account this Mac is on, for its phones, once the Mac is on the account's list. */
  private account(): { hub: string; accountId: string } | null {
    const hub = this.hub
    if (hub?.state !== 'linked' || this.roster?.view.state !== 'on') return null
    return { hub: hub.url, accountId: hub.accountId }
  }

  /** Asks the hub for a code to join the account (relay-hub.md). False when not connected. */
  joinHub(): boolean {
    if (this.client === null || this.relayStatus.state !== 'online') return false
    return this.client.send({ type: 'hub-link-start', name: this.options.macName.slice(0, 64) })
  }

  leaveHub(): boolean {
    if (this.client === null || this.relayStatus.state !== 'online') return false
    return this.client.send({ type: 'hub-unlink' })
  }

  /**
   * A phone was removed here: take it off the account's list too (one Touch ID prompt). Also
   * Settings' "Try again" after a cancelled prompt.
   */
  rosterChanged(): Promise<void> {
    return this.roster?.changed() ?? Promise.resolve()
  }

  /** Agents signing in through the hub, while the relay connection runs. */
  get hubAgents(): HubAgents | null {
    return this.agents
  }

  /** Removes an agent approved through the hub; this Mac stops serving it at once. */
  revokeHubAgent(grantId: string): boolean {
    const agents = this.agents
    if (agents === null || !agents.revoke(grantId)) return false
    this.options.remote?.hubGrantsChanged(new Set(agents.grants().map((g) => g.id)))
    return true
  }

  /** A page on the hub the relay named, https only; null when there is none. */
  hubPage(path: '/' | '/link'): string | null {
    const hub = this.hub
    if (hub === null || hub.state === 'off') return null
    const url = new URL(path, hub.url)
    return url.protocol === 'https:' ? url.toString() : null
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
  const macHost = env['VALET_RELAY_MAC_HOST']
  return {
    origin,
    ...(connect !== undefined && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(connect)
      ? { connectUrl: connect }
      : {}),
    ...(macHost !== undefined && HOST_NAME.test(macHost) ? { macHost } : {}),
  }
}

const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The relay a host name in Settings names: always https, on the default port. `macHost`, when
 * set, is the base of this Mac's own host for cloud agents (the relay's RELAY_MAC_HOST).
 */
export function relayFromHost(host: string | null, macHost: string | null = null): RelaySetup | null {
  if (host === null) return null
  return macHost === null || !HOST_NAME.test(macHost)
    ? { origin: `https://${host}` }
    : { origin: `https://${host}`, macHost }
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
