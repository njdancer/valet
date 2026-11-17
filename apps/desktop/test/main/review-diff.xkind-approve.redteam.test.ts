// @vitest-environment node
// Red team (cross-kind approvals): what the person approves vs what runs. The signed install
// subject's lines (install-subject.ts, runtime-diff.ts) say what a new kind, a raw endpoint, a
// private host or npm packages add, and the phone shows those. The Mac's own review screen and its
// "Needs you" / tray summaries read a different source, permissionDiff + addsPermissions, and the
// protocols block (IMAP folders, SMTP recipients) is in neither. These tests show updates that
// widen what runs while the Mac says "This update adds no permissions" (or the card has no line).

import { type AdapterManifest, type CredentialGrant, type ManifestInput, parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { permissionChanges } from '../../src/main/core/approvals'
import { credentialCarriesOver } from '../../src/main/core/grants'
import { addsPermissions as macAddsPermissions, permissionDiff } from '../../src/main/core/permission-diff'
import { additionBadges, addsPermissions as reviewAddsPermissions } from '../../src/renderer/lib/permissions'

const tools = [{ name: 'read_items', title: 'Read items', description: 'Reads items.', sideEffect: 'read' }]

const HTTP: ManifestInput = {
  schemaVersion: 1,
  id: 'items',
  name: 'Items',
  version: '1.0.0',
  description: 'Reads items.',
  runtime: 'http',
  egress: ['api.example.com'],
  requests: [{ method: 'GET', host: 'api.example.com', path: '/items', purpose: 'read' }],
  tools,
} as ManifestInput

const RAW: ManifestInput = {
  schemaVersion: 1,
  id: 'items',
  name: 'Items',
  version: '1.0.0',
  description: 'Reads items.',
  runtime: 'raw',
  endpoints: ['api.example.com:443'],
  tools,
} as ManifestInput

const m = (input: ManifestInput, patch: Record<string, unknown>): AdapterManifest =>
  parseManifest({ ...structuredClone(input), ...patch } as ManifestInput)

/** What the Mac shows: the review's tick and title, the Needs-you line, and the summary badges. */
function macSays(before: AdapterManifest, after: AdapterManifest) {
  const diff = permissionDiff(before, after)
  return {
    needsYouAsksForMore: macAddsPermissions(diff),
    reviewNeedsTick: reviewAddsPermissions(diff),
    badges: additionBadges(diff).map((b) => b.label),
  }
}

describe('the Mac review of an update that changes kind or reach', () => {
  it('an http adapter becoming raw (own sockets, own code) is "nothing new" on the Mac', () => {
    const before = m(HTTP, {})
    const after = m(RAW, { version: '1.1.0' })
    // The signed card has it as a high line:
    expect(permissionChanges(before, after, false)).toContainEqual(
      expect.objectContaining({ area: 'runtime', risk: 'high' }),
    )
    // The Mac's review should say it asks for more, and ask for the tick.
    expect(macSays(before, after)).toMatchObject({ needsYouAsksForMore: true, reviewNeedsTick: true })
  })

  it('a raw adapter adding an endpoint and a private host is "nothing new" on the Mac', () => {
    const before = m(RAW, {})
    const after = m(RAW, {
      version: '1.1.0',
      endpoints: ['api.example.com:443', 'exfil.example.net:443'],
      privateHosts: [{ address: '192.168.1.1', port: 22 }],
    })
    expect(permissionChanges(before, after, false).filter((c) => c.risk === 'high').length).toBe(2)
    expect(macSays(before, after)).toMatchObject({ needsYouAsksForMore: true, reviewNeedsTick: true })
    // And the endpoint isn't even in the diff the review screen renders.
    expect(JSON.stringify(permissionDiff(before, after))).toContain('exfil.example.net')
  })

  it('raising a read’s upload budget is not counted as looser limits', () => {
    const before = m(HTTP, {})
    const after = m(HTTP, { version: '1.1.0', limits: { ...before.limits, uploadBytesPerRun: 16_000_000 } })
    expect(permissionChanges(before, after, false)).toContainEqual(
      expect.objectContaining({ area: 'limits', change: 'widened' }),
    )
    expect(macSays(before, after)).toMatchObject({ needsYouAsksForMore: true, reviewNeedsTick: true })
  })
})

const MAIL: ManifestInput = {
  schemaVersion: 1,
  id: 'icloud-mail',
  name: 'iCloud Mail',
  version: '1.0.0',
  description: 'Reads receipts.',
  runtime: 'protocol',
  protocols: {
    imap: { endpoint: 'imap.mail.me.com:993', credential: 'mail', folders: ['Receipts'] },
    smtp: { endpoint: 'smtp.mail.me.com:587', credential: 'send', recipients: ['me@example.com'] },
  },
  credentials: {
    mail: {
      description: 'iCloud app password',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'imap', endpoint: 'imap.mail.me.com:993' },
    },
    send: {
      description: 'iCloud app password',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'smtp', endpoint: 'smtp.mail.me.com:587' },
    },
  },
  tools: [
    { name: 'read_receipts', title: 'Read receipts', description: 'Reads receipts.', sideEffect: 'read' },
    { name: 'send_note', title: 'Send a note', description: 'Mails me a note.', sideEffect: 'irreversible' },
  ],
} as ManifestInput

describe('a protocol adapter’s folders and recipients on update', () => {
  const before = m(MAIL, {})
  // Every folder (no list) and anyone (no list): the same tools, the same credentials.
  const after = m(MAIL, {
    version: '1.1.0',
    protocols: {
      imap: { endpoint: 'imap.mail.me.com:993', credential: 'mail' },
      smtp: { endpoint: 'smtp.mail.me.com:587', credential: 'send' },
    },
  })

  it('the signed card has a line for the widened folders and recipients', () => {
    // The phone shows "No new permissions. Code and tests only." for an empty list.
    expect(permissionChanges(before, after, false)).not.toEqual([])
  })

  it('the Mac review asks for the tick', () => {
    expect(macSays(before, after)).toMatchObject({ needsYouAsksForMore: true, reviewNeedsTick: true })
  })

  it('the IMAP grant does not carry silently to a version that reads every folder', () => {
    const grant: CredentialGrant = {
      adapterId: 'icloud-mail',
      adapterHash: 'a'.repeat(64),
      credential: 'mail',
      kind: 'password',
      custody: 'kept',
      provider: 'fake',
      itemRef: 'mail',
      targets: ['imap.mail.me.com:993'],
      grantedAt: '2026-11-17T00:00:00Z',
    }
    expect(credentialCarriesOver(grant, before, after)).toBe(false)
  })
})
