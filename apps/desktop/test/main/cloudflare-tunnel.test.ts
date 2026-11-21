// @vitest-environment node
// "My Cloudflare account" on its own: the API calls against a stand-in Cloudflare that keeps zones,
// tunnels and DNS records and checks the token, and cloudflared's runner against a script that
// behaves like it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CloudflareApi,
  Cloudflared,
  type CloudflaredStatus,
  CloudflareSetupError,
  parseStoredTunnel,
  provisionCloudflareTunnel,
  removeCloudflareTunnel,
} from '../../src/main/core/cloudflare-tunnel'
import { ACCOUNT, type FakeCloudflare, fakeCloudflare, TOKEN, ZONE } from '../fixtures/fake-cloudflare'

const provision = (cf: FakeCloudflare, overrides: Partial<{ token: string; hostname: string }> = {}) =>
  provisionCloudflareTunnel({
    api: new CloudflareApi({ token: overrides.token ?? TOKEN, fetch: cf.fetch }),
    apiToken: overrides.token ?? TOKEN,
    hostname: overrides.hostname ?? 'Valet.Example.com',
    tunnelName: 'valet-mac1',
    origin: 'http://127.0.0.1:48100',
  })

describe('provisioning a tunnel in the person’s account', () => {
  it('makes the tunnel, sends only that name to the listener, and adds a proxied record', async () => {
    const cf = fakeCloudflare()
    const stored = await provision(cf)
    expect(stored.hostname).toBe('valet.example.com')
    expect(stored.accountId).toBe(ACCOUNT)
    expect(stored.zoneId).toBe(ZONE)
    expect(stored.tunnelToken).toBe(`tunnel-token-for-${stored.tunnelId}`)
    expect(cf.tunnels.get(stored.tunnelId)?.config).toEqual({
      ingress: [
        { hostname: 'valet.example.com', service: 'http://127.0.0.1:48100', originRequest: {} },
        { service: 'http_status:404' },
      ],
    })
    expect(cf.records.get(stored.dnsRecordId)).toEqual({
      name: 'valet.example.com',
      type: 'CNAME',
      content: `${stored.tunnelId}.cfargotunnel.com`,
      proxied: true,
    })
    // It round-trips through the Keychain item's text.
    expect(parseStoredTunnel(JSON.stringify(stored))).toEqual(stored)
    expect(parseStoredTunnel('{"version":2}')).toBeNull()
    expect(parseStoredTunnel('not json')).toBeNull()
  })

  it('running it again reuses the tunnel and the record', async () => {
    const cf = fakeCloudflare()
    const first = await provision(cf)
    const again = await provision(cf)
    expect(again.tunnelId).toBe(first.tunnelId)
    expect(again.dnsRecordId).toBe(first.dnsRecordId)
    expect(cf.tunnels.size).toBe(1)
    expect(cf.records.size).toBe(1)
  })

  it('leaves a record it didn’t make alone', async () => {
    const cf = fakeCloudflare()
    cf.records.set('c'.repeat(32), {
      name: 'valet.example.com',
      type: 'A',
      content: '192.0.2.1',
      proxied: false,
    })
    await expect(provision(cf)).rejects.toMatchObject({ problem: 'name-taken' })
    expect(cf.records.get('c'.repeat(32))?.content).toBe('192.0.2.1')
  })

  it('says which problem it hit: token, permission, zone, name, network', async () => {
    const cf = fakeCloudflare()
    await expect(provision(cf, { token: 'wrong' })).rejects.toMatchObject({ problem: 'token' })
    await expect(provision(cf, { hostname: 'valet.elsewhere.org' })).rejects.toMatchObject({
      problem: 'zone',
    })
    await expect(provision(cf, { hostname: 'not a name' })).rejects.toMatchObject({ problem: 'zone' })
    cf.dnsWrite = false
    await expect(provision(cf)).rejects.toMatchObject({ problem: 'permission' })
    const offline = new CloudflareApi({
      token: TOKEN,
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    await expect(offline.findZone('valet.example.com')).rejects.toBeInstanceOf(CloudflareSetupError)
    await expect(offline.findZone('valet.example.com')).rejects.toMatchObject({ problem: 'network' })
    const garbled = new CloudflareApi({
      token: TOKEN,
      fetch: (async () => new Response('<html>')) as typeof fetch,
    })
    await expect(garbled.findZone('valet.example.com')).rejects.toMatchObject({ problem: 'cloudflare' })
  })

  it('removing takes away the record and the tunnel', async () => {
    const cf = fakeCloudflare()
    const stored = await provision(cf)
    await removeCloudflareTunnel(new CloudflareApi({ token: TOKEN, fetch: cf.fetch }), stored)
    expect(cf.records.size).toBe(0)
    expect(cf.tunnels.get(stored.tunnelId)?.deleted).toBe(true)
    expect(cf.calls.slice(-3)).toEqual([
      `DELETE /zones/${ZONE}/dns_records/${stored.dnsRecordId}`,
      `DELETE /accounts/${ACCOUNT}/cfd_tunnel/${stored.tunnelId}/connections`,
      `DELETE /accounts/${ACCOUNT}/cfd_tunnel/${stored.tunnelId}`,
    ])
  })
})

describe('running cloudflared', () => {
  const dirs: string[] = []
  const runners: Cloudflared[] = []
  afterEach(() => {
    for (const r of runners.splice(0)) r.stop()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** A stand-in cloudflared: checks its arguments and token, says it registered, exits on cue. */
  function fakeBinary(behaviour: 'stay' | 'exit'): string {
    const dir = mkdtempSync(join(tmpdir(), 'valet-cloudflared-'))
    dirs.push(dir)
    const path = join(dir, 'cloudflared.mjs')
    writeFileSync(
      path,
      `const args = process.argv.slice(2).join(' ')
if (args !== 'tunnel --no-autoupdate run') { process.stderr.write('bad args ' + args + '\\n'); process.exit(2) }
if (process.env.TUNNEL_TOKEN !== 'the-token') { process.stderr.write('no token\\n'); process.exit(3) }
if (process.env.SECRET_FROM_VALET !== undefined) { process.stderr.write('leaked env\\n'); process.exit(4) }
process.stderr.write('INF Registered tunnel connection connIndex=0\\n')
${behaviour === 'exit' ? 'setTimeout(() => process.exit(1), 50)' : 'setInterval(() => {}, 1000)'}
`,
    )
    return path
  }

  function run(script: string) {
    const statuses: CloudflaredStatus[] = []
    const lines: string[] = []
    process.env['SECRET_FROM_VALET'] = 'x'
    const runner = new Cloudflared({
      command: { file: process.execPath, args: [script] },
      token: 'the-token',
      onStatus: (s) => statuses.push(s),
      log: (l) => lines.push(l),
      backoff: { minMs: 50, maxMs: 200 },
    })
    runners.push(runner)
    runner.start()
    delete process.env['SECRET_FROM_VALET']
    return { runner, statuses, lines }
  }

  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('connects with its token in its environment only, and stops when asked', async () => {
    const { runner, lines } = run(fakeBinary('stay'))
    await until(() => runner.status.state === 'connected')
    expect(lines.some((l) => l.includes('Registered tunnel connection'))).toBe(true)
    runner.stop()
    expect(runner.status.state).toBe('stopped')
  })

  it('starts it again with backoff when it exits', async () => {
    const { runner, statuses } = run(fakeBinary('exit'))
    await until(() => statuses.filter((s) => s.state === 'connected').length >= 2)
    const restart = statuses.find((s) => s.state === 'restarting')
    expect(restart).toMatchObject({ state: 'restarting', exitCode: 1 })
    runner.stop()
    const count = statuses.length
    await new Promise((r) => setTimeout(r, 300))
    expect(statuses.length).toBe(count)
  })

  it('a binary that isn’t there is retried, not thrown', async () => {
    const runner = new Cloudflared({
      command: { file: '/nonexistent/cloudflared' },
      token: 'the-token',
      backoff: { minMs: 50, maxMs: 100 },
    })
    runners.push(runner)
    runner.start()
    await until(() => runner.status.state === 'restarting')
    runner.stop()
  })
})
