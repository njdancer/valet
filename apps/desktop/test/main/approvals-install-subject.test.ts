// @vitest-environment node
// The signed install subject's permission lines come from the Mac's own diff, with B's risks.

import { parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { installSubject, permissionChanges } from '../../src/main/core/approvals'
import { SHOP, SHOP_FILES } from './fixtures'

const before = parseManifest(SHOP)
const after = parseManifest({
  ...SHOP,
  version: '2.0.0',
  egress: [...SHOP.egress, 'tracker.example'],
  requests: [...(SHOP.requests ?? []), { method: 'POST', path: '/api/order', purpose: 'irreversible' }],
})

describe('permissionChanges', () => {
  it('lists what widens with its risk, and an unsandboxed adapter as critical', () => {
    const lines = permissionChanges(before, after, true)
    expect(lines[0]).toMatchObject({ area: 'sandbox-mode', change: 'added', risk: 'critical' })
    expect(lines).toContainEqual({
      area: 'egress',
      change: 'added',
      items: ['tracker.example'],
      risk: 'medium',
    })
    expect(lines).toContainEqual({
      area: 'requests',
      change: 'added',
      items: ['POST /api/order (irreversible)'],
      risk: 'high',
    })
    expect(permissionChanges(before, before, false)).toEqual([])
  })

  it('builds a subject with the Mac’s facts, never the adapter’s claims', () => {
    const subject = installSubject({
      manifest: after,
      hash: 'a'.repeat(64),
      files: SHOP_FILES,
      previous: { hash: 'b'.repeat(64), manifest: before },
      source: 'local-folder',
      inheritsSession: true,
      unsandboxed: false,
    })
    expect(subject).toMatchObject({
      adapterId: 'shop',
      version: '2.0.0',
      previousHash: 'b'.repeat(64),
      references: [],
      unsandboxed: false,
    })
    expect(subject.changes.some((c) => c.area === 'sandbox-mode')).toBe(false)
  })
})
