import { describe, expect, it } from 'vitest'
import { describePrivateHost, describeRuntime, runtimePermissionChanges } from '../src/runtime-diff'

describe('runtimePermissionChanges', () => {
  it('says nothing for a browser adapter', () => {
    expect(runtimePermissionChanges(null, {})).toEqual([])
    expect(runtimePermissionChanges({}, { runtime: 'browser' })).toEqual([])
  })

  it('names a first install that is not a browser adapter, and a change of kind', () => {
    expect(runtimePermissionChanges(null, { runtime: 'http' })).toEqual([
      { area: 'runtime', change: 'added', items: [describeRuntime('http')], risk: 'medium' },
    ])
    expect(runtimePermissionChanges({ runtime: 'http' }, {})).toEqual([
      { area: 'runtime', change: 'added', items: [describeRuntime('browser')], risk: 'low' },
    ])
    expect(runtimePermissionChanges({}, { runtime: 'raw' })[0]?.risk).toBe('critical')
    expect(runtimePermissionChanges({ runtime: 'http' }, { runtime: 'http' })).toEqual([])
  })

  it('rates each added private host high and a removed one low', () => {
    const a = { address: '192.168.1.20', port: 8123, scheme: 'http' as const }
    const b = { address: 'fd00::5', port: 443, certSha256: 'ab'.repeat(32) }
    expect(
      runtimePermissionChanges(
        { runtime: 'http', privateHosts: [a] },
        { runtime: 'http', privateHosts: [b] },
      ),
    ).toEqual([
      { area: 'private-network', change: 'added', items: [describePrivateHost(b)], risk: 'high' },
      { area: 'private-network', change: 'removed', items: [describePrivateHost(a)], risk: 'low' },
    ])
  })

  it('treats a changed scheme or pin as a new host', () => {
    const a = { address: '10.0.0.5', port: 443 }
    const pinned = { ...a, certSha256: 'cd'.repeat(32) }
    const lines = runtimePermissionChanges(
      { runtime: 'http', privateHosts: [pinned] },
      { runtime: 'http', privateHosts: [a] },
    )
    expect(lines.map((l) => l.change)).toEqual(['added', 'removed'])
  })

  it('describes hosts plainly', () => {
    expect(describePrivateHost({ address: '192.168.1.20', port: 8123, scheme: 'http' })).toBe(
      '192.168.1.20:8123 on your network (unencrypted http)',
    )
    expect(describePrivateHost({ address: 'fd00::5', port: 443 })).toBe(
      '[fd00::5]:443 on your network (https)',
    )
    expect(describePrivateHost({ address: '10.0.0.5', port: 443, certSha256: 'ab'.repeat(32) })).toBe(
      '10.0.0.5:443 on your network (https, certificate abababababab…)',
    )
  })
})
