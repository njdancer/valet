// A `protocol` adapter's `protocols` (docs/imap.md#the-manifest): the protocol clients Valet runs
// for it. Workstream D owns `imap`, G owns `smtp`; SFTP joins later. Each names its endpoint and the
// kept credential Valet signs in with, which must be declared for exactly that protocol and
// endpoint, so a grant of it covers one server and nothing else.

import { z } from 'zod'
import { type CredentialDeclaration, isEndpoint } from './credential'
import { folderAllowed } from './imap-policy'
import { isMailAddress } from './smtp-policy'

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

/** A recipients rule: an exact address, or `@domain` for every address at exactly that domain. */
const recipientRule = z
  .string()
  .max(200)
  .refine(
    (v) => (v.startsWith('@') ? isMailAddress(`x${v}`) : isMailAddress(v)),
    'an address, or @ and a domain, e.g. @example.com',
  )

export const smtpProtocolSchema = z
  .object({
    /**
     * The server, `host:port`. Port 465 is TLS from the first byte; any other port must offer
     * STARTTLS, and Valet never signs in or sends before TLS.
     */
    endpoint,
    /** The name of the kept credential, in `credentials`, that Valet signs in with. Its username is From. */
    credential: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    /**
     * Who tools may send to. Left out, anyone; the person still sees and confirms every send.
     * Approving a version that widens this list is approving the wider list.
     */
    recipients: z.array(recipientRule).min(1).max(100).optional(),
  })
  .strict()
export type SmtpProtocol = z.infer<typeof smtpProtocolSchema>

export const protocolsSchema = z
  .object({ imap: imapProtocolSchema.optional(), smtp: smtpProtocolSchema.optional() })
  .strict()
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
  const smtp = manifest.protocols?.smtp
  if (imap === undefined && smtp === undefined) {
    issues.push('a protocol adapter needs protocols.imap or protocols.smtp')
    return issues
  }
  if (imap !== undefined) {
    issues.push(...credentialIssues(manifest.credentials, 'imap', imap.credential, imap.endpoint))
    const folders = imap.folders ?? []
    if (new Set(folders.map((f) => (f.toUpperCase() === 'INBOX' ? 'INBOX' : f))).size !== folders.length)
      issues.push('protocols.imap.folders lists a folder twice')
  }
  if (smtp !== undefined) {
    issues.push(...credentialIssues(manifest.credentials, 'smtp', smtp.credential, smtp.endpoint))
    const rules = (smtp.recipients ?? []).map((r) => r.toLowerCase())
    if (new Set(rules).size !== rules.length) issues.push('protocols.smtp.recipients lists one twice')
  }
  for (const [name, c] of Object.entries(manifest.credentials ?? {})) {
    if (!('protocol' in c.use)) continue
    const used =
      (c.use.protocol === 'imap' && name === imap?.credential) ||
      (c.use.protocol === 'smtp' && name === smtp?.credential)
    if ((c.use.protocol === 'imap' || c.use.protocol === 'smtp') && !used)
      issues.push(
        `credential ${name}: an ${c.use.protocol} credential that protocols.${c.use.protocol} doesn't use`,
      )
  }
  return issues
}

/** Why a protocol's credential isn't the kept password for exactly that protocol and endpoint. */
function credentialIssues(
  credentials: Readonly<Record<string, CredentialDeclaration>> | undefined,
  protocol: 'imap' | 'smtp',
  name: string,
  endpoint: string,
): string[] {
  const credential =
    credentials !== undefined && Object.hasOwn(credentials, name) ? credentials[name] : undefined
  if (credential === undefined)
    return [`protocols.${protocol}: credential ${name} is not declared in credentials`]
  if (
    !('protocol' in credential.use) ||
    credential.use.protocol !== protocol ||
    credential.use.endpoint !== endpoint ||
    credential.custody !== 'kept' ||
    credential.kind !== 'password'
  )
    return [
      `protocols.${protocol}: credential ${name} must be a kept password for ${protocol} at ${endpoint}`,
    ]
  return []
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
