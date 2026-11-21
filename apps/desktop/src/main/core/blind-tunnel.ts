// This Mac at the blind relay (docs/blind-relay.md): the tunnel that receives agents' and phones'
// TLS connections as raw bytes and ends TLS here, and the Let's Encrypt certificate it ends it
// with. Started by Phones once the Mac's keys and relay binding are ready, beside the Worker relay
// until Nick's Mac has moved over. The certificate's keys are kept in Valet's own Keychain item
// (a file in a development build without the helper), never sent anywhere.

import { readFile, rename, writeFile } from 'node:fs/promises'
import type { TLSSocket } from 'node:tls'
import {
  CertificateManager,
  type CertificateStatus,
  type CertificateStore,
  LETS_ENCRYPT,
  type StoredCertificate,
} from '@valet/acme'
import { tunnelHost } from '@valet/core'
import type { KeychainStore } from '@valet/credentials'
import {
  type AcceptedConnection,
  type RelayBinding,
  type TransportSigner,
  TunnelClient,
  type TunnelClientStatus,
} from '@valet/mcp-server'

export interface BlindRelaySetup {
  /** Where Macs dial in, e.g. relay.valet.dncr.me. */
  readonly controlHost: string
  /** Macs are `<macId>.<macDomain>`, e.g. valet.dncr.me. */
  readonly macDomain: string
  /** Where to dial when it isn't the control host on 443 (a local relay in development). */
  readonly connectUrl?: string
  /** The ACME directory: Let's Encrypt unless a test names its own CA. */
  readonly acmeDirectory?: string
  /** The WebSocket class, for tests that dial a relay with its own test certificate. */
  readonly WebSocket?: typeof WebSocket
}

export interface BlindTunnelOptions {
  readonly setup: BlindRelaySetup
  readonly store: CertificateStore
  /** The listener's accept while remote access is on, else null. */
  readonly accept: () => ((socket: TLSSocket, meta: AcceptedConnection) => void) | null
  /** The name, and whether it has a certificate to serve, or null when the tunnel stops. */
  readonly setHost: (host: string | null, ready: boolean) => void
  readonly changed: () => void
  readonly log?: (line: string) => void
}

export interface BlindTunnelView {
  readonly host: string
  readonly relay: TunnelClientStatus['state']
  readonly certificate: CertificateStatus['state']
  /** When a queued certificate is tried again (Let's Encrypt's weekly limit), ISO. */
  readonly retryAt: string | null
}

export class BlindTunnel {
  private client: TunnelClient | null = null
  private certificates: CertificateManager | null = null

  constructor(private readonly options: BlindTunnelOptions) {}

  start(macId: string, signer: TransportSigner, binding: RelayBinding): void {
    this.stop()
    const { setup } = this.options
    const host = tunnelHost(macId, setup.macDomain)
    let client: TunnelClient | null = null
    const certificates = new CertificateManager({
      name: host,
      directoryUrl: setup.acmeDirectory ?? LETS_ENCRYPT,
      store: this.options.store,
      reachable: () => client?.status.state === 'online',
      onStatus: () => this.update(host),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    })
    client = new TunnelClient({
      relay: `https://${setup.controlHost}`,
      macDomain: setup.macDomain,
      macId,
      signer,
      binding,
      certificate: () => certificates.certificate(),
      acmeChallenge: (name) => certificates.challenge(name),
      listener: () => this.options.accept(),
      ...(setup.connectUrl === undefined ? {} : { connectUrl: setup.connectUrl }),
      ...(setup.WebSocket === undefined ? {} : { WebSocket: setup.WebSocket }),
      onStatus: (status) => {
        if (status.state === 'online') certificates.kick()
        this.options.log?.(`[blind relay] ${status.state}`)
        this.update(host)
      },
      onBadFrame: (why) => this.options.log?.(`[blind relay] refused a frame (${why})`),
    })
    this.client = client
    this.certificates = certificates
    this.update(host)
    void certificates.start().catch((error) => this.options.log?.(`[certificate] ${String(error)}`))
    client.start()
  }

  stop(): void {
    this.certificates?.stop()
    this.client?.stop()
    const was = this.client !== null
    this.client = null
    this.certificates = null
    if (was) {
      this.options.setHost(null, false)
      this.options.changed()
    }
  }

  get view(): BlindTunnelView | null {
    const client = this.client
    const certificates = this.certificates
    if (client === null || certificates === null) return null
    const status = certificates.status
    return {
      host: client.publicHost,
      relay: client.status.state,
      certificate: status.state,
      retryAt: status.state === 'queued' ? status.until.toISOString() : null,
    }
  }

  private update(host: string): void {
    if (this.client === null) return
    this.options.setHost(host, this.certificates !== null && this.certificates.certificate() !== null)
    this.options.changed()
  }
}

const KEYCHAIN_SERVICE = 'valet.relay-certificate'

/** The certificate's state in Valet's own Keychain item, one per name. */
export function keychainCertificateStore(keychain: KeychainStore, account: string): CertificateStore {
  return {
    async load() {
      try {
        const secret = await keychain.read(KEYCHAIN_SERVICE, account)
        try {
          return secret.reveal((text) => JSON.parse(text) as StoredCertificate)
        } finally {
          secret.dispose()
        }
      } catch {
        return null
      }
    },
    async save(state) {
      await keychain.write(
        KEYCHAIN_SERVICE,
        account,
        Buffer.from(JSON.stringify(state), 'utf8'),
        'Valet: this Mac’s certificate for remote access',
      )
    },
  }
}

/** The same in a file only this user can read, for development builds without the helper. */
export function fileCertificateStore(path: string): CertificateStore {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as StoredCertificate
      } catch {
        return null
      }
    },
    async save(state) {
      await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    },
  }
}

/** Valet's relay (docs/blind-relay.md#deploying): the Fly app, Macs under valet.dncr.me. */
export const VALET_RELAY: BlindRelaySetup = { controlHost: 'relay.valet.dncr.me', macDomain: 'valet.dncr.me' }

/**
 * The blind relay this run uses. A release uses Valet's relay. A development build does too,
 * unless the environment names another: VALET_BLIND_RELAY (control host, or `off`),
 * VALET_BLIND_MAC_DOMAIN, and for a local one VALET_BLIND_RELAY_CONNECT and VALET_ACME_DIRECTORY.
 * Demo and e2e runs use one only when the environment names it, so tests never reach the real one.
 */
export function blindRelaySetup(
  env: NodeJS.ProcessEnv,
  run: { readonly release: boolean; readonly test: boolean },
): BlindRelaySetup | null {
  if (run.release) return VALET_RELAY
  if (env['VALET_BLIND_RELAY'] === 'off') return null
  return blindRelayFromEnv(env) ?? (run.test ? null : VALET_RELAY)
}

/**
 * Whether a development build should sign in software for this relay: only for one the environment
 * named (a local relay in an e2e run), never for Valet's own. Valet's relay keeps the Mac's Secure
 * Enclave keys, or a Mac on it would become a different Mac and lose everything approved before.
 */
export function relayWantsSoftwareKeys(setup: BlindRelaySetup | null): boolean {
  return setup !== null && setup !== VALET_RELAY
}

/** A blind relay named in the environment (see blindRelaySetup), or null. */
export function blindRelayFromEnv(env: NodeJS.ProcessEnv): BlindRelaySetup | null {
  const controlHost = env['VALET_BLIND_RELAY']
  const macDomain = env['VALET_BLIND_MAC_DOMAIN']
  if (controlHost === undefined || macDomain === undefined) return null
  if (!HOST.test(controlHost) || !HOST.test(macDomain)) return null
  const connect = env['VALET_BLIND_RELAY_CONNECT']
  const acme = env['VALET_ACME_DIRECTORY']
  return {
    controlHost,
    macDomain,
    ...(connect !== undefined && /^wss?:\/\/[a-z0-9.-]+(:\d+)?$/.test(connect)
      ? { connectUrl: connect }
      : {}),
    ...(acme !== undefined && /^https?:\/\/[^\s]+$/.test(acme) ? { acmeDirectory: acme } : {}),
  }
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
