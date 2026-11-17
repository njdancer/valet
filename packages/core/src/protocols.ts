// A `protocol` adapter's `protocols` (docs/imap.md#the-manifest): the protocol clients Valet runs
// for it. Workstream D owns `imap`; SFTP and SMTP join it later. Each names its endpoint and the
// kept credential Valet signs in with, which must be declared for exactly that protocol and
// endpoint, so a grant of it covers one server and nothing else.

import { z } from 'zod'
import { type CredentialDeclaration, isEndpoint } from './credential'
import { folderAllowed } from './imap-policy'

/** A folder name as the manifest writes it: no control characters, and no LIST wildcards. */
export const imapFolderSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (v) => ![...v].some((c) => c.charCodeAt(0) < 0x20 || c === '\u007f' || c === '*' || c === '%'),
    'a folder name has no control characters, "*" or "%"',
  )

const endpoint = z
  .string()
  .max(106)
  .refine(
    (v) => isEndpoint(v) && !v.startsWith('['),
    'must be host:port with a host name, e.g. imap.mail.me.com:993',
  )

export const imapProtocolSchema = z
  .object({
    /** The server, `host:port`: TLS from the first byte (port 993). */
    endpoint,
    /** The name of the kept credential, in `credentials`, that Valet signs in with. */
    credential: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    /**
     * The folders tools may use, by exact name. Left out, every folder. INBOX matches in any case.
     * Valet keeps tools to them; the server is never asked about any other.
     */
    folders: z.array(imapFolderSchema).min(1).max(50).optional(),
  })
  .strict()
export type ImapProtocol = z.infer<typeof imapProtocolSchema>

export const protocolsSchema = z.object({ imap: imapProtocolSchema.optional() }).strict()
export type Protocols = z.infer<typeof protocolsSchema>

/** Why a `protocol` manifest's fields don't fit its kind, as messages. */
export function protocolIssues(manifest: {
  readonly cartUrl?: string | undefined
  readonly navigation: readonly string[]
  readonly egress: readonly string[]
  readonly privateHosts?: readonly unknown[] | undefined
  readonly requests: readonly unknown[]
  readonly protocols?: Protocols | undefined
  readonly credentials?: Readonly<Record<string, CredentialDeclaration>> | undefined
}): string[] {
  const issues: string[] = []
  if (manifest.navigation.length > 0) issues.push('a protocol adapter has no navigation origins')
  if (manifest.cartUrl !== undefined) issues.push('a protocol adapter has no cartUrl')
  if (manifest.egress.length > 0)
    issues.push('a protocol adapter reaches only its protocols: no egress hosts')
  if (manifest.privateHosts !== undefined) issues.push('a protocol adapter has no privateHosts yet')
  if (manifest.requests.length > 0) issues.push('a protocol adapter declares no HTTP requests')
  const imap = manifest.protocols?.imap
  if (imap === undefined) {
    issues.push('a protocol adapter needs protocols.imap')
    return issues
  }
  const credential =
    manifest.credentials !== undefined && Object.hasOwn(manifest.credentials, imap.credential)
      ? manifest.credentials[imap.credential]
      : undefined
  if (credential === undefined) {
    issues.push(`protocols.imap: credential ${imap.credential} is not declared in credentials`)
  } else if (
    !('protocol' in credential.use) ||
    credential.use.protocol !== 'imap' ||
    credential.use.endpoint !== imap.endpoint ||
    credential.custody !== 'kept' ||
    credential.kind !== 'password'
  ) {
    issues.push(
      `protocols.imap: credential ${imap.credential} must be a kept password for imap at ${imap.endpoint}`,
    )
  }
  const folders = imap.folders ?? []
  if (new Set(folders.map((f) => (f.toUpperCase() === 'INBOX' ? 'INBOX' : f))).size !== folders.length)
    issues.push('protocols.imap.folders lists a folder twice')
  for (const [name, c] of Object.entries(manifest.credentials ?? {})) {
    if (name !== imap.credential && 'protocol' in c.use && c.use.protocol === 'imap')
      issues.push(`credential ${name}: an imap credential that protocols.imap doesn't use`)
  }
  return issues
}

/**
 * Whether any of a protocol adapter's tools may change INBOX (append, copy or move into it, set
 * flags). Such an account can't serve email sign-in (docs/imap.md#email-sign-in): a message an
 * IMAP client appends skips the receiving server, so its own forged Authentication-Results would
 * be the topmost one, and the sign-in lookup could take a planted link.
 */
export function mayWriteInbox(manifest: {
  readonly tools: readonly { readonly sideEffect: string }[]
  readonly protocols?: Protocols | undefined
}): boolean {
  const imap = manifest.protocols?.imap
  if (imap === undefined) return false
  return manifest.tools.some((t) => t.sideEffect !== 'read') && folderAllowed('INBOX', imap.folders ?? null)
}
