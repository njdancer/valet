// What the grant sheet is granting, resolved from the manifest. The sheet only ever offers origins
// the manifest asked for, for the adapter's installed hash; it can narrow them, never widen.

// From core's browser-safe vocabulary: core's index pulls in Node modules the renderer can't load.
import { MESSAGES_SECRET } from '@valet/core/vocab'
import type { AdapterDetail, GrantInfo } from '../../../../shared/api'
import { FIELD_WORDING } from '../../../lib/wording'

export { MESSAGES_SECRET }

/** Null when the manifest asks for no such secret. */
export interface Target {
  readonly title: string
  readonly fields: string
  readonly requestedOrigins: readonly string[]
  readonly existing: GrantInfo | null
  readonly kind: 'onepassword' | 'messages'
  readonly senders: readonly string[]
  /** The origins ticked when there is no earlier grant: where the secret is actually typed. */
  readonly suggestedOrigins: readonly string[]
}

export function targetFor(adapter: AdapterDetail, secret: string): Target | null {
  if (secret === MESSAGES_SECRET) {
    if (adapter.messages.length === 0) return null
    const origins = [...new Set(adapter.messages.flatMap((m) => m.requestedOrigins))]
    // A code may be typed on any navigation origin, but it is typed where the sign-in form is: the
    // origins the manifest's login secrets are filled on. Ticking only the first navigation origin
    // (the shop's www, for Woolworths, where Auth0 never asks for a code) made a grant that failed
    // every login with origin-mismatch.
    const signIn = new Set(adapter.secretRequests.flatMap((r) => r.origins))
    const where = origins.filter((o) => signIn.has(o))
    return {
      title: `Let ${adapter.name} read one-time codes from Messages`,
      fields: 'one-time code',
      requestedOrigins: origins,
      existing: adapter.messages.find((m) => m.grant !== null)?.grant ?? null,
      kind: 'messages',
      senders: adapter.messages.map((m) => m.sender),
      suggestedOrigins: where.length > 0 ? where : origins,
    }
  }
  // find() on an array, so names like "__proto__" or "constructor" can't resolve to anything.
  const request = adapter.secretRequests.find((s) => s.name === secret)
  if (request === undefined) return null
  return {
    title: `Give Valet your ${adapter.name} login`,
    fields: request.fields.map((f) => FIELD_WORDING[f]).join(' and '),
    requestedOrigins: request.origins,
    existing: request.grant,
    kind: 'onepassword',
    senders: [],
    suggestedOrigins: request.origins.slice(0, 1),
  }
}
