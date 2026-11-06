// The privileged filler: the only code in siteadapter that hands a secret to a page. It checks the
// grant, the manifest and the target element before fetching the value, fetches it just in time,
// checks the target again (the person may have taken a while over Touch ID), and disposes the value
// whatever happens.

import {
  CredentialError,
  type ElementInfo,
  type ErrorClass,
  httpsOrigin,
  type MessagesOtpQuery,
  originAllowed,
  type ResolveFailure,
  type SecretField,
  type SecretRef,
  SecretValue,
  SiteAdapterError,
  type Stage,
  urlOriginAllowed,
} from '@siteadapter/core'
import { checkBlocked, checkNavigation, type FlowContext, guarded, now, remainingMs } from './context'
import { allowedOrigins, suitsField } from './guards'

/** How often to look for a one-time code that hasn't arrived yet. */
export const OTP_POLL_MS = 1000

/** The audit log's name for codes read from Messages, which have no secret request of their own. */
export const MESSAGES_SECRET = 'messages'

const RESOLVE_FAILURES: readonly ResolveFailure[] = ['locked', 'not-found', 'field-missing', 'unavailable']

/** Fills a secret from a credential provider: `fill` with a secret ref, or `otp` with a secret source. */
export async function fillSecret(ctx: FlowContext, selector: string, ref: SecretRef): Promise<void> {
  const { manifest, adapterHash, grants, providers } = ctx.input
  const grant = await guarded('grant', () => grants.find(manifest.id, adapterHash, ref.secret))
  // The store is asked for exactly this adapter and hash; a grant for anything else is not a grant.
  if (
    grant === null ||
    grant.adapterId !== manifest.id ||
    grant.adapterHash !== adapterHash ||
    grant.secret !== ref.secret
  ) {
    throw new SiteAdapterError('secret-fill', 'not-granted')
  }
  // hasOwn, because a secret named "constructor" would otherwise find Object's.
  const request = Object.hasOwn(manifest.secrets, ref.secret) ? manifest.secrets[ref.secret] : undefined
  if (request === undefined || !request.fields.includes(ref.field)) {
    throw new SiteAdapterError('secret-fill', 'invalid')
  }
  const origins = allowedOrigins(grant.origins, request.origins)
  await checkTarget(ctx, selector, ref.field, origins)

  const provider = providers[grant.provider]
  if (provider === undefined) throw new SiteAdapterError('credential', 'unavailable')
  const secret = await resolveSecret(() => provider.resolve(grant.itemRef, ref.field), 'credential')
  try {
    const element = await checkTarget(ctx, selector, ref.field, origins)
    await typeSecret(ctx, selector, secret, ref.secret, ref.field, element)
  } finally {
    secret.dispose()
  }
}

/**
 * Fills a one-time code read from Messages. There is no secret request to take origins from, so the
 * code may go to any origin on the navigation allowlist, and the element checks still apply.
 */
export async function fillMessagesOtp(
  ctx: FlowContext,
  selector: string,
  source: { readonly sender?: string | undefined; readonly pattern: string; readonly maxAgeSeconds: number },
): Promise<void> {
  const origins = ctx.input.manifest.navigation
  await checkTarget(ctx, selector, 'otp', origins)
  const query: MessagesOtpQuery = {
    ...(source.sender === undefined ? {} : { sender: source.sender }),
    pattern: source.pattern,
    maxAgeSeconds: source.maxAgeSeconds,
  }
  const code = await readOtp(ctx, query)
  try {
    const element = await checkTarget(ctx, selector, 'otp', origins)
    await typeSecret(ctx, selector, code, MESSAGES_SECRET, 'otp', element)
  } finally {
    code.dispose()
  }
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
      if (!(error instanceof SiteAdapterError) || error.errorClass !== 'not-found') throw error
    }
    await checkNavigation(ctx)
    await checkBlocked(ctx)
    if (now(ctx) >= ctx.deadline) throw new SiteAdapterError('otp', 'not-found')
    await ctx.input.sleep(Math.min(OTP_POLL_MS, remainingMs(ctx)))
  }
}

/** Runs a provider call, turning its failures into `<stage>: <failure>` and nothing more. */
async function resolveSecret(resolve: () => Promise<SecretValue>, stage: Stage): Promise<SecretValue> {
  let value: unknown
  try {
    value = await resolve()
  } catch (error) {
    if (error instanceof CredentialError && RESOLVE_FAILURES.includes(error.failure)) {
      throw new SiteAdapterError(stage, error.failure satisfies ErrorClass)
    }
    throw new SiteAdapterError(stage, 'internal')
  }
  // A provider that hands back a plain string has already let the value out of its box.
  if (!(value instanceof SecretValue)) throw new SiteAdapterError(stage, 'internal')
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
  if (element === null || !element.visible) throw new SiteAdapterError('secret-fill', 'element-missing')
  if (!originAllowed(element.frameOrigin, origins)) {
    throw new SiteAdapterError('secret-fill', 'origin-mismatch')
  }
  const currentUrl = await guarded('secret-fill', () => page.currentUrl())
  if (!urlOriginAllowed(currentUrl, origins)) throw new SiteAdapterError('secret-fill', 'origin-mismatch')
  if (!suitsField(element, field)) throw new SiteAdapterError('secret-fill', 'element-unsuitable')
  // A password typed into a form that posts elsewhere, or into no form at all (a search box), ends
  // up in URLs, history and analytics.
  if (
    field === 'password' &&
    (element.formActionOrigin === null || !originAllowed(element.formActionOrigin, origins))
  ) {
    throw new SiteAdapterError('secret-fill', 'form-action-mismatch')
  }
  return element
}

/**
 * Audits, then types. Auditing first means a secret is never typed without a record of it: if the
 * audit log can't be written, the fill doesn't happen.
 */
async function typeSecret(
  ctx: FlowContext,
  selector: string,
  value: SecretValue,
  secret: string,
  field: SecretField,
  element: ElementInfo,
): Promise<void> {
  const { page, audit, manifest, adapterHash, callId, typingDelayMs } = ctx.input
  await guarded('secret-fill', () => page.focus(selector))
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
  await guarded('secret-fill', () => page.type(value, { delayMs: typingDelayMs }))
}
