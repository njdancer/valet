// @vitest-environment node
// RemoteAccess's policy and file on their own, with a stand-in listener, and the tray's wording.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDeclaration } from '@valet/core'
import type { RemoteListenerOptions, RunningRemoteListener } from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteAccess, type RemoteStatus } from '../../src/main/core/remote'
import { remoteTrayState } from '../../src/main/core/tray-remote'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const declaration = (name: string, sideEffect: ToolDeclaration['sideEffect']): ToolDeclaration => ({
  name,
  title: name,
  description: name,
  sideEffect,
})

function make(file?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'sa-remote-'))
  dirs.push(dir)
  const path = join(dir, 'remote.json')
  if (file !== undefined) writeFileSync(path, typeof file === 'string' ? file : JSON.stringify(file))
  const starts: RemoteListenerOptions[] = []
  let closes = 0
  const start = async (options: RemoteListenerOptions): Promise<RunningRemoteListener> => {
    starts.push(options)
    const port = options.port === 0 || options.port === undefined ? 41234 : options.port
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      port,
      refresh: () => [],
      sessions: () => ({ total: 0, bridge: 0, http: 0, sessions: [] }),
      endClient: async () => {},
      close: async () => {
        closes++
      },
    }
  }
  const remote = new RemoteAccess({
    path,
    clientsPath: join(dir, 'remote-clients.json'),
    info: { name: 'valet', version: '0.1.0' },
    now: () => Date.parse('2026-11-08T00:00:00.000Z'),
    changed: () => {},
    audit: async () => {},
    refused: async () => {},
    start,
  })
  const caller = { listTools: () => [], call: async () => ({ status: 'declined' as const }) }
  return { remote, path, starts, closes: () => closes, caller }
}

describe('the remote policy', () => {
  it('denies every tool by default', async () => {
    const { remote, caller } = make()
    await remote.start(caller)
    expect(remote.allows('shop', declaration('echo', 'read'))).toBe(false)
  })

  it('allows a tool once turned on, and only at the side effect it had then', async () => {
    const { remote, caller } = make()
    await remote.start(caller)
    await remote.setTool('shop', declaration('add', 'write'), true)
    expect(remote.allows('shop', declaration('add', 'write'))).toBe(true)
    expect(remote.allows('shop', declaration('add', 'read'))).toBe(true)
    // An update that makes it irreversible turns it off until the person looks again.
    expect(remote.allows('shop', declaration('add', 'irreversible'))).toBe(false)
    expect(remote.allows('other', declaration('add', 'write'))).toBe(false)

    await remote.setTool('shop', declaration('add', 'write'), false)
    expect(remote.allows('shop', declaration('add', 'write'))).toBe(false)
  })

  it('reads a file that doesn’t validate as off with nothing enabled', async () => {
    const { remote, caller, starts } = make({ enabled: true, port: 1, hosts: ['127.0.0.1'], tools: {} })
    await remote.start(caller)
    expect(remote.status()).toMatchObject({ enabled: false, hosts: [], tools: [] })
    expect(starts).toHaveLength(0)
  })

  it('keeps the port it first listened on', async () => {
    const { remote, caller, path, starts } = make()
    await remote.start(caller)
    await remote.setEnabled(true)
    expect(starts[0]?.port).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8')).port).toBe(41234)
    await remote.setEnabled(false)
    await remote.setEnabled(true)
    expect(starts[1]?.port).toBe(41234)
  })

  it('binds nothing but loopback: the listener is never given a host to bind', async () => {
    const { remote, caller, starts } = make()
    await remote.start(caller)
    await remote.setEnabled(true)
    expect(starts[0]).not.toHaveProperty('host')
  })

  it('answers for the relay’s name beside the tunnel’s while the relay runs, and only while on', async () => {
    const { remote, caller, starts } = make()
    await remote.start(caller)
    expect(remote.relayListener()).toBeNull()
    remote.setRelayHost('m1.relay.example')
    expect(remote.status().relayUrl).toBe('https://m1.relay.example/mcp')
    expect(remote.relayConsent('c1', '', null)).toEqual({ state: 'expired' })
    await remote.setEnabled(true)
    expect(remote.relayListener()).toBe('http://127.0.0.1:41234/mcp')
    expect([...(starts[0]?.hosts() ?? [])]).toEqual(['m1.relay.example'])
    remote.setRelayHost(null)
    expect(remote.status().relayUrl).toBeNull()
    expect([...(starts[0]?.hosts() ?? [])]).toEqual([])
    await remote.setEnabled(false)
    expect(remote.relayListener()).toBeNull()
  })
})

describe('the tray', () => {
  const status = (over: Partial<RemoteStatus> = {}): RemoteStatus => ({
    enabled: false,
    listening: false,
    url: null,
    hosts: [],
    relayUrl: null,
    clients: 0,
    pendingConsents: 0,
    sessions: 0,
    tools: [],
    ...over,
  })

  it('says nothing and offers nothing when remote access was never set up', () => {
    expect(remoteTrayState(status(), false)).toEqual({
      title: '',
      tooltip: 'Valet',
      menuItem: null,
      revokeAll: false,
    })
  })

  it('shows REMOTE beside the icon and offers the kill switch while on', () => {
    expect(remoteTrayState(status({ enabled: true, listening: true, sessions: 1 }), false)).toEqual({
      title: 'REMOTE',
      tooltip: 'Valet: remote access on, 1 remote session',
      menuItem: { label: 'Pause remote access', enable: false },
      revokeAll: false,
    })
    expect(remoteTrayState(status({ enabled: true }), true)).toMatchObject({
      title: 'DEMO · REMOTE',
      tooltip: 'Valet (demo): remote access on, not listening',
    })
  })

  it('carries the Needs you count beside the icon, before the other words', () => {
    expect(remoteTrayState(status(), false, 2)).toMatchObject({
      title: '2',
      tooltip: 'Valet, 2 waiting for you',
    })
    expect(remoteTrayState(status({ enabled: true, listening: true }), true, 1)).toMatchObject({
      title: '1 · DEMO · REMOTE',
      tooltip: 'Valet (demo), 1 waiting for you: remote access on, 0 remote sessions',
    })
    expect(remoteTrayState(status(), false, 0).title).toBe('')
  })

  it('offers resuming once paused with a name set up', () => {
    expect(remoteTrayState(status({ hosts: ['mac.ts.net'] }), true)).toEqual({
      title: 'DEMO',
      tooltip: 'Valet (demo)',
      menuItem: { label: 'Resume remote access', enable: true },
      revokeAll: false,
    })
  })

  it('offers revoking every remote client while any is kept, paused or not', () => {
    expect(remoteTrayState(status({ clients: 2 }), false).revokeAll).toBe(true)
    expect(remoteTrayState(status({ enabled: true, clients: 1 }), false).revokeAll).toBe(true)
  })
})
