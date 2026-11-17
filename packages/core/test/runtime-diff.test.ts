import { describe, expect, it } from 'vitest'
import { approvableOn } from '../src/approvals'
import {
  dependencyPermissionChanges,
  describePrivateHost,
  describeRawEndpoint,
  describeRuntime,
  runtimePermissionChanges,
} from '../src/runtime-diff'

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
    // High, not critical: raw is approved on the phone like everything else (Nick, 2026-11-17).
    expect(runtimePermissionChanges({}, { runtime: 'raw' })[0]?.risk).toBe('high')
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

describe('raw adapters on the card', () => {
  it('lists each added endpoint high and each removed one low', () => {
    expect(
      runtimePermissionChanges(
        { runtime: 'raw', endpoints: ['imap.example.com:993'] },
        { runtime: 'raw', endpoints: ['api.example.com:443'] },
      ),
    ).toEqual([
      { area: 'egress', change: 'added', items: [describeRawEndpoint('api.example.com:443')], risk: 'high' },
      {
        area: 'egress',
        change: 'removed',
        items: [describeRawEndpoint('imap.example.com:993')],
        risk: 'low',
      },
    ])
  })

  it('says a private host carries the adapter’s own connection', () => {
    const lines = runtimePermissionChanges(null, {
      runtime: 'raw',
      privateHosts: [{ address: '192.168.1.20', port: 8123 }],
    })
    expect(lines).toContainEqual({
      area: 'private-network',
      change: 'added',
      items: ['192.168.1.20:8123 on your network (its own connection)'],
      risk: 'high',
    })
  })

  it('is approvable on the phone: nothing on a raw card is critical', () => {
    const changes = [
      ...runtimePermissionChanges(null, { runtime: 'raw', endpoints: ['imap.example.com:993'] }),
      ...dependencyPermissionChanges({
        lockfileVersion: 1,
        dependencies: { imapflow: { range: '^1.0.0', resolved: 'imapflow@1.0.1' } },
        packages: {
          'imapflow@1.0.1': {
            integrity: `sha512-${'A'.repeat(86)}==`,
            tarball: 'https://registry.npmjs.org/imapflow/-/imapflow-1.0.1.tgz',
            dependencies: {},
          },
        },
      }),
    ]
    expect(changes.every((c) => c.risk !== 'critical')).toBe(true)
    const subject = {
      adapterId: 'mail',
      adapterName: 'Mail',
      version: '0.1.0',
      adapterHash: 'a'.repeat(64),
      packageHash: 'b'.repeat(64),
      previousHash: null,
      source: 'draft',
      inheritsSession: false,
      references: [],
      changes,
      unsandboxed: false,
    } as const
    expect(approvableOn('adapter-install', subject as never)).toContain('phone')
  })

  it('names the direct npm packages and counts the rest', () => {
    expect(dependencyPermissionChanges(null)).toEqual([])
    const lines = dependencyPermissionChanges({
      lockfileVersion: 1,
      dependencies: { b: { range: '*', resolved: 'b@2.0.0' }, a: { range: '*', resolved: 'a@1.0.0' } },
      packages: {
        'a@1.0.0': {
          integrity: `sha512-${'A'.repeat(86)}==`,
          tarball: 'https://x/a.tgz',
          dependencies: { c: 'c@3.0.0' },
        },
        'b@2.0.0': { integrity: `sha512-${'B'.repeat(86)}==`, tarball: 'https://x/b.tgz', dependencies: {} },
        'c@3.0.0': { integrity: `sha512-${'C'.repeat(86)}==`, tarball: 'https://x/c.tgz', dependencies: {} },
      },
    })
    expect(lines).toEqual([
      {
        area: 'runtime',
        change: 'added',
        items: ['npm package a 1.0.0', 'npm package b 2.0.0', 'and 1 package they use'],
        risk: 'high',
      },
    ])
  })
})
