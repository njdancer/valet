// "My Cloudflare account" in the app (docs/cloudflare-tunnel.md): connecting provisions the tunnel,
// adds its name to remote access's public names (a widening, so it is signed like any added name),
// keeps the tokens in Valet's own Keychain item and runs cloudflared while the listener is up.
// Disconnecting stops cloudflared, takes the name away at once and removes what Valet made in the
// account.

import { existsSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { KeychainStore } from '@valet/credentials'
import type { CloudflareConnectAnswer, CloudflareTunnelView } from '../../shared/api'
import {
  CloudflareApi,
  Cloudflared,
  type CloudflaredOptions,
  CloudflareSetupError,
  parseStoredTunnel,
  provisionCloudflareTunnel,
  removeCloudflareTunnel,
  type StoredCloudflareTunnel,
} from './cloudflare-tunnel'

/** Where the stored tunnel lives: Valet's Keychain item, or a 0600 file without the helper. */
export interface CloudflareTunnelStore {
  load(): Promise<string | null>
  save(text: string): Promise<void>
  remove(): Promise<void>
}

export type CloudflareView = CloudflareTunnelView

export interface CloudflareRemoteOptions {
  readonly store: CloudflareTunnelStore
  /** The bundled cloudflared, or null when this build has none. */
  readonly binary: CloudflaredOptions['command'] | null
  /** The remote listener's loopback URL while it is up, `http://127.0.0.1:<port>/mcp`, else null. */
  readonly listenerUrl: () => string | null
  /** Adds the name to remote access's public names, with the person's approval; throws if refused. */
  readonly addHost: (host: string) => Promise<void>
  /** Takes the name away at once. */
  readonly removeHost: (host: string) => Promise<void>
  readonly changed: () => void
  readonly log?: (line: string) => void
  readonly fetch?: typeof fetch
  readonly apiBase?: string
  readonly backoff?: CloudflaredOptions['backoff']
}

export class CloudflareRemote {
  private stored: StoredCloudflareTunnel | null = null
  private runner: Cloudflared | null = null
  private busy: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: CloudflareRemoteOptions) {}

  private api(token: string): CloudflareApi {
    return new CloudflareApi({
      token,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.apiBase === undefined ? {} : { base: this.options.apiBase }),
    })
  }

  private serially<T>(step: () => Promise<T>): Promise<T> {
    const next = this.busy.then(step, step)
    this.busy = next.catch(() => undefined)
    return next
  }

  /** Loads the tunnel kept from last time, if any, and runs it when the listener is up. */
  start(): Promise<void> {
    return this.serially(async () => {
      const text = await this.options.store.load().catch(() => null)
      this.stored = text === null ? null : parseStoredTunnel(text)
      await this.syncNow()
    })
  }

  /** Remote access changed: run cloudflared while the listener is up, else stop it. */
  sync(): Promise<void> {
    return this.serially(() => this.syncNow())
  }

  get view(): CloudflareView | null {
    const stored = this.stored
    if (stored === null) return null
    if (this.options.binary === null) return { hostname: stored.hostname, state: 'no-binary' }
    if (this.runner === null) return { hostname: stored.hostname, state: 'waiting-for-listener' }
    return { hostname: stored.hostname, state: this.runner.status.state }
  }

  connect(apiToken: string, hostname: string): Promise<CloudflareConnectAnswer> {
    return this.serially(async () => {
      if (this.options.binary === null) return 'no-binary'
      const origin = originOf(this.options.listenerUrl())
      if (origin === null) return 'remote-off'
      const api = this.api(apiToken.trim())
      let stored: StoredCloudflareTunnel
      try {
        stored = await provisionCloudflareTunnel({
          api,
          apiToken: apiToken.trim(),
          hostname,
          tunnelName: `valet-${hostname.trim().toLowerCase()}`,
          origin,
        })
      } catch (error) {
        if (error instanceof CloudflareSetupError) return error.problem
        throw error
      }
      try {
        await this.options.addHost(stored.hostname)
      } catch {
        // Not approved: nothing serves the name, and nothing Valet made stays in the account.
        await removeCloudflareTunnel(api, stored).catch(() => undefined)
        return 'refused'
      }
      const previous = this.stored
      await this.options.store.save(JSON.stringify(stored))
      this.stored = stored
      if (previous !== null && previous.hostname !== stored.hostname) {
        await this.options.removeHost(previous.hostname).catch(() => undefined)
        await removeCloudflareTunnel(this.api(previous.apiToken), previous).catch(() => undefined)
      }
      this.stopRunner()
      await this.syncNow()
      return 'connected'
    })
  }

  /** Returns whether Cloudflare took the tunnel and record away too; locally it is gone either way. */
  disconnect(): Promise<'removed' | 'left-in-cloudflare'> {
    return this.serially(async () => {
      const stored = this.stored
      this.stopRunner()
      this.stored = null
      if (stored === null) return 'removed'
      await this.options.removeHost(stored.hostname).catch(() => undefined)
      await this.options.store.remove().catch(() => undefined)
      this.options.changed()
      try {
        await removeCloudflareTunnel(this.api(stored.apiToken), stored)
        return 'removed'
      } catch (error) {
        this.options.log?.(`[cloudflare] couldn’t remove the tunnel: ${String(error)}`)
        return 'left-in-cloudflare'
      }
    })
  }

  stop(): void {
    this.stopRunner()
  }

  private stopRunner(): void {
    this.runner?.stop()
    this.runner = null
  }

  private async syncNow(): Promise<void> {
    const stored = this.stored
    const binary = this.options.binary
    const origin = originOf(this.options.listenerUrl())
    if (stored === null || binary === null || origin === null) {
      if (this.runner !== null) {
        this.stopRunner()
        this.options.changed()
      }
      return
    }
    if (this.runner !== null) return
    if (stored.origin !== origin) {
      // The listener came up on another port: point the tunnel at it before running it.
      try {
        await this.api(stored.apiToken).configure(stored.accountId, stored.tunnelId, stored.hostname, origin)
        const moved = { ...stored, origin }
        await this.options.store.save(JSON.stringify(moved))
        this.stored = moved
      } catch (error) {
        this.options.log?.(`[cloudflare] couldn’t move the tunnel to ${origin}: ${String(error)}`)
      }
    }
    this.runner = new Cloudflared({
      command: binary,
      token: stored.tunnelToken,
      onStatus: () => this.options.changed(),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
      ...(this.options.backoff === undefined ? {} : { backoff: this.options.backoff }),
    })
    this.runner.start()
  }
}

/** `http://127.0.0.1:<port>` from the listener's URL, or null. */
export function originOf(url: string | null): string | null {
  if (url === null) return null
  const match = url.match(/^(http:\/\/127\.0\.0\.1:\d{1,5})(\/|$)/)
  return match === null ? null : (match[1] as string)
}

const KEYCHAIN_SERVICE = 'valet.cloudflare-tunnel'
const KEYCHAIN_ACCOUNT = 'default'

/** The tunnel's tokens in Valet's own Keychain item. */
export function keychainTunnelStore(keychain: KeychainStore): CloudflareTunnelStore {
  return {
    async load() {
      try {
        const secret = await keychain.read(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        try {
          return secret.reveal((text) => text)
        } finally {
          secret.dispose()
        }
      } catch {
        return null
      }
    },
    save: (text) =>
      keychain.write(
        KEYCHAIN_SERVICE,
        KEYCHAIN_ACCOUNT,
        Buffer.from(text, 'utf8'),
        'Valet: your Cloudflare tunnel for remote access',
      ),
    remove: () => keychain.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT),
  }
}

/** The same in a file only this user can read, for development builds without the helper. */
export function fileTunnelStore(path: string): CloudflareTunnelStore {
  return {
    async load() {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    async save(text) {
      await writeFile(`${path}.tmp`, text, { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    },
    remove: () => rm(path, { force: true }),
  }
}

/**
 * A development build's cloudflared: VALET_CLOUDFLARED, an absolute path to the binary, or a
 * `.mjs` stand-in (run with this Node, for e2e). Anything else is none.
 */
export function cloudflaredFromEnv(value: string | undefined): CloudflaredOptions['command'] | null {
  if (value === undefined || !value.startsWith('/') || !existsSync(value)) return null
  // Electron's own binary runs a script as Node only when told to.
  return value.endsWith('.mjs')
    ? { file: process.execPath, args: [value], env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { file: value }
}
