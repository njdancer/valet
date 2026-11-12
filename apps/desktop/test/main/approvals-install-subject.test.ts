// @vitest-environment node
// The signed install subject's permission lines come from the Mac's own diff, with B's risks.

import { isDisplayText, parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { installSubject, permissionChanges } from '../../src/main/core/approvals'
import { showable } from '../../src/main/core/approvals/install-subject'
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

  it('shows where a secret may be typed, so moving it to another origin is seen', () => {
    const moved = parseManifest({
      ...SHOP,
      navigation: [...SHOP.navigation, 'https://evil.example'],
      secrets: {
        login: {
          description: 'Shop account',
          fields: ['username', 'password'],
          origins: ['https://evil.example'],
        },
      },
    })
    const lines = permissionChanges(before, moved, false).filter((l) => l.area === 'secret')
    expect(lines).toContainEqual(
      expect.objectContaining({
        change: 'added',
        items: ['login: username, password into https://evil.example'],
      }),
    )
  })

  it('never drops a line it can’t print: hidden characters are written out, and the risk is kept', () => {
    const hidden = parseManifest({
      ...SHOP,
      requests: [{ method: 'POST', path: `/orders\u200B${'x'.repeat(250)}`, purpose: 'irreversible' }],
    })
    const [line] = permissionChanges(null, hidden, false).filter((l) => l.area === 'requests')
    expect(line?.risk).toBe('high')
    const item = line?.items[0] ?? ''
    expect(item).toContain('\\u{200B}')
    expect(item.endsWith('(irreversible)')).toBe(true)
    expect(item.length).toBeLessThanOrEqual(200)
    expect(isDisplayText(item)).toBe(true)
  })

  it('counts by what the subject’s schema counts, and says how many items it left out', () => {
    expect(showable('a\u0000b')).toBe('a\\u{0}b')
    const wide = parseManifest({ ...SHOP, egress: Array.from({ length: 60 }, (_, i) => `h${i}.example`) })
    const [line] = permissionChanges(null, wide, false).filter((l) => l.area === 'egress')
    expect(line?.items).toHaveLength(50)
    expect(line?.items.at(-1)).toBe('and 11 more not shown')
    // Emoji are two units each: a long path of them still fits the schema's 200.
    const emoji = parseManifest({
      ...SHOP,
      requests: [{ method: 'GET', path: `/${'😀'.repeat(149)}`, purpose: 'read' }],
    })
    const [paths] = permissionChanges(null, emoji, false).filter((l) => l.area === 'requests')
    expect(paths?.items[0]?.length).toBeLessThanOrEqual(200)
  })

  it('carries the sandbox’s own lines: a command exception says it can read your files, critical', () => {
    const withCommand = parseManifest({
      ...SHOP,
      sandbox: {
        mode: 'sandboxed',
        exceptions: [{ kind: 'command', path: '/usr/bin/sips', purpose: 'resize' }],
      },
    })
    const lines = permissionChanges(before, withCommand, false)
    expect(lines).toContainEqual({
      area: 'sandbox-exception',
      change: 'added',
      items: ['Run /usr/bin/sips, which can read your files'],
      risk: 'critical',
    })
    // Becoming unsandboxed is one critical line, not two.
    const off = parseManifest({ ...SHOP, sandbox: { mode: 'unsandboxed', reason: 'needs Node' } })
    expect(permissionChanges(before, off, true).filter((l) => l.area === 'sandbox-mode')).toHaveLength(1)
  })
})
