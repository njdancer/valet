// ctx.smtp: sending mail from a `protocol` adapter with protocols.smtp (docs/adapter-kinds.md#protocol).
// Valet's own client sends it from the sandboxed protocol host, signed in with a kept credential the
// adapter never sees, From the account it signs in as. A send is irreversible: only an irreversible
// tool may send, and each send waits for the person to confirm the exact message, as Valet shows it.

/** What tool code passes to send. Checked by smtp-policy.ts checkMailMessage. */
export interface MailInput {
  /** At least one. Plain `local@domain` addresses only. */
  readonly to: readonly string[]
  readonly cc?: readonly string[]
  /** Shown to the person like the others, and kept out of the message's headers. */
  readonly bcc?: readonly string[]
  readonly subject: string
  readonly text: string
  /** A reply's parent Message-ID, `<id@host>`. */
  readonly inReplyTo?: string
  readonly references?: readonly string[]
}

export interface MailSent {
  /** The Message-ID Valet gave it, `<id@domain>`. */
  readonly messageId: string
  /** How many recipients the server accepted. A send any recipient was refused for fails instead. */
  readonly accepted: number
}

export interface SmtpAccess {
  /**
   * Sends one message, once the person confirms it. A decline rejects with `confirm/declined` and a
   * time-out with `confirm/timed-out`; nothing is sent either way.
   */
  send(message: MailInput): Promise<MailSent>
}
