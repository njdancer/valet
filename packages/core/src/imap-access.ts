// ctx.imap: what a `protocol` adapter's tool code can do with mail (docs/imap.md). Valet's own
// client does it in the sandboxed protocol host, signed in with a kept credential the adapter never
// sees. Every operation is checked against the tool's declared side effect before anything is sent
// (imap-policy.ts), and folders against the manifest's list.

export interface ImapAddress {
  readonly name: string | null
  readonly address: string | null
}

export interface ImapEnvelope {
  readonly date: string | null
  readonly subject: string | null
  readonly from: readonly ImapAddress[]
  readonly sender: readonly ImapAddress[]
  readonly replyTo: readonly ImapAddress[]
  readonly to: readonly ImapAddress[]
  readonly cc: readonly ImapAddress[]
  readonly inReplyTo: string | null
  readonly messageId: string | null
}

export interface ImapFolder {
  readonly path: string
  readonly delimiter: string | null
  readonly flags: readonly string[]
  /** `\Sent`, `\Trash`, `\Archive` and the like (RFC 6154), when the server marks one. */
  readonly specialUse: string | null
}

export interface ImapStatus {
  readonly folder: string
  readonly messages: number | null
  readonly unseen: number | null
  readonly uidNext: number | null
  readonly uidValidity: number | null
}

export interface ImapSummary {
  readonly uid: number
  readonly flags: readonly string[]
  readonly internalDate: string | null
  readonly size: number
  readonly envelope: ImapEnvelope | null
}

export interface ImapMessage extends ImapSummary {
  /** The first plain-text part, decoded, at most maxTextChars. */
  readonly text: string | null
  /** The first HTML part, decoded, as text: never rendered. */
  readonly html: string | null
  /** Every other part, as metadata. Fetch one with attachment(). */
  readonly attachments: readonly {
    readonly part: string
    readonly type: string
    readonly filename: string | null
    readonly size: number
  }[]
  readonly truncated: boolean
}

/**
 * Structured search criteria. Each key is one IMAP search key; all of them must match. Dates are
 * `YYYY-MM-DD`. `or` takes two criteria and `not` one, nested at most three deep, twenty keys in all.
 */
export interface ImapCriteria {
  readonly from?: string
  readonly to?: string
  readonly cc?: string
  readonly subject?: string
  readonly body?: string
  readonly text?: string
  readonly since?: string
  readonly before?: string
  readonly on?: string
  readonly sentSince?: string
  readonly sentBefore?: string
  readonly seen?: boolean
  readonly flagged?: boolean
  readonly answered?: boolean
  readonly draft?: boolean
  readonly deleted?: boolean
  readonly larger?: number
  readonly smaller?: number
  readonly uids?: readonly number[]
  readonly header?: { readonly name: string; readonly value: string }
  readonly not?: ImapCriteria
  readonly or?: readonly [ImapCriteria, ImapCriteria]
}

/** Flags: the system flags (`\Seen`, `\Flagged`, `\Answered`, `\Draft`, `\Deleted`) or keywords. */
export interface ImapFlagChange {
  readonly add?: readonly string[]
  readonly remove?: readonly string[]
}

export interface ImapAccess {
  /** read. Only the folders the manifest names, when it names any. */
  listFolders(): Promise<readonly ImapFolder[]>
  /** read. */
  status(folder: string): Promise<ImapStatus>
  /** read. UIDs newest first, at most `limit` (default 50, at most 500). */
  search(
    folder: string,
    criteria?: ImapCriteria,
    options?: { readonly limit?: number },
  ): Promise<{
    readonly folder: string
    readonly uidValidity: number | null
    readonly total: number
    readonly uids: readonly number[]
  }>
  /** read. Envelopes and flags for at most 100 messages. Never marks them read. */
  fetch(folder: string, uids: readonly number[]): Promise<{ readonly folder: string; readonly messages: readonly ImapSummary[] }>
  /** read. One message's text. Never marks it read. */
  message(folder: string, uid: number, options?: { readonly maxTextChars?: number }): Promise<ImapMessage>
  /** read. One part's bytes as base64, at most maxBytes (default 1 MB, at most 1.5 MB). */
  attachment(
    folder: string,
    uid: number,
    part: string,
    options?: { readonly maxBytes?: number },
  ): Promise<{
    readonly part: string
    readonly type: string
    readonly filename: string | null
    readonly size: number
    readonly base64: string
    readonly truncated: boolean
  }>
  /** write, or irreversible when it names \Deleted. */
  setFlags(folder: string, uids: readonly number[], change: ImapFlagChange): Promise<{ readonly folder: string; readonly uids: number }>
  /** write. Both folders must be allowed. */
  copy(folder: string, uids: readonly number[], to: string): Promise<{ readonly folder: string; readonly to: string; readonly uids: number }>
  /** write. Both folders must be allowed. Needs the server's MOVE. */
  move(folder: string, uids: readonly number[], to: string): Promise<{ readonly folder: string; readonly to: string; readonly uids: number }>
  /** write. A whole RFC 5322 message, at most 1 MB. */
  append(
    folder: string,
    message: string,
    options?: { readonly flags?: readonly string[] },
  ): Promise<{ readonly folder: string; readonly bytes: number }>
  /** write. */
  createFolder(folder: string): Promise<{ readonly folder: string }>
  /** irreversible. Removes just these messages, if marked \Deleted (UID EXPUNGE; needs UIDPLUS). */
  expunge(folder: string, uids: readonly number[]): Promise<{ readonly folder: string; readonly removed: number }>
  /** irreversible. Never INBOX. */
  deleteFolder(folder: string): Promise<{ readonly folder: string }>
}
