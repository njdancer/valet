// @vitest-environment node
// Red-team sweep (2026-11-17): an SFTP update that REMOVES a read-only root nested inside a broader
// writable/irreversible root is an escalation of that nested subtree, but Valet reports it as a
// narrowing. The deepest root decides what a path may do (sftp-policy.ts), so once the narrow
// read-only root is gone the broad root's access applies to the whole subtree. Yet:
//   - widenedSftpRoots / credentialCarriesOver only test the SURVIVING roots' own paths, never the
//     area a removed root used to protect, so the kept SSH key's grant silently carries over;
//   - sftpPermissionChanges / permissionChanges emit only a low-risk "removed: Read files in …"
//     line, never an "added" line for the newly writable subtree;
//   - addsPermissions therefore returns false, so the Mac review treats the update as adding no
//     permissions.
// A tool that before could only READ /share/readonly can, after this "narrowing" update, DELETE and
// REPLACE files there, with no re-approval and no card line saying so.
//
// Fixed in the same change: escalatedSftpPaths (core protocols.ts) counts such a subtree as widened,
// so the card gets a 'widened' line, addsPermissions is true and the grant doesn't carry over.

import type { CredentialGrant, ManifestInput } from '@valet/core'
import { parseManifest, rootAllows } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { permissionChanges } from '../../src/main/core/approvals/install-subject'
import { credentialCarriesOver } from '../../src/main/core/grants'
import { addsPermissions, permissionDiff } from '../../src/main/core/permission-diff'

const NAS = 'nas.example.com:22'
const PIN = 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s'

type Sftp = NonNullable<NonNullable<ManifestInput['protocols']>['sftp']>
const version = (roots: Sftp['roots'], v: string) =>
  parseManifest({
    schemaVersion: 1,
    id: 'nas-files',
    name: 'NAS files',
    version: v,
    description: 'Files documents on the NAS.',
    runtime: 'protocol',
    protocols: {
      sftp: { endpoint: NAS, credential: 'nas', hostKeySha256: PIN, username: 'alex', roots },
    },
    credentials: {
      nas: {
        description: 'A key Valet made',
        kind: 'ssh-key',
        custody: 'kept',
        use: { protocol: 'sftp', endpoint: NAS },
      },
    },
    // A tool allowed to do the most, so its host could delete/replace once the root allows it.
    tools: [{ name: 'file', title: 'File', description: 'Files.', sideEffect: 'irreversible' }],
  } as ManifestInput)

// v1: the whole share is writable/irreversible, but one sub-folder is pinned read-only.
const v1 = version(
  [
    { path: '/share', access: 'irreversible' },
    { path: '/share/readonly', access: 'read' },
  ],
  '1.0.0',
)
// v2: the read-only pin is dropped. The person is told a read permission was removed.
const v2 = version([{ path: '/share', access: 'irreversible' }], '1.1.0')

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

describe('removing a nested read-only SFTP root silently widens that subtree', () => {
  const v1Roots = v1.protocols?.sftp?.roots ?? []
  const v2Roots = v2.protocols?.sftp?.roots ?? []
  const victim = '/share/readonly/accounts.csv'

  it('actually escalates the nested subtree from read to irreversible', () => {
    // Ground truth: the policy the host enforces now lets the tool delete/replace in the subtree.
    expect(rootAllows(victim, v1Roots, 'irreversible')).toBe(false) // v1: read-only
    expect(rootAllows(victim, v2Roots, 'irreversible')).toBe(true) // v2: deletable/replaceable
  })

  it('the review reports the escalation as a new permission', () => {
    const diff = permissionDiff(v1, v2)
    // The escalation is real (previous test), so the review must flag it. It does not.
    expect(addsPermissions(diff)).toBe(true)
    const changes = permissionChanges(v1, v2, false)
    expect(changes.some((c) => c.change === 'added' || c.change === 'widened')).toBe(true)
  })

  it('the kept SSH key grant does not carry over the escalation', () => {
    // The grant covers the one endpoint; the update gives the key power over a formerly
    // read-only area, so it must be re-approved. It is not.
    expect(credentialCarriesOver(grant, v1, v2)).toBe(false)
  })
})
