// The checks every Messages one-time-code lookup makes before anything reads Messages. The reading
// itself is in @valet/native-messages (otp.ts), on the same reader as the Messages tools; these
// checks stay here, with the grants they test. The sender and pattern come from adapter code, so a
// lookup only ever asks about exactly the named sender, with a pattern that passed the screen.
//
// The sender the person approved is a messages grant's itemRef; the sender in a query comes from
// the manifest. Given the grant, a lookup refuses a query for any other sender, and
// messagesQueryFor() builds the query from the grant itself. With requireGrant, a lookup without a
// grant is refused too. (Core's OtpReader.latest takes no grant yet, so callers through that
// interface can't pass one; see the README.)

import {
  type Grant,
  isScreenedPattern,
  MESSAGES_SECRET,
  type MessagesOtpQuery,
  ValetError,
} from '@valet/core'
import { type OtpSender, parseOtpSender, sameOtpSender } from './otp-sender'

/** A manifest's Messages OTP source: what messagesSourcesIn() lists. */
export interface MessagesOtpSource {
  readonly sender: string
  readonly pattern: string
  readonly maxAgeSeconds: number
}

/**
 * The query for `source`, read from the sender `grant` names. Throws `otp: not-granted` unless
 * `grant` is a messages grant for that same sender, so a manifest whose sender changed can't read
 * codes from a sender the person never approved.
 */
export function messagesQueryFor(grant: Grant, source: MessagesOtpSource): MessagesOtpQuery {
  checkGrant(grant, source.sender)
  return { sender: grant.itemRef, pattern: source.pattern, maxAgeSeconds: source.maxAgeSeconds }
}

/** A messages grant whose sender is `sender`, or `otp: not-granted`. */
function checkGrant(grant: Grant | null | undefined, sender: unknown): void {
  if (
    grant === undefined ||
    grant === null ||
    grant.provider !== 'messages' ||
    grant.secret !== MESSAGES_SECRET ||
    typeof grant.itemRef !== 'string' ||
    typeof sender !== 'string' ||
    !sameOtpSender(grant.itemRef, sender)
  ) {
    throw new ValetError('otp', 'not-granted')
  }
}

/**
 * The grant (when given, or required), a sender that names exactly one handle, and a screened
 * pattern. Returns the parsed sender and the earliest time a code may have arrived.
 */
export function prepareOtpLookup(
  query: MessagesOtpQuery,
  notBefore: Date,
  now: Date,
  grant: Grant | undefined,
  requireGrant: boolean,
): { sender: OtpSender; sinceMs: number } {
  if (grant !== undefined || requireGrant) checkGrant(grant, query.sender)
  // Without a sender, any message from anyone (another bank's code, a private message) could be
  // typed into the page. The type and the manifest schema both require one; this check stands in
  // case a query is built some other way (from JSON, say) and the types were never checked.
  const sender = typeof query.sender === 'string' ? parseOtpSender(query.sender) : null
  if (sender === null || typeof query.pattern !== 'string' || !isScreenedPattern(query.pattern)) {
    throw new ValetError('otp', 'invalid')
  }
  const sinceMs = Math.max(notBefore.getTime(), now.getTime() - query.maxAgeSeconds * 1000)
  return { sender, sinceMs }
}
