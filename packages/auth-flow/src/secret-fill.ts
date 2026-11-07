// The privileged filler: the only code in Valet that hands a secret to a page. It checks the
// grant, the manifest and the target element before fetching the value, fetches it just in time,
// checks the target again (the person may have taken a while over Touch ID), and disposes the value
// whatever happens.

import {
  CredentialError,
  type ElementInfo,
  type ErrorClass,
  type Grant,
  httpsOrigin,
  MESSAGES_SECRET,
  type MessagesOtpQuery,
  originAllowed,
  type ResolveFailure,
  type SecretField,
  type SecretRef,
  SecretValue,
  type Stage,
  urlOriginAllowed,
  ValetError,
} from '@valet/core'
import {
  checkAborted,
  checkBlocked,
  checkNavigation,
  type FlowContext,
  guarded,
  now,
  pause,
  remainingMs,
} from './context'
import { allowedOrigins, suitsField } from './guards'

/** How often to look for a one-time code that hasn't arrived yet. */
export const OTP_POLL_MS = 1000

const RESOLVE_FAILURES: readonly ResolveFailure[] = ['locked', 'not-found', 'field-missing', 'unavailable']

/** Fills a secret from a credential provider: `fill` with a secret ref, or `otp` with a secret source. */
export async function fillSecret(ctx: FlowContext, selector: string, ref: SecretRef): Promise<void> {
  const { manifest, providers } = ctx.input
  // The schema reserves the name; a manifest that uses it anyway would read a Messages grant as its own.
  if (ref.secret === MESSAGES_SECRET) throw new ValetError('secret-fill', 'invalid')
  const grant = await findGrant(ctx, ref.secret)
  // A Messages grant names a sender, not a credential item, and is never resolved through a provider.
  if (grant.provider === 'messages') throw new ValetError('secret-fill', 'not-granted')
  // hasOwn, because a secret named "constructor" would otherwise find Object's.
  const request = Object.hasOwn(manifest.secrets, ref.secret) ? manifest.secrets[ref.secret] : undefined
  if (request === undefined || !request.fields.includes(ref.field)) {
    throw new ValetError('secret-fill', 'invalid')
  }
  const origins = allowedOrigins(grant.origins, request.origins)
  await checkTarget(ctx, selector, ref.field, origins)

  const provider = providers[grant.provider]
  if (provider === undefined) throw new ValetError('credential', 'unavailable')
  const secret = await resolveSecret(() => provider.resolve(grant.itemRef, ref.field), 'credential')
  try {
    await checkTarget(ctx, selector, ref.field, origins)
    const element = await focusTarget(ctx, selector, ref.field, origins)
    await typeSecret(ctx, secret, ref.secret, ref.field, element, origins)
  } finally {
    secret.dispose()
  }
}

/**
 * Fills a one-time code read from Messages. Reading someone's texts needs their say-so as much as
 * a 1Password item does: a grant with provider `messages` under the reserved secret name, for this
 * exact adapter and hash, whose itemRef is the sender the manifest names. So a grant for one sender
 * can't read another's codes, and a changed manifest asks again. The code may go only to origins
 * in that grant that are also on the navigation allowlist.
 */
export async function fillMessagesOtp(
  ctx: FlowContext,
  selector: string,
  source: { readonly sender: string; readonly pattern: string; readonly maxAgeSeconds: number },
): Promise<void> {
  const { manifest } = ctx.input
  // A manifest's own secret called "messages" would have a 1Password grant that reads as this one.
  if (
    typeof source.sender !== 'string' ||
    source.sender.length === 0 ||
    Object.hasOwn(manifest.secrets, MESSAGES_SECRET)
  ) {
    throw new ValetError('secret-fill', 'invalid')
  }
  const grant = await findGrant(ctx, MESSAGES_SECRET)
  if (grant.provider !== 'messages' || grant.itemRef !== source.sender) {
    throw new ValetError('secret-fill', 'not-granted')
  }
  const origins = allowedOrigins(grant.origins, manifest.navigation)
  await checkTarget(ctx, selector, 'otp', origins)
  const query: MessagesOtpQuery = {
    sender: source.sender,
    pattern: source.pattern,
    maxAgeSeconds: source.maxAgeSeconds,
  }
  const code = await readOtp(ctx, query)
  try {
    await checkTarget(ctx, selector, 'otp', origins)
    const element = await focusTarget(ctx, selector, 'otp', origins)
    await typeSecret(ctx, code, MESSAGES_SECRET, 'otp', element, origins)
  } finally {
    code.dispose()
  }
}

/** The person's grant of `secret` to this exact adapter and hash, or `secret-fill: not-granted`. */
async function findGrant(ctx: FlowContext, secret: string): Promise<Grant> {
  const { manifest, adapterHash, grants } = ctx.input
  const grant = await guarded('grant', () => grants.find(manifest.id, adapterHash, secret))
  // The store is asked for exactly this adapter and hash; a grant for anything else is not a grant.
  if (
    grant === null ||
    grant.adapterId !== manifest.id ||
    grant.adapterHash !== adapterHash ||
    grant.secret !== secret
  ) {
    throw new ValetError('secret-fill', 'not-granted')
  }
  return grant
}

/**
 * Polls Messages until a code arrives or the flow runs out of time. Codes that arrived before the
 * flow started are never accepted, so a stale code from an earlier login can't be replayed.
 */
async function readOtp(ctx: FlowContext, query: MessagesOtpQuery): Promise<SecretValue> {
  for (;;) {
    try {
      return await resolveSecret(() => ctx.input.otpReader.latest(query, ctx.startedAt), 'otp')
    } catch (error) {
      if (!(error instanceof ValetError) || error.errorClass !== 'not-found') throw error
    }
    await checkNavigation(ctx)
    await checkBlocked(ctx)
    checkAborted(ctx)
    if (now(ctx) >= ctx.deadline) throw new ValetError('otp', 'not-found')
    await pause(ctx, Math.min(OTP_POLL_MS, remainingMs(ctx)))
  }
}

/** Runs a provider call, turning its failures into `<stage>: <failure>` and nothing more. */
async function resolveSecret(resolve: () => Promise<SecretValue>, stage: Stage): Promise<SecretValue> {
  let value: unknown
  try {
    value = await resolve()
  } catch (error) {
    if (error instanceof CredentialError && RESOLVE_FAILURES.includes(error.failure)) {
      throw new ValetError(stage, error.failure satisfies ErrorClass)
    }
    throw new ValetError(stage, 'internal')
  }
  // A provider that hands back a plain string has already let the value out of its box.
  if (!(value instanceof SecretValue)) throw new ValetError(stage, 'internal')
  return value
}

/**
 * The page and element checks, in the order docs/security-model.md gives them. Returns the element.
 * They run before the value is fetched and again once it is in hand, and the second run matters
 * most: the page may have bounced through another host while the person approved Touch ID, and the
 * after-step checks only see that once the step, and so the typing, is over.
 */
async function checkTarget(
  ctx: FlowContext,
  selector: string,
  field: SecretField,
  origins: readonly string[],
): Promise<ElementInfo> {
  const { page } = ctx.input
  await checkNavigation(ctx)
  await checkBlocked(ctx)
  const element = await guarded('secret-fill', () => page.inspect(selector))
  if (element === null || !element.visible) throw new ValetError('secret-fill', 'element-missing')
  if (!originAllowed(element.frameOrigin, origins)) {
    throw new ValetError('secret-fill', 'origin-mismatch')
  }
  const currentUrl = await guarded('secret-fill', () => page.currentUrl())
  if (!urlOriginAllowed(currentUrl, origins)) throw new ValetError('secret-fill', 'origin-mismatch')
  // Strictly true: the driver can't deliver trusted keystrokes into an out-of-process frame, and
  // finding that out only after the person approved Touch ID would ask them again for nothing.
  if (element.inputReachable !== true) throw new ValetError('secret-fill', 'input-unreachable')
  if (!suitsField(element, field)) throw new ValetError('secret-fill', 'element-unsuitable')
  // A password typed into a form that posts elsewhere, or into no form at all (a search box), ends
  // up in URLs, history and analytics.
  if (
    field === 'password' &&
    (element.formActionOrigin === null || !originAllowed(element.formActionOrigin, origins))
  ) {
    throw new ValetError('secret-fill', 'form-action-mismatch')
  }
  return element
}

/**
 * Focuses the target, then runs every check again on what the selector finds now, so the checks
 * describe the element focus landed on rather than one an SPA re-render has since replaced (say,
 * the login form swapped for a same-origin search box). The driver then types only into the
 * focused element and stops if focus moves, so nothing typed can reach an element these checks
 * didn't see. The remaining gap, a selector that resolves to a different element for focus() than
 * for inspect() at the same moment, needs focus() to report what it focused; see the README.
 */
async function focusTarget(
  ctx: FlowContext,
  selector: string,
  field: SecretField,
  origins: readonly string[],
): Promise<ElementInfo> {
  await guarded('secret-fill', () => ctx.input.page.focus(selector))
  return checkTarget(ctx, selector, field, origins)
}

/**
 * Hands the runtime its copy for redaction, audits, then types into the focused element. Auditing
 * first means a secret is never typed without a record of it: if the audit log can't be written,
 * the fill doesn't happen. The driver checks the focused frame's origin against `origins` before
 * every keystroke, so a page that moves focus or navigates mid-secret gets none of the rest.
 */
async function typeSecret(
  ctx: FlowContext,
  value: SecretValue,
  secret: string,
  field: SecretField,
  element: ElementInfo,
  origins: readonly string[],
): Promise<void> {
  const { page, audit, manifest, adapterHash, callId, typingDelayMs, rememberSecret } = ctx.input
  // A cancel that landed while the provider was resolving (Touch ID, say) stops before any typing.
  checkAborted(ctx)
  remember(value, rememberSecret)
  await guarded('secret-fill', () =>
    audit.append({
      type: 'secret-used',
      adapterId: manifest.id,
      adapterHash,
      secret,
      field,
      // checkTarget has already established that this is an allowed https origin.
      origin: httpsOrigin(element.frameOrigin) ?? element.frameOrigin,
      callId,
    }),
  )
  // Set before typing, not after: a stop part-way through a password may still have spent an attempt.
  if (field === 'password' || field === 'otp') ctx.attemptStarted = true
  await guarded('secret-fill', () =>
    page.type(value, { delayMs: typingDelayMs, allowedOrigins: [...origins] }),
  )
}

/**
 * Gives the runtime an independent copy, so tool output can still be redacted after this one is
 * disposed. If the runtime can't take it, the secret isn't typed: a value that might later appear
 * unredacted is worse than a login that didn't happen.
 */
function remember(value: SecretValue, rememberSecret: (secret: SecretValue) => void): void {
  const copy = value.clone()
  try {
    rememberSecret(copy)
  } catch {
    copy.dispose()
    throw new ValetError('secret-fill', 'internal')
  }
}
