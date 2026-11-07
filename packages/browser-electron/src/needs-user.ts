// The window title the person sees when a run hands the auth window to them. The reason is a code
// from core's fixed vocabulary; the wording is the app's own. Nothing a manifest or adapter wrote
// reaches the title: a manifest's note is shown by the app's own chrome, not here.

import { NEEDS_USER_REASONS, type NeedsUserReason } from '@valet/core'

const WORDING: Readonly<Record<NeedsUserReason, (site: string) => string>> = {
  'login-required': (site) => `${site} needs you to log in`,
  'otp-required': (site) => `${site} needs a verification code from you`,
  captcha: (site) => `${site} showed a verification check that Valet won’t solve for you`,
  'account-locked': (site) => `${site} says your account is locked`,
  'terms-update': (site) => `${site} wants you to accept updated terms`,
  'site-changed': (site) => `${site}’s login page has changed: finish logging in yourself`,
  'login-attempt-pending': (site) => `A login to ${site} may not have finished: check before trying again`,
  other: (site) => `${site} needs you to finish logging in`,
}

const CLOSE_HINT = 'Close this window when you’re done.'

/**
 * The title for a hand-off window. `site` is the manifest's name, which the person approved. A
 * reason outside the vocabulary (only possible from untyped callers) gets the generic wording, never
 * its own text.
 */
export function needsUserTitle(reason: NeedsUserReason, site: string): string {
  const known = (NEEDS_USER_REASONS as readonly string[]).includes(reason) ? reason : 'other'
  return `${WORDING[known](site)}. ${CLOSE_HINT}`
}
