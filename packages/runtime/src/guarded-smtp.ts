// ctx.smtp for one call (workstream G): the checks every send passes before the protocol host is
// started. The host checks the message and recipients again and builds it itself, From the account
// it signed in as, so each rule holds at two layers, and the SMTP client holds every line it writes
// to the checked values.
//
// In order, for each send:
// 1. the call is still live (not aborted, blocked, or past a guard violation);
// 2. the tool is irreversible: a send can't be undone, so no read or write tool may send;
// 3. the message passes smtp-policy.ts (plain addresses, no hidden characters, no extra headers);
// 4. every recipient, Bcc included, is on the manifest's recipients list, if it has one;
// 5. it counts against the run's request ceiling;
// 6. the person confirms this exact message, as Valet shows it (a `mail-send` confirmation);
// 7. it waits for the site's pace, then starts a fresh host, signed in just in time with the kept
//    credential, sends once, and ends the host.
// Sends from one call go one at a time, so the person is never asked about two messages at once.
// A refusal at 2, 4 or 5 is sticky, recorded as `request-blocked`, and sends nothing. A malformed
// message (3) fails the send only. A decline or time-out fails the send, and nothing was sent.

import {
  type AuditEvent,
  checkMailMessage,
  type ErrorClass,
  envelopeRecipients,
  type MailInput,
  type MailMessage,
  type MailSent,
  recipientAllowed,
  type SecretValue,
  type SmtpAccess,
  type Stage,
  ValetError,
} from '@valet/core'
import type { RunContext } from '@valet/egress'
import { CallGate, type CallGateOptions } from './call-gate'
import type { ConfirmationAnswer } from './types'

/** One send's host. */
export interface SmtpConnection {
  send(value: {
    readonly message: MailMessage
    readonly messageId: string
    readonly date: number
  }): Promise<{ readonly accepted: number }>
  /** Signs out and ends the host. Never throws. */
  end(): Promise<void>
}

export interface SmtpCall {
  readonly run: RunContext
  readonly admit: () => Promise<void>
  /** The kept credential, asked for only once the host is up. The caller disposes the values. */
  readonly signIn: () => Promise<{ readonly username: SecretValue | null; readonly secret: SecretValue }>
  readonly signal: AbortSignal
}

/** What runs the protocol host for an adapter's SMTP (packages/protocols' smtpBackend). */
export interface SmtpBackend {
  /** `host:port`. */
  readonly endpoint: string
  /** The manifest's recipients list, or null for anyone. */
  readonly recipients: readonly string[] | null
  connect(call: SmtpCall): Promise<SmtpConnection>
}

export interface GuardedSmtpOptions extends CallGateOptions {
  readonly backend: SmtpBackend
  readonly run: RunContext
  readonly signIn: SmtpCall['signIn']
  /** Asks the person about this exact message (tool-host's `mail-send` confirmation). */
  readonly confirm: (message: MailMessage) => Promise<ConfirmationAnswer>
  /** A fresh `<id@domain>` for the message. */
  readonly messageId: () => string
  readonly now: () => number
}

export class GuardedSmtp implements SmtpAccess {
  private readonly gate: CallGate
  /** The send before this one, settled or not: sends go one at a time, so one question is up. */
  private previous: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: GuardedSmtpOptions) {
    this.gate = new CallGate(options)
  }

  send = (input: MailInput): Promise<MailSent> => {
    const next = this.previous.then(() => this.sendOne(input))
    this.previous = next.catch(() => undefined)
    return next
  }

  private sendOne = async (input: MailInput): Promise<MailSent> => {
    const { state, backend, sideEffect } = this.options
    state.assertLive()
    if (sideEffect !== 'irreversible') return this.deny('request-surface', 'command-not-allowed')
    const message = checkMailMessage(input)
    if (message === null) throw new ValetError('tool-run', 'invalid')
    if (!envelopeRecipients(message).every((r) => recipientAllowed(r, backend.recipients)))
      return this.deny('request-surface', 'command-not-allowed')
    state.requests++
    if (state.requests > this.options.manifest.limits.requestsPerRun)
      return this.deny('request-surface', 'request-ceiling')

    const answer = await state.track(this.options.confirm(message))
    if (answer === 'cancelled') throw new ValetError('tool-run', 'aborted')
    if (answer !== 'approved')
      throw new ValetError('confirm', answer === 'timed-out' ? 'timed-out' : 'declined')
    state.assertLive()

    await this.gate.pace()
    const connection = await state.track(
      backend.connect({
        run: this.options.run,
        admit: async () => {
          await this.gate.pace()
        },
        signIn: this.options.signIn,
        signal: state.signal,
      }),
    )
    const messageId = this.options.messageId()
    try {
      state.assertLive()
      const { accepted } = await state.track(
        connection.send({ message, messageId, date: this.options.now() }),
      )
      return { messageId, accepted }
    } catch (error) {
      if (error instanceof ValetError && error.errorClass === 'command-not-allowed') state.violation ??= error
      throw error instanceof ValetError ? error : new ValetError('egress', 'unavailable')
    } finally {
      await connection.end()
    }
  }

  private async deny(stage: Stage, errorClass: ErrorClass): Promise<never> {
    const { state, adapterId, audit } = this.options
    const error = new ValetError(stage, errorClass)
    state.violation ??= error
    const event: AuditEvent = {
      type: 'request-blocked',
      adapterId,
      method: 'SMTP',
      target: `smtp://${this.options.backend.endpoint}/send`,
      reason: errorClass,
      initiator: 'tool',
      partition: 'tool',
      callId: state.callId,
    }
    await audit(event)
    throw error
  }
}

/** ctx.smtp for an adapter that has no SMTP: every send is not-granted. */
export const NO_SMTP_ACCESS: SmtpAccess = Object.freeze({
  send: () => Promise.reject(new ValetError('tool-run', 'not-granted')),
})
