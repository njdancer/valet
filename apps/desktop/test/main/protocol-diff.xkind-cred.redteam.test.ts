// @vitest-environment node
// Red team, cross-kind credentials (workstream I): what a kept mail credential is used for widens,
// yet the permission diff shows nothing and the review page says "This update adds no
// permissions" (no acknowledgement tick), while the credential grant carries over silently.
// The card not listing folders and recipients is a known decision (adapter-kinds.md, G); the
// review page stating that nothing widened, and the grant carrying, are the part shown here.
// Each `it` states what SHOULD hold; a failing test is a demonstrated hole.

import type { CredentialGrant, ManifestInput } from '@valet/core'
import { parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { permissionChanges } from '../../src/main/core/approvals/install-subject'
import { credentialCarriesOver } from '../../src/main/core/grants'
import { addsPermissions, permissionDiff } from '../../src/main/core/permission-diff'

const IMAP = 'imap.mail.me.com:993'
const SMTP = 'smtp.mail.me.com:587'
const base = (protocols: ManifestInput['protocols']): ManifestInput => ({
  schemaVersion: 1,
  id: 'mailer',
  name: 'Mailer',
  version: '1.0.0',
  description: 'Files receipts and sends mail to my team.',
  runtime: 'protocol',
  protocols,
  credentials: {
    mail: {
      description: 'iCloud',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'imap', endpoint: IMAP },
    },
    send: {
      description: 'iCloud',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'smtp', endpoint: SMTP },
    },
  },
  tools: [
    { name: 'file', title: 'File', description: 'Moves receipts.', sideEffect: 'write' },
    { name: 'send', title: 'Send', description: 'Sends mail.', sideEffect: 'irreversible' },
  ],
})
const v1 = parseManifest(
  base({
    imap: { endpoint: IMAP, credential: 'mail', folders: ['Receipts', 'Archive'] },
    smtp: { endpoint: SMTP, credential: 'send', recipients: ['@team.example'] },
  }),
)
// v2: the write tool now reaches every folder (INBOX included), and send goes to anyone.
const v2 = parseManifest({
  ...base({ imap: { endpoint: IMAP, credential: 'mail' }, smtp: { endpoint: SMTP, credential: 'send' } }),
  version: '1.1.0',
})

const grant = (credential: string, target: string): CredentialGrant => ({
  adapterId: 'mailer',
  adapterHash: 'a'.repeat(64),
  credential,
  kind: 'password',
  custody: 'kept',
  provider: 'onepassword-service-account',
  itemRef: 'op://Valet/icloud',
  targets: [target],
  grantedAt: '2026-11-17T00:00:00.000Z',
})

describe('XK-3 widening a kept mail credential’s folders or recipients reads as nothing new', () => {
  it('the review counts dropping the folder list and the recipient list as a widening', () => {
    // Today: false, so ReviewPage says "This update adds no permissions" and asks for no tick.
    expect(addsPermissions(permissionDiff(v1, v2))).toBe(true)
  })

  it('the card has a line for it', () => {
    // Today: [] (the Mac and phone card show no change at all).
    expect(permissionChanges(v1, v2, false)).not.toEqual([])
  })

  it('the kept credential grants do not carry over a widening of what they are used for', () => {
    // Today: both carry (credentialCarriesOver looks only at the credential declaration).
    expect({
      imap: credentialCarriesOver(grant('mail', IMAP), v1, v2),
      smtp: credentialCarriesOver(grant('send', SMTP), v1, v2),
    }).toEqual({ imap: false, smtp: false })
  })
})
