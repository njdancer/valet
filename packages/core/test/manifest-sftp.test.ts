// `protocol` adapters with protocols.sftp (docs/sftp.md#the-manifest): what a manifest may declare,
// and the card lines an install or update shows.

import { describe, expect, it } from 'vitest'
import { type ManifestInput, manifestSchema, parseManifest } from '../src/manifest'
import { isHostKeyFingerprint } from '../src/protocols'
import { describeSftpServer, runtimePermissionChanges } from '../src/runtime-diff'

const PIN = 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s'

const NAS: ManifestInput = {
  schemaVersion: 1,
  id: 'nas-files',
  name: 'NAS files',
  version: '0.1.0',
  description: 'Reads and files documents on the NAS.',
  runtime: 'protocol',
  protocols: {
    sftp: {
      endpoint: 'nas.example.com:22',
      credential: 'nas',
      hostKeySha256: PIN,
      username: 'nick',
      roots: [
        { path: '/volume1/docs', access: 'read' },
        { path: '/volume1/inbox', access: 'write' },
      ],
    },
  },
  credentials: {
    nas: {
      description: 'A key Valet made for the NAS',
      kind: 'ssh-key',
      custody: 'kept',
      use: { protocol: 'sftp', endpoint: 'nas.example.com:22' },
    },
  },
  tools: [
    { name: 'list_docs', title: 'List documents', description: 'Lists documents.', sideEffect: 'read' },
    { name: 'file_doc', title: 'File a document', description: 'Files a document.', sideEffect: 'write' },
  ],
} as ManifestInput

const copy = (): any => structuredClone(NAS)
const issues = (input: unknown): string[] => {
  const result = manifestSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => i.message)
}

describe('protocols.sftp', () => {
  it('parses, with home the server’s name', () => {
    const m = parseManifest(copy())
    expect(m.home).toBe('https://nas.example.com/')
    expect(m.protocols?.sftp?.roots).toHaveLength(2)
    expect(parseManifest(m)).toEqual(m)
  })

  it('takes a private address, never a public one', () => {
    const input = copy()
    input.protocols.sftp.endpoint = '192.168.1.20:22'
    input.credentials.nas.use.endpoint = '192.168.1.20:22'
    expect(parseManifest(input).home).toBe('https://192.168.1.20/')
    const v6 = copy()
    v6.protocols.sftp.endpoint = 'fd00::5:22'
    v6.credentials.nas.use.endpoint = 'fd00::5:22'
    expect(parseManifest(v6).home).toBe('https://[fd00::5]/')
    for (const bad of [
      '8.8.8.8:22',
      '127.0.0.1:22',
      '[fd00::5]:22',
      'nas.example.com',
      'NAS.example.com:22',
    ]) {
      const input = copy()
      input.protocols.sftp.endpoint = bad
      input.credentials.nas.use.endpoint = bad
      expect(issues(input).length, bad).toBeGreaterThan(0)
    }
  })

  it('needs a kept ssh-key credential for exactly this endpoint', () => {
    const wrongEndpoint = copy()
    wrongEndpoint.credentials.nas.use.endpoint = 'other.example.com:22'
    expect(issues(wrongEndpoint)).toContain(
      'protocols.sftp: credential nas must be a kept ssh-key for sftp at nas.example.com:22',
    )
    const password = copy()
    password.credentials.nas.kind = 'password'
    expect(issues(password)).toContain(
      'protocols.sftp: credential nas must be a kept ssh-key for sftp at nas.example.com:22',
    )
    const missing = copy()
    missing.protocols.sftp.credential = 'other'
    expect(issues(missing)).toContain('protocols.sftp: credential other is not declared in credentials')
    const extra = copy()
    extra.credentials.mail = {
      description: 'x',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'imap', endpoint: 'imap.mail.me.com:993' },
    }
    expect(issues(extra)).toContain("credential mail: a protocol credential that protocols.sftp doesn't use")
  })

  it('pins the host key in ssh-keygen’s form', () => {
    expect(isHostKeyFingerprint(PIN)).toBe(true)
    for (const bad of [
      'uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
      'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2',
      'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2t',
      'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s=',
      'MD5:aa:bb',
    ]) {
      expect(isHostKeyFingerprint(bad), bad).toBe(false)
      const input = copy()
      input.protocols.sftp.hostKeySha256 = bad
      expect(issues(input).length).toBeGreaterThan(0)
    }
    const missing = copy()
    delete missing.protocols.sftp.hostKeySha256
    expect(issues(missing).length).toBeGreaterThan(0)
  })

  it('takes roots in Valet’s path form, each once', () => {
    for (const bad of ['volume1', '/volume1/', '/volume1/../etc', '/a//b', `/${'x'.repeat(151)}`]) {
      const input = copy()
      input.protocols.sftp.roots = [{ path: bad, access: 'read' }]
      expect(issues(input).length, bad).toBeGreaterThan(0)
    }
    const twice = copy()
    twice.protocols.sftp.roots.push({ path: '/volume1/docs', access: 'write' })
    expect(issues(twice)).toContain('protocols.sftp.roots lists a path twice')
    const none = copy()
    none.protocols.sftp.roots = []
    expect(issues(none).length).toBeGreaterThan(0)
    const access = copy()
    access.protocols.sftp.roots[0].access = 'delete'
    expect(issues(access).length).toBeGreaterThan(0)
  })

  it('refuses imap and sftp together, and sftp outside a protocol adapter', () => {
    const both = copy()
    both.protocols.imap = { endpoint: 'imap.mail.me.com:993', credential: 'nas' }
    expect(issues(both)).toContain('a protocol adapter uses one protocol: imap or sftp, not both')
    const http = copy()
    http.runtime = 'http'
    http.egress = ['api.example.com']
    expect(issues(http)).toContain('protocols is only for protocol adapters')
  })

  it('takes a username of at most 32 safe characters', () => {
    for (const bad of ['', 'a b', 'x'.repeat(33), 'nick;rm', '-nick']) {
      const input = copy()
      input.protocols.sftp.username = bad
      expect(issues(input).length, bad).toBeGreaterThan(0)
    }
  })
})

describe('the card', () => {
  const m = parseManifest(copy())
  it('shows the server, its pinned key, and each root by what it allows', () => {
    expect(runtimePermissionChanges(null, m)).toEqual([
      {
        area: 'runtime',
        change: 'added',
        items: ['Uses mail or file protocols through Valet'],
        risk: 'medium',
      },
      {
        area: 'egress',
        change: 'added',
        items: ['SFTP as nick to nas.example.com:22', `host key ${PIN}`],
        risk: 'medium',
      },
      {
        area: 'requests',
        change: 'added',
        items: ['Read, add, append to and rename files in /volume1/inbox'],
        risk: 'medium',
      },
      { area: 'requests', change: 'added', items: ['Read files in /volume1/docs'], risk: 'low' },
    ])
  })

  it('shows a NAS on the person’s network as high', () => {
    const input = copy()
    input.protocols.sftp.endpoint = '192.168.1.20:22'
    input.credentials.nas.use.endpoint = '192.168.1.20:22'
    const local = parseManifest(input)
    expect(describeSftpServer(local.protocols?.sftp as never)[0]).toBe(
      'SFTP as nick to 192.168.1.20:22 on your network',
    )
    expect(runtimePermissionChanges(null, local)).toContainEqual(
      expect.objectContaining({ area: 'private-network', change: 'added', risk: 'high' }),
    )
  })

  it('shows a new host key, a wider root, and a new delete root on update', () => {
    const next = copy()
    next.protocols.sftp.hostKeySha256 = 'SHA256:AAAAztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s'
    next.protocols.sftp.roots[0].access = 'write'
    next.protocols.sftp.roots.push({ path: '/', access: 'irreversible' })
    const changes = runtimePermissionChanges(m, parseManifest(next))
    expect(changes).toEqual([
      {
        area: 'egress',
        change: 'added',
        items: [
          'SFTP as nick to nas.example.com:22',
          'host key SHA256:AAAAztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
        ],
        risk: 'medium',
      },
      {
        area: 'egress',
        change: 'removed',
        items: ['SFTP as nick to nas.example.com:22', `host key ${PIN}`],
        risk: 'low',
      },
      {
        area: 'requests',
        change: 'added',
        items: [
          'Read, add, append to, rename, replace and delete files in / (everything this account can reach)',
        ],
        risk: 'high',
      },
      {
        area: 'requests',
        change: 'added',
        items: ['Read, add, append to and rename files in /volume1/docs'],
        risk: 'medium',
      },
      { area: 'requests', change: 'removed', items: ['Read files in /volume1/docs'], risk: 'low' },
    ])
    expect(runtimePermissionChanges(m, m)).toEqual([])
  })

  it('keeps every item within a card line', () => {
    const long = copy()
    long.protocols.sftp.username = 'u'.repeat(32)
    long.protocols.sftp.endpoint = `${'a'.repeat(60)}.${'b'.repeat(39)}:65535`
    long.credentials.nas.use.endpoint = long.protocols.sftp.endpoint
    long.protocols.sftp.roots = [{ path: `/${'p'.repeat(139)}`, access: 'irreversible' }]
    for (const change of runtimePermissionChanges(null, parseManifest(long)))
      for (const item of change.items) expect(item.length).toBeLessThanOrEqual(200)
  })
})
