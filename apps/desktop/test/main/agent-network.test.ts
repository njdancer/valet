// Each agent's browser network (src/main/core/agent-network.ts, electron/public-dial.ts): stored per
// agent, off by default, named on approval cards with the agent in the name, widening only when it
// reaches more, and dialled so a session never reaches this Mac or leaves by another interface.

import { mkdtemp, rm } from 'node:fs/promises'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentNetworkStore,
  DEFAULT_NETWORK,
  listInterfaces,
  networkChangeWidens,
  networkSettingName,
  networkSettingOf,
  networkSettingValue,
  networkSettingWords,
} from '../../src/main/core/agent-network'
import { agentSessionDial, isHomeAddress, type Lookup } from '../../src/main/electron/public-dial'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const LOCAL = 'local:c_0123456789abcdef'
const REMOTE = 'remote:abc_123'

describe('an agent’s browser network', () => {
  it('is the narrow default until set, per agent, and back to no entry at the default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-network-'))
    dirs.push(dir)
    const store = new AgentNetworkStore(join(dir, 'agent-network.json'))
    expect(await store.get(LOCAL)).toEqual(DEFAULT_NETWORK)
    expect(await store.set(LOCAL, { homeNetwork: true })).toEqual({ homeNetwork: true, interface: null })
    await store.set(REMOTE, { interface: 'vlan20' })
    expect(await store.get(LOCAL)).toEqual({ homeNetwork: true, interface: null })
    expect(await store.get(REMOTE)).toEqual({ homeNetwork: false, interface: 'vlan20' })
    await store.forget(LOCAL)
    expect(await store.get(LOCAL)).toEqual(DEFAULT_NETWORK)
    await expect(store.set('local:../x', { homeNetwork: true })).rejects.toThrow()
    // Forgetting is best effort: revoking an agent never fails on its network settings.
    await expect(store.forget('local:../x')).resolves.toBeUndefined()
    expect(await store.get('__proto__')).toEqual(DEFAULT_NETWORK)
  })

  it('names its settings with the agent in the name, and reads them back', () => {
    const home = networkSettingName(REMOTE, 'home')
    expect(home).toBe('bnet_home_r_abc_123')
    expect(networkSettingOf(home ?? '')).toEqual({ key: REMOTE, which: 'home' })
    expect(networkSettingOf(networkSettingName(LOCAL, 'nic') ?? '')).toEqual({ key: LOCAL, which: 'nic' })
    expect(networkSettingName('remote:Bad-Id', 'home')).toBeNull()
    expect(networkSettingOf('remote_ask_abc')).toBeNull()
    expect(networkSettingOf('bnet_home_l_nope')).toBeNull()
  })

  it('words values as cards show them, and reads only those words back', () => {
    expect(networkSettingWords('home', { homeNetwork: true, interface: null })).toBe('On')
    expect(networkSettingWords('nic', DEFAULT_NETWORK)).toBe('Automatic')
    expect(networkSettingValue('home', 'Off')).toEqual({ homeNetwork: false })
    expect(networkSettingValue('nic', 'Automatic')).toEqual({ interface: null })
    expect(networkSettingValue('nic', 'vlan20')).toEqual({ interface: 'vlan20' })
    expect(networkSettingValue('nic', 'en0; rm')).toBeNull()
    expect(networkSettingValue('home', 'Yes')).toBeNull()
  })

  it('widens only when it reaches more', () => {
    const on = { homeNetwork: true, interface: 'en0' }
    expect(networkChangeWidens('home', DEFAULT_NETWORK, { homeNetwork: true })).toBe(true)
    expect(networkChangeWidens('home', on, { homeNetwork: false })).toBe(false)
    expect(networkChangeWidens('nic', DEFAULT_NETWORK, { interface: 'vlan20' })).toBe(true)
    expect(networkChangeWidens('nic', on, { interface: 'vlan20' })).toBe(true)
    expect(networkChangeWidens('nic', on, { interface: null })).toBe(false)
  })

  it('lists interfaces a session could leave from, IPv4 first, without loopback or link-local only', () => {
    expect(
      listInterfaces(() => ({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        en0: [
          { address: 'fe80::1', family: 'IPv6', internal: false },
          { address: '2001:db8::5', family: 'IPv6', internal: false },
          { address: '192.168.1.20', family: 'IPv4', internal: false },
        ],
        awdl0: [{ address: 'fe80::2', family: 'IPv6', internal: false }],
        vlan20: [{ address: '10.20.0.5', family: 4, internal: false }],
      })),
    ).toEqual([
      {
        name: 'en0',
        addresses: [
          { address: '192.168.1.20', family: 4 },
          { address: '2001:db8::5', family: 6 },
        ],
      },
      { name: 'vlan20', addresses: [{ address: '10.20.0.5', family: 4 }] },
    ])
  })
})

describe('a browser session’s dial with network settings', () => {
  const macInterfaces = () => ({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    vlan20: [{ address: '10.20.0.5', family: 'IPv4', internal: false }],
  })
  const closed = (socket: Socket) => {
    socket.on('error', () => undefined)
    return new Promise<void>((resolve) => socket.once('close', () => resolve()))
  }
  const at =
    (address: string, family = 4): Lookup =>
    (_host, cb) =>
      cb(null, [{ address, family }])

  it('knows a home address from loopback, link-local and public ones', () => {
    for (const a of [
      '10.1.2.3',
      '172.16.0.9',
      '192.168.1.1',
      '100.101.102.103',
      'fd7a:115c:a1e0::1',
      '::ffff:192.168.0.2',
    ])
      expect(isHomeAddress(a), a).toBe(true)
    for (const a of ['127.0.0.1', '169.254.169.254', '::1', 'fe80::1', '8.8.8.8', '172.32.0.1', 'nope'])
      expect(isHomeAddress(a), a).toBe(false)
  })

  it('reaches the home network only when on, and never this Mac’s own address or loopback', async () => {
    const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
      return this
    })
    const off = agentSessionDial(DEFAULT_NETWORK, { resolve: at('192.168.1.1'), interfaces: macInterfaces })(
      'router.test',
      443,
    )
    await closed(off)
    const on = { homeNetwork: true, interface: null }
    agentSessionDial(on, { resolve: at('192.168.1.1'), interfaces: macInterfaces })('router.test', 443)
    expect(connect).toHaveBeenLastCalledWith({ host: '192.168.1.1', port: 443 })
    const calls = connect.mock.calls.length
    await closed(
      agentSessionDial(on, { resolve: at('192.168.1.20'), interfaces: macInterfaces })('me.test', 443),
    )
    await closed(
      agentSessionDial(on, { resolve: at('127.0.0.1'), interfaces: macInterfaces })('lo.test', 443),
    )
    expect(connect.mock.calls.length).toBe(calls)
  })

  it('leaves from the pinned interface, and refuses rather than leave another way', async () => {
    const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
      return this
    })
    const pinned = { homeNetwork: false, interface: 'vlan20' }
    agentSessionDial(pinned, { resolve: at('93.184.216.34'), interfaces: macInterfaces })('site.test', 443)
    expect(connect).toHaveBeenLastCalledWith({ host: '93.184.216.34', port: 443, localAddress: '10.20.0.5' })
    const calls = connect.mock.calls.length
    // No IPv6 address on vlan20: refused, not sent out by the default route.
    await closed(
      agentSessionDial(pinned, { resolve: at('2001:db8::1', 6), interfaces: macInterfaces })('v6.test', 443),
    )
    await closed(
      agentSessionDial(
        { homeNetwork: false, interface: 'en7' },
        { resolve: at('93.184.216.34'), interfaces: macInterfaces },
      )('gone.test', 443),
    )
    expect(connect.mock.calls.length).toBe(calls)
  })
})
