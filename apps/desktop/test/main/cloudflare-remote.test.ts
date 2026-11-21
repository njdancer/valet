// @vitest-environment node
// "My Cloudflare account" as the app runs it: connecting asks for the name like any added public
// name, keeps the tokens in the store, and runs cloudflared only while the listener is up;
// disconnecting takes it all away again.

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryKeychain } from '@valet/credentials'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CloudflareRemote,
  type CloudflareTunnelStore,
  cloudflaredFromEnv,
  fileTunnelStore,
  keychainTunnelStore,
  originOf,
} from '../../src/main/core/cloudflare-remote'
import { parseStoredTunnel } from '../../src/main/core/cloudflare-tunnel'
import { type FakeCloudflare, fakeCloudflare, TOKEN } from '../fixtures/fake-cloudflare'

const dirs: string[] = []
const remotes: CloudflareRemote[] = []
afterEach(() => {
  for (const r of remotes.splice(0)) r.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'valet-cf-'))
  dirs.push(dir)
  return dir
}

/** A cloudflared that says it registered and stays up. */
function standIn(): string {
  const path = join(tempDir(), 'cloudflared.mjs')
  writeFileSync(
    path,
    `process.stderr.write('INF Registered tunnel connection connIndex=0\\n')\nsetInterval(() => {}, 1000)\n`,
  )
  return path
}

function memoryStore(): CloudflareTunnelStore & { text: string | null } {
  return {
    text: null,
    async load() {
      return this.text
    },
    async save(text) {
      this.text = text
    },
    async remove() {
      this.text = null
    },
  }
}

interface Rig {
  readonly cf: FakeCloudflare
  readonly remote: CloudflareRemote
  readonly store: ReturnType<typeof memoryStore>
  hosts: string[]
  listener: string | null
  approve: boolean
}

function rig(
  options: { store?: ReturnType<typeof memoryStore>; cf?: FakeCloudflare; binary?: boolean } = {},
): Rig {
  const cf = options.cf ?? fakeCloudflare()
  const store = options.store ?? memoryStore()
  const state = {
    hosts: [] as string[],
    listener: 'http://127.0.0.1:48100/mcp' as string | null,
    approve: true,
  }
  const remote = new CloudflareRemote({
    store,
    binary: options.binary === false ? null : { file: process.execPath, args: [standIn()] },
    listenerUrl: () => state.listener,
    addHost: async (host) => {
      if (!state.approve) throw new Error('declined')
      state.hosts = [...state.hosts, host]
    },
    removeHost: async (host) => {
      state.hosts = state.hosts.filter((h) => h !== host)
    },
    changed: () => {},
    fetch: cf.fetch,
    backoff: { minMs: 50, maxMs: 100 },
  })
  remotes.push(remote)
  return Object.assign(state, { cf, remote, store }) as Rig
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('CloudflareRemote', () => {
  it('connects: makes the tunnel, adds the name, keeps the tokens, runs cloudflared', async () => {
    const r = rig()
    expect(r.remote.view).toBeNull()
    expect(await r.remote.connect(` ${TOKEN} `, 'valet.example.com')).toBe('connected')
    expect(r.hosts).toEqual(['valet.example.com'])
    const stored = parseStoredTunnel(r.store.text as string)
    expect(stored?.apiToken).toBe(TOKEN)
    expect(stored?.origin).toBe('http://127.0.0.1:48100')
    await until(() => r.remote.view?.state === 'connected')
    expect(r.remote.view).toEqual({ hostname: 'valet.example.com', state: 'connected' })
  })

  it('needs remote access on, and says what Cloudflare refused', async () => {
    const r = rig()
    r.listener = null
    expect(await r.remote.connect(TOKEN, 'valet.example.com')).toBe('remote-off')
    r.listener = 'http://127.0.0.1:48100/mcp'
    expect(await r.remote.connect('wrong', 'valet.example.com')).toBe('token')
    expect(await r.remote.connect(TOKEN, 'valet.other.org')).toBe('zone')
    expect(r.hosts).toEqual([])
    expect(r.store.text).toBeNull()
  })

  it('a name the person doesn’t approve leaves nothing behind in the account', async () => {
    const r = rig()
    r.approve = false
    expect(await r.remote.connect(TOKEN, 'valet.example.com')).toBe('refused')
    expect(r.cf.records.size).toBe(0)
    expect([...r.cf.tunnels.values()].every((t) => t.deleted)).toBe(true)
    expect(r.store.text).toBeNull()
    expect(r.remote.view).toBeNull()
  })

  it('a build without cloudflared doesn’t offer to connect', async () => {
    const r = rig({ binary: false })
    expect(await r.remote.connect(TOKEN, 'valet.example.com')).toBe('no-binary')
    expect(r.cf.calls).toEqual([])
  })

  it('runs only while the listener is up, and comes back after a restart', async () => {
    const r = rig()
    await r.remote.connect(TOKEN, 'valet.example.com')
    await until(() => r.remote.view?.state === 'connected')
    r.listener = null
    await r.remote.sync()
    expect(r.remote.view?.state).toBe('waiting-for-listener')
    r.remote.stop()
    // A new launch with the same store, the listener on another port this time.
    const again = rig({ store: r.store, cf: r.cf })
    again.listener = 'http://127.0.0.1:48200/mcp'
    await again.remote.start()
    await until(() => again.remote.view?.state === 'connected')
    const stored = parseStoredTunnel(r.store.text as string)
    expect(stored?.origin).toBe('http://127.0.0.1:48200')
    const config = r.cf.tunnels.get(stored?.tunnelId as string)?.config as { ingress: { service: string }[] }
    expect(config.ingress[0]?.service).toBe('http://127.0.0.1:48200')
  })

  it('disconnecting stops it, takes the name away and removes the tunnel and record', async () => {
    const r = rig()
    await r.remote.connect(TOKEN, 'valet.example.com')
    expect(await r.remote.disconnect()).toBe('removed')
    expect(r.hosts).toEqual([])
    expect(r.store.text).toBeNull()
    expect(r.remote.view).toBeNull()
    expect(r.cf.records.size).toBe(0)
    expect([...r.cf.tunnels.values()].every((t) => t.deleted)).toBe(true)
    // Nothing connected: nothing to do.
    expect(await r.remote.disconnect()).toBe('removed')
  })

  it('disconnects locally even when Cloudflare can’t be reached, and says so', async () => {
    const cf = fakeCloudflare()
    const r = rig({ cf })
    await r.remote.connect(TOKEN, 'valet.example.com')
    const stored = parseStoredTunnel(r.store.text as string)
    r.store.text = JSON.stringify({ ...stored, apiToken: 'revoked' })
    r.remote.stop()
    const again = rig({ store: r.store, cf })
    await again.remote.start()
    expect(await again.remote.disconnect()).toBe('left-in-cloudflare')
    expect(again.store.text).toBeNull()
  })

  it('connecting with another name replaces the first', async () => {
    const r = rig()
    await r.remote.connect(TOKEN, 'valet.example.com')
    await r.remote.connect(TOKEN, 'mac.example.com')
    expect(r.hosts).toEqual(['mac.example.com'])
    expect([...r.cf.records.values()].map((x) => x.name)).toEqual(['mac.example.com'])
  })
})

describe('where the tunnel is kept, and which cloudflared', () => {
  it('Keychain item and 0600 file', async () => {
    const keychain = new MemoryKeychain()
    const kept = keychainTunnelStore(keychain)
    expect(await kept.load()).toBeNull()
    await kept.save('{"x":1}')
    expect(await kept.load()).toBe('{"x":1}')
    await kept.remove()
    expect(await kept.load()).toBeNull()
    const path = join(tempDir(), 'cloudflare-tunnel.json')
    const file = fileTunnelStore(path)
    expect(await file.load()).toBeNull()
    await file.save('{"x":2}')
    expect(await file.load()).toBe('{"x":2}')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await file.remove()
    expect(await file.load()).toBeNull()
  })

  it('a development build’s cloudflared, and the listener’s origin', () => {
    expect(cloudflaredFromEnv(undefined)).toBeNull()
    expect(cloudflaredFromEnv('relative/cloudflared')).toBeNull()
    expect(cloudflaredFromEnv('/nonexistent/cloudflared')).toBeNull()
    const script = standIn()
    expect(cloudflaredFromEnv(script)).toEqual({
      file: process.execPath,
      args: [script],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(cloudflaredFromEnv(process.execPath)).toEqual({ file: process.execPath })
    expect(originOf('http://127.0.0.1:48100/mcp')).toBe('http://127.0.0.1:48100')
    expect(originOf('http://127.0.0.1:48100')).toBe('http://127.0.0.1:48100')
    expect(originOf('https://evil.example/mcp')).toBeNull()
    expect(originOf(null)).toBeNull()
  })
})
