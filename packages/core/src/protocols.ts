// A `protocol` adapter's `protocols` (docs/imap.md#the-manifest, docs/sftp.md#the-manifest): the
// protocol clients Valet runs for it. Workstream D owns `imap`, E owns `sftp`, G owns `smtp`. An
// adapter uses mail (imap, smtp or both) or files (sftp). Each names its endpoint and the
// kept credential Valet signs in with, which must be declared for exactly that protocol and
// endpoint, so a grant of it covers one server and nothing else.

import { z } from 'zod'
import { canonicalAddress, isPrivateHostAddress, parseEndpoint } from './addresses'
import { type CredentialDeclaration, isEndpoint } from './credential'
import { folderAllowed } from './imap-policy'
import { isSftpPath, SFTP_PURPOSE_RANK } from './sftp-policy'
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

/** An SSH host key's fingerprint as `ssh-keygen -lf` prints it: SHA256: and 43 base64 characters. */
export function isHostKeyFingerprint(value: unknown): value is string {
  // 32 bytes are 43 characters with two spare bits at the end, which must be zero: the last
  // character is one of these 16, so each digest has exactly one spelling.
  return typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/.test(value)
}

const sftpEndpoint = z
  .string()
  .max(106)
  .refine((v) => {
    if (!isEndpoint(v) || v.startsWith('[')) return false
    const host = parseEndpoint(v)?.host ?? ''
    // A name, or an address on the person's own network (a NAS): never a public address.
    return canonicalAddress(host) === null || isPrivateHostAddress(host)
  }, 'must be host:port with a host name, or a private address such as 192.168.1.20:22')

export const sftpRootSchema = z
  .object({
    /** An absolute folder on the server, exactly as the server names it: no "..", no trailing "/". */
    path: z
      .string()
      .max(140)
      .refine(isSftpPath, 'an absolute path such as /volume1/photos, with no "." or ".." parts'),
    /** The most a tool may do under it: read, write (undoable changes) or irreversible. */
    access: z.enum(['read', 'write', 'irreversible']),
  })
  .strict()
export type SftpRootDeclaration = z.infer<typeof sftpRootSchema>

export const sftpProtocolSchema = z
  .object({
    /** The server, `host:port`: a host name, or a private address on the person's network. */
    endpoint: sftpEndpoint,
    /** The name of the kept `ssh-key` credential, in `credentials`, that Valet signs in with. */
    credential: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    /**
     * The server's host key, pinned: Valet refuses any other, before signing in. As `ssh-keygen -lf`
     * prints it. Never trusted on first use.
     */
    hostKeySha256: z.string().refine(isHostKeyFingerprint, 'SHA256: and the 43-character base64 digest'),
    /**
     * The account to sign in as, when the credential's item has no username (a key Valet made has
     * none). The item's own username wins when it has one.
     */
    username: z
      .string()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,31}$/, 'at most 32 letters, digits and . _ @ -')
      .optional(),
    /** The folders tools may use, each with the most a tool may do there. The deepest one decides. */
    roots: z.array(sftpRootSchema).min(1).max(20),
  })
  .strict()
export type SftpProtocol = z.infer<typeof sftpProtocolSchema>

export const protocolsSchema = z
  .object({
    imap: imapProtocolSchema.optional(),
    smtp: smtpProtocolSchema.optional(),
    sftp: sftpProtocolSchema.optional(),
  })
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
  const sftp = manifest.protocols?.sftp
  if (imap === undefined && smtp === undefined && sftp === undefined) {
    issues.push('a protocol adapter needs protocols.imap, protocols.smtp or protocols.sftp')
    return issues
  }
  if (sftp !== undefined && (imap !== undefined || smtp !== undefined)) {
    issues.push('a protocol adapter uses mail (imap, smtp) or files (sftp), not both')
    return issues
  }
  if (sftp !== undefined) issues.push(...sftpIssues(sftp, manifest.credentials))
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
      (c.use.protocol === 'smtp' && name === smtp?.credential) ||
      (c.use.protocol === 'sftp' && name === sftp?.credential)
    if ((c.use.protocol === 'imap' || c.use.protocol === 'smtp' || c.use.protocol === 'sftp') && !used)
      issues.push(
        `credential ${name}: an ${c.use.protocol} credential that protocols.${c.use.protocol} doesn't use`,
      )
  }
  return issues
}

/**
 * Why sftp's credential isn't a kept ssh-key for exactly its endpoint, and its roots' own issues.
 */
function sftpIssues(
  sftp: SftpProtocol,
  credentials: Readonly<Record<string, CredentialDeclaration>> | undefined,
): string[] {
  const issues: string[] = []
  const credential =
    credentials !== undefined && Object.hasOwn(credentials, sftp.credential)
      ? credentials[sftp.credential]
      : undefined
  if (credential === undefined) {
    issues.push(`protocols.sftp: credential ${sftp.credential} is not declared in credentials`)
  } else if (
    !('protocol' in credential.use) ||
    credential.use.protocol !== 'sftp' ||
    credential.use.endpoint !== sftp.endpoint ||
    credential.custody !== 'kept' ||
    credential.kind !== 'ssh-key'
  ) {
    issues.push(
      `protocols.sftp: credential ${sftp.credential} must be a kept ssh-key for sftp at ${sftp.endpoint}`,
    )
  }
  if (new Set(sftp.roots.map((r) => r.path)).size !== sftp.roots.length)
    issues.push('protocols.sftp.roots lists a path twice')
  return issues
}

/** The most any root allows, for the card's risk. */
export function sftpWidestAccess(sftp: SftpProtocol): 'read' | 'write' | 'irreversible' {
  return sftp.roots.reduce<'read' | 'write' | 'irreversible'>(
    (widest, r) => (SFTP_PURPOSE_RANK[r.access] > SFTP_PURPOSE_RANK[widest] ? r.access : widest),
    'read',
  )
}

/** The host a protocol adapter reaches, as its pacing key's host: an IPv6 address in brackets. */
export function protocolHost(protocols: Protocols): string | null {
  const endpoint = protocols.imap?.endpoint ?? protocols.smtp?.endpoint ?? protocols.sftp?.endpoint
  const parsed = endpoint === undefined ? null : parseEndpoint(endpoint)
  if (parsed === null) return null
  return parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host
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
