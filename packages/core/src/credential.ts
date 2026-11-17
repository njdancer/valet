// Credentials for adapters that run outside the browser (docs/adapter-kinds.md#f2-secrets-version-2).
//
// A manifest's `secrets` are typed into web pages by the declarative login. Its `credentials` are
// used by Valet itself on the adapter's behalf: added to an HTTPS request as a header, or used to
// sign in to a protocol server. Those are **kept**: the adapter never sees the value. Only a `raw`
// adapter may have a credential **entrusted** to it, and then only for the endpoints it names.
//
// This module is the contract workstream B owns: the declaration's shape, which uses each runtime
// kind may make, what a grant of one may cover, and the words a card uses to say so.

import { z } from 'zod'
import { isHostname } from './origins'

/** What a credential is. Each kind has the item fields it may read (CREDENTIAL_FIELDS). */
export const CREDENTIAL_KINDS = ['password', 'token', 'ssh-key'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/** Who holds the value while it is used. */
export const CUSTODIES = ['kept', 'entrusted'] as const
export type Custody = (typeof CUSTODIES)[number]

/** The protocol clients Valet ships (workstreams D, E and G). */
export const CREDENTIAL_PROTOCOLS = ['imap', 'smtp', 'sftp'] as const
export type CredentialProtocol = (typeof CREDENTIAL_PROTOCOLS)[number]

/**
 * The adapter kinds (A owns the manifest's `runtime` field; this list mirrors it). A manifest that
 * leaves `runtime` out is a browser adapter.
 */
export type RuntimeKind = 'browser' | 'http' | 'protocol' | 'raw'

/**
 * Fields of a credential item a provider can read. `username`, `password` and `otp` are what a
 * browser login's secrets use; `token` and `ssh-key` are new for credentials.
 */
export const ITEM_FIELDS = ['username', 'password', 'otp', 'token', 'ssh-key'] as const
export type ItemField = (typeof ITEM_FIELDS)[number]

/** The fields each credential kind may read. Never `otp`: a credential is used unattended. */
export const CREDENTIAL_FIELDS: Readonly<Record<CredentialKind, readonly ItemField[]>> = {
  password: ['username', 'password'],
  token: ['token'],
  'ssh-key': ['username', 'ssh-key'],
}

/** The field that is the credential itself, as opposed to the username beside it. */
export const SECRET_FIELD_OF: Readonly<Record<CredentialKind, ItemField>> = {
  password: 'password',
  token: 'token',
  'ssh-key': 'ssh-key',
}

/**
 * Headers a credential may never fill: they decide where a request goes, how it is framed or
 * which session it rides on, so filling one would be a way round the broker, not a login.
 */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'cookie',
  'cookie2',
  'set-cookie',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'origin',
  'referer',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])
const FORBIDDEN_HEADER_PREFIXES = ['proxy-', 'sec-', 'access-control-']

/** A header name: a lower-case token. */
const HEADER_NAME = /^[a-z][a-z0-9-]{0,63}$/
/** Printable ASCII, so the header can't carry a line break or anything a server would re-read. */
const HEADER_TEXT = /^[\x20-\x7e]*$/

/** The placeholders a header format may use, each at most once and only one per format. */
export const HEADER_PLACEHOLDERS = ['{value}', '{basic}'] as const

export function isCredentialHeaderName(value: string): boolean {
  return (
    HEADER_NAME.test(value) &&
    !FORBIDDEN_HEADERS.has(value) &&
    !FORBIDDEN_HEADER_PREFIXES.some((prefix) => value.startsWith(prefix))
  )
}

/**
 * One endpoint, `host:port`: a lower-case DNS name, an IPv4 literal or a bracketed IPv6 literal,
 * and a port from 1 to 65535 with no leading zero. Returns null for anything else.
 */
export function parseEndpoint(value: string): { readonly host: string; readonly port: number } | null {
  const match = /^(\[[0-9a-f:.]{2,45}\]|[^:[\]]+):([1-9][0-9]{0,4})$/.exec(value)
  if (match === null) return null
  const [, host, portText] = match as unknown as [string, string, string]
  const port = Number(portText)
  if (port > 65_535) return null
  if (host.startsWith('[')) return isIpv6(host.slice(1, -1)) ? { host, port } : null
  if (isIpv4(host)) return { host, port }
  return isHostname(host) && host === host.toLowerCase() ? { host, port } : null
}

export function isEndpoint(value: string): boolean {
  return parseEndpoint(value) !== null
}

/** A host a header may be sent to: a lower-case DNS name or an IPv4 literal (a private host). */
export function isCredentialHost(value: string): boolean {
  return (isHostname(value) && value === value.toLowerCase()) || isIpv4(value)
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return (
    parts.length === 4 && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
  )
}

function isIpv6(value: string): boolean {
  // Lower case and canonical enough to compare as text: URL parsing gives the canonical form.
  try {
    return new URL(`https://[${value}]/`).hostname === `[${value}]`
  } catch {
    return false
  }
}

const endpoint = z.string().max(260).refine(isEndpoint, 'must be host:port, e.g. imap.mail.me.com:993')
const credentialHost = z
  .string()
  .max(253)
  .refine(isCredentialHost, 'must be a bare lower-case hostname or an IPv4 address: no scheme, port or path')

export const credentialUseSchema = z.union([
  /** Valet signs in to a protocol server with it (kept). */
  z.object({ protocol: z.enum(CREDENTIAL_PROTOCOLS), endpoint }).strict(),
  /** Valet adds it to HTTPS requests to these hosts as one header (kept). */
  z
    .object({
      header: z
        .object({
          name: z.string().refine(isCredentialHeaderName, 'a lower-case header name a credential may fill'),
          format: z.string().min(1).max(200).regex(HEADER_TEXT, 'printable ASCII only'),
        })
        .strict(),
      hosts: z.array(credentialHost).min(1).max(10),
    })
    .strict(),
  /** The adapter is given it, and may reach only these endpoints (entrusted, `raw` only). */
  z.object({ entrusted: z.object({ endpoints: z.array(endpoint).min(1).max(20) }).strict() }).strict(),
])
export type CredentialUse = z.infer<typeof credentialUseSchema>

export const credentialDeclarationSchema = z
  .object({
    /** The author's words for it. Shown as theirs, beside Valet's own description, never as it. */
    description: z.string().min(1).max(200),
    kind: z.enum(CREDENTIAL_KINDS),
    custody: z.enum(CUSTODIES),
    use: credentialUseSchema,
  })
  .strict()
  .superRefine((credential, ctx) => {
    for (const message of declarationIssues(credential)) ctx.addIssue({ code: 'custom', message })
  })
export type CredentialDeclaration = z.infer<typeof credentialDeclarationSchema>

/** How a declaration uses its credential, by the key its `use` has. */
export type UseKind = 'protocol' | 'header' | 'entrusted'

export function useKind(use: CredentialUse): UseKind {
  if ('protocol' in use) return 'protocol'
  if ('header' in use) return 'header'
  return 'entrusted'
}

/** A declaration's own rules, whatever the adapter's runtime. */
function declarationIssues(credential: CredentialDeclaration): string[] {
  const issues: string[] = []
  const kind = useKind(credential.use)
  if ((credential.custody === 'entrusted') !== (kind === 'entrusted')) {
    issues.push('custody entrusted goes with use.entrusted, and only with it')
  }
  if ('header' in credential.use) {
    const { format } = credential.use.header
    const found = HEADER_PLACEHOLDERS.flatMap((p) =>
      format
        .split(p)
        .slice(1)
        .map(() => p),
    )
    if (found.length !== 1) issues.push('header format must contain exactly one of {value} or {basic}')
    else if (found[0] === '{basic}' && credential.kind !== 'password')
      issues.push('{basic} (username:password in base64) needs a password credential')
    if (format.replaceAll('{value}', '').replaceAll('{basic}', '').match(/[{}]/))
      issues.push('header format has an unknown placeholder')
    if (credential.kind === 'ssh-key') issues.push('an ssh-key is never sent as a header')
    if (new Set(credential.use.hosts).size !== credential.use.hosts.length)
      issues.push('header hosts must not repeat')
  }
  if ('protocol' in credential.use) {
    if (credential.kind === 'ssh-key' && credential.use.protocol !== 'sftp')
      issues.push('an ssh-key signs in to sftp only')
  }
  if ('entrusted' in credential.use) {
    const endpoints = credential.use.entrusted.endpoints
    if (new Set(endpoints).size !== endpoints.length) issues.push('entrusted endpoints must not repeat')
  }
  return issues
}

/** Which uses each runtime kind may declare. A browser adapter's logins are its `secrets`. */
export const USES_BY_RUNTIME: Readonly<Record<RuntimeKind, readonly UseKind[]>> = {
  browser: [],
  http: ['header'],
  protocol: ['protocol'],
  raw: ['entrusted'],
}

/**
 * Problems with a manifest's credentials for its runtime, as messages. Empty when there are none.
 * manifestSchema calls it; workstream A passes the manifest's runtime once that field exists.
 */
export function credentialIssues(
  credentials: Readonly<Record<string, CredentialDeclaration>> | undefined,
  runtime: RuntimeKind,
  secretNames: readonly string[] = [],
): string[] {
  if (credentials === undefined) return []
  const issues: string[] = []
  const allowed = USES_BY_RUNTIME[runtime]
  for (const [name, credential] of Object.entries(credentials)) {
    const kind = useKind(credential.use)
    if (!allowed.includes(kind)) {
      issues.push(
        allowed.length === 0
          ? `credential ${name}: a ${runtime} adapter has no credentials (a browser login uses secrets)`
          : `credential ${name}: a ${runtime} adapter may not declare a ${kind} credential`,
      )
    }
    // One name, one thing: audit records and grants name it without saying which map it is in.
    if (secretNames.includes(name)) issues.push(`credential ${name} has the same name as a secret`)
  }
  return issues
}

/**
 * Where a credential may go, as the strings a grant lists: an endpoint for protocol and entrusted
 * uses, a host for a header. A grant's targets are a subset of these.
 */
export function credentialTargets(credential: CredentialDeclaration): readonly string[] {
  const { use } = credential
  if ('protocol' in use) return [use.endpoint]
  if ('header' in use) return use.hosts
  return use.entrusted.endpoints
}

/** The header names a manifest's credentials fill: tool code may never set these itself. */
export function credentialHeaderNames(manifest: {
  readonly credentials?: Readonly<Record<string, CredentialDeclaration>> | undefined
}): Set<string> {
  const names = new Set<string>()
  for (const credential of Object.values(manifest.credentials ?? {}))
    if ('header' in credential.use) names.add(credential.use.header.name)
  return names
}

const KIND_WORDS: Readonly<Record<CredentialKind, string>> = {
  password: 'password',
  token: 'token',
  'ssh-key': 'SSH key',
}

const PROTOCOL_WORDS: Readonly<Record<CredentialProtocol, string>> = {
  imap: 'mail (IMAP)',
  smtp: 'outgoing mail (SMTP)',
  sftp: 'files (SFTP)',
}

/**
 * What a credential does, in Valet's own words, built only from the declaration's structured
 * fields: the name, kind, custody and targets. The author's description is never part of it; a
 * card shows that separately, as the adapter's claim. The one wording source for the Mac's
 * permission lines and both devices' grant cards. At most 200 characters, cut at a target.
 */
export function describeCredentialUse(name: string, credential: CredentialDeclaration): string {
  const what = `your ${KIND_WORDS[credential.kind]} "${name}"`
  const targets = credentialTargets(credential)
  const { use } = credential
  let sentence: string
  if ('protocol' in use) {
    sentence = `Valet signs in to ${use.endpoint} for ${PROTOCOL_WORDS[use.protocol]} with ${what}. The adapter never sees it.`
  } else if ('header' in use) {
    sentence = `Valet sends ${what} to ${listed(targets)} in the ${use.header.name} header. The adapter never sees it.`
  } else {
    sentence = `The adapter is given ${what} and can use it only with ${listed(targets)}.`
  }
  return sentence.length <= 200 ? sentence : shorten(sentence, targets)
}

function listed(targets: readonly string[]): string {
  if (targets.length === 1) return targets[0] as string
  return `${targets.slice(0, -1).join(', ')} and ${targets.at(-1)}`
}

/** The same sentence with fewer targets named, and a count of the rest. */
function shorten(sentence: string, targets: readonly string[]): string {
  const full = listed(targets)
  for (let shown = targets.length - 1; shown >= 1; shown--) {
    const short = `${targets.slice(0, shown).join(', ')} and ${targets.length - shown} more`
    const candidate = sentence.replace(full, short)
    if (candidate.length <= 200) return candidate
  }
  return `${sentence.slice(0, 199)}…`
}
