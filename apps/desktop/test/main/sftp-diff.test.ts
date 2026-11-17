// @vitest-environment node
// An SFTP adapter's update (docs/sftp.md#the-approval-card): a new or wider root, or another server,
// account or host key, is a permission the review asks about and the card shows, and the kept key's
// grant doesn't carry over to it. A narrower root list carries over.

import type { CredentialGrant, ManifestInput } from '@valet/core'
import { parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { permissionChanges } from '../../src/main/core/approvals/install-subject'
import { credentialCarriesOver } from '../../src/main/core/grants'
import { addsPermissions, permissionDiff } from '../../src/main/core/permission-diff'

const NAS = 'nas.example.com:22'
const PIN = 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s'
const OTHER_PIN = 'SHA256:AAAAztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s'

type Sftp = NonNullable<NonNullable<ManifestInput['protocols']>['sftp']>
const version = (sftp: Partial<Sftp>, v = '1.0.0') =>
  parseManifest({
    schemaVersion: 1,
    id: 'nas-files',
    name: 'NAS files',
    version: v,
    description: 'Files documents on the NAS.',
    runtime: 'protocol',
    protocols: {
      sftp: {
        endpoint: NAS,
        credential: 'nas',
        hostKeySha256: PIN,
        username: 'alex',
        roots: [
          { path: '/docs', access: 'read' },
          { path: '/inbox', access: 'write' },
        ],
        ...sftp,
      },
    },
    credentials: {
      nas: {
        description: 'A key Valet made',
        kind: 'ssh-key',
        custody: 'kept',
        use: { protocol: 'sftp', endpoint: NAS },
      },
    },
    tools: [{ name: 'file', title: 'File', description: 'Files.', sideEffect: 'write' }],
  } as ManifestInput)

const v1 = version({})
const grant: CredentialGrant = {
  adapterId: 'nas-files',
  adapterHash: 'a'.repeat(64),
  credential: 'nas',
  kind: 'ssh-key',
  custody: 'kept',
  provider: 'valet-key',
  itemRef: 'valet-key:nas',
  targets: [NAS],
  grantedAt: '2026-11-17T00:00:00.000Z',
}

describe('an SFTP adapter’s update', () => {
  const widenings: [string, Partial<Sftp>][] = [
    [
      'a read root made writable',
      {
        roots: [
          { path: '/docs', access: 'write' },
          { path: '/inbox', access: 'write' },
        ],
      },
    ],
    ['a new root', { roots: [...(v1.protocols?.sftp?.roots ?? []), { path: '/photos', access: 'read' }] }],
    [
      'a root moved up to its parent',
      {
        roots: [
          { path: '/', access: 'read' },
          { path: '/inbox', access: 'write' },
        ],
      },
    ],
    ['another host key', { hostKeySha256: OTHER_PIN }],
    ['another account', { username: 'root' }],
  ]

  it.each(widenings)('asks about %s, shows it, and doesn’t carry the key over', (_, change) => {
    const v2 = version(change, '1.1.0')
    expect(addsPermissions(permissionDiff(v1, v2))).toBe(true)
    expect(permissionChanges(v1, v2, false).some((c) => c.change === 'added' || c.change === 'widened')).toBe(
      true,
    )
    expect(credentialCarriesOver(grant, v1, v2)).toBe(false)
  })

  it('carries the key over a narrower root list, and an unchanged one', () => {
    expect(credentialCarriesOver(grant, v1, version({}, '1.0.1'))).toBe(true)
    const narrower = version({ roots: [{ path: '/inbox', access: 'read' }] }, '1.0.2')
    expect(credentialCarriesOver(grant, v1, narrower)).toBe(true)
    expect(addsPermissions(permissionDiff(v1, narrower))).toBe(false)
  })
})
