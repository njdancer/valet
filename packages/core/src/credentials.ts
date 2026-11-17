// Credential providers and grants. A manifest requests a secret; a grant, made by the person, binds
// that request to a credential item for one exact adapter content hash.

import type { CredentialKind, Custody, ItemField } from './credential'
import type { SecretValue } from './secret'

/**
 * `messages` grants let an adapter's auth flow read one-time codes from Messages: itemRef is the
 * sender handle the person approved, and origins are where the code may be typed.
 */
export type ProviderKind =
  | 'keychain-copy'
  | 'onepassword-desktop'
  | 'onepassword-service-account'
  | 'onepassword-cli'
  | 'messages'
  /** An SSH key Valet generated for one credential; its private half never leaves the Keychain. */
  | 'valet-key'
  /**
   * Sign-in mail (docs/imap.md#email-sign-in): itemRef names the mail account and the sender the
   * person approved (mailGrantRef), origins are where a code may be typed or a link may open.
   */
  | 'mail'
  | 'fake'

/** The secret name a manifest's Messages OTP source is granted under. Reserved in manifests. */
export const MESSAGES_SECRET = 'messages'

/** The secret name a manifest's sign-in mail is granted under. Reserved in manifests. */
export const MAIL_SECRET = 'mail'

/**
 * A mail account Valet holds: a protocol adapter's kept IMAP credential, as
 * `<adapterId>/<credential>`. Sign-in lookups run as that adapter's credential, read-only.
 */
export type MailAccountRef = string

const MAIL_ACCOUNT = /^[a-z][a-z0-9-]{1,63}\/[a-z][a-z0-9_]{0,63}$/
const MAIL_ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/

/** The itemRef of a mail grant: the account, a space, and the approved sender's address. */
export function mailGrantRef(account: MailAccountRef, sender: string): string {
  if (!MAIL_ACCOUNT.test(account) || !MAIL_ADDRESS.test(sender))
    throw new Error('not a mail account or sender')
  return `${account} ${sender}`
}

/** A mail grant's account and sender, or null if its itemRef isn't one. */
export function parseMailGrantRef(
  itemRef: string,
): { readonly account: MailAccountRef; readonly sender: string } | null {
  const [account, sender, ...rest] = itemRef.split(' ')
  if (account === undefined || sender === undefined || rest.length > 0) return null
  return MAIL_ACCOUNT.test(account) && MAIL_ADDRESS.test(sender) ? { account, sender } : null
}

/** One sign-in mail lookup. Valet runs it, read-only, in the protocol host. */
export interface MailSignInQuery {
  readonly account: MailAccountRef
  readonly from: string
  readonly subjectContains?: string | undefined
  readonly maxAgeSeconds: number
  readonly extract: { readonly pattern: string } | { readonly linkOrigin: string }
}

/**
 * Reads sign-in codes and links from mail. Throws CredentialError('not-found') until one arrives,
 * after `notBefore`. The value is the code or the link; the caller disposes it.
 */
export interface MailReader {
  find(query: MailSignInQuery, notBefore: Date): Promise<SecretValue>
}

export interface Grant {
  readonly adapterId: string
  readonly adapterHash: string
  readonly secret: string
  readonly provider: ProviderKind
  /** Provider-specific item reference, e.g. op://valet/Woolworths. Never shown to adapter code. */
  readonly itemRef: string
  /** Origins the person allowed this secret on: a subset of what the manifest asked for. */
  readonly origins: readonly string[]
  readonly grantedAt: string
}

export type ResolveFailure =
  | 'locked' // provider needs the person, e.g. Touch ID or an unlocked app
  | 'not-found'
  | 'field-missing'
  | 'unavailable' // provider not installed or not configured

export class CredentialError extends Error {
  constructor(readonly failure: ResolveFailure) {
    super(`credential ${failure}`)
    this.name = 'CredentialError'
  }
}

export interface CredentialProvider {
  readonly kind: ProviderKind
  /** Fetches one field just in time. Throws CredentialError. The caller disposes the value. */
  resolve(itemRef: string, field: ItemField): Promise<SecretValue>
}

export interface GrantStore {
  find(adapterId: string, adapterHash: string, secret: string): Promise<Grant | null>
  list(): Promise<readonly Grant[]>
  put(grant: Grant): Promise<void>
  revoke(adapterId: string, secret: string): Promise<void>
}

/**
 * A credential grant (B's contract): binds a manifest's credential to an item for one exact
 * adapter hash, as a secret grant does, and to targets (endpoints or hosts) the person allowed: a
 * non-empty subset of the declaration's. Its kind and custody are the declaration's when granted;
 * a version that changes either needs a new grant.
 */
export interface CredentialGrant {
  readonly adapterId: string
  readonly adapterHash: string
  readonly credential: string
  readonly kind: CredentialKind
  readonly custody: Custody
  readonly provider: ProviderKind
  /** Provider-specific item reference. Never shown to adapter code. */
  readonly itemRef: string
  readonly targets: readonly string[]
  readonly grantedAt: string
}

export interface CredentialGrantStore {
  find(adapterId: string, adapterHash: string, credential: string): Promise<CredentialGrant | null>
  list(): Promise<readonly CredentialGrant[]>
  put(grant: CredentialGrant): Promise<void>
  revoke(adapterId: string, credential: string): Promise<void>
}

/** Where the 1Password service-account token comes from (the Keychain, in the app). */
export interface TokenSource {
  token(): Promise<SecretValue>
}

export interface MessagesOtpQuery {
  readonly sender: string
  /** A regular expression whose first capture group (or whole match) is the code. */
  readonly pattern: string
  readonly maxAgeSeconds: number
}

/** Reads one-time codes that arrived by SMS. Throws CredentialError('not-found') when none match. */
export interface OtpReader {
  latest(query: MessagesOtpQuery, notBefore: Date): Promise<SecretValue>
}
