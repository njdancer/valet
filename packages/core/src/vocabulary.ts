// The words Valet uses for what waits on the person, in one place: the app's Needs you list, the menu
// bar, the system notification and the MCP tool result all build their titles here, so the same
// thing has the same name in all four (docs/ux/information-architecture.md, sections 5 and 7). No
// Node imports, so the renderer bundle imports it too: import { needsYouTitle } from
// '@valet/core/vocabulary'.
//
// Names that come from an adapter (its name, a tool's or a setting's title) are ones the person
// approved with it; they pass through plainName first, so a title is always one bounded line.

import type { NeedsUserReason } from './errors'

const MAX_NAME = 60

/** A name for a title: one line, no control or formatting characters, at most 60 characters. */
export function plainName(text: string, max: number = MAX_NAME): string {
  const plain = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

/**
 * A call's short reference, as the app, its tool results and the person say it: the first four hex
 * digits of the call id, uppercased ("7F2A"). Anything that isn't hex is skipped, so a prefix such
 * as `st_` doesn't show; an id with fewer than four hex digits uses its first four letters or digits.
 */
export function callRef(callId: string): string {
  const hex = callId.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length >= 4) return hex.slice(0, 4).toUpperCase()
  const plain = callId.replace(/[^0-9A-Za-z]/g, '')
  return (plain.length > 0 ? plain.slice(0, 4) : '----').toUpperCase()
}

/**
 * A time of day as the person reads it: "9:50 pm". In the machine's own time zone unless one is
 * given (tests pass one). An unreadable time is "soon".
 */
export function clockTime(at: string | number | Date, timeZone?: string): string {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return 'soon'
  const parts = new Intl.DateTimeFormat('en-AU', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(date)
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '12'
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  const period = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase().replace(/\./g, '')
  return `${Number(hour) === 0 ? 12 : Number(hour)}:${minute} ${period.startsWith('p') ? 'pm' : 'am'}`
}

/** What a login hand-off is waiting for, in the brackets of its title. */
export const HANDOFF_PHRASES: Readonly<Record<NeedsUserReason, string>> = {
  'login-required': 'login needed',
  'otp-required': 'one-time code',
  captcha: 'verification check',
  'account-locked': 'account locked',
  'terms-update': 'terms to accept',
  'site-changed': 'login page changed',
  'login-attempt-pending': 'earlier login unfinished',
  'setting-required': 'setting needed',
  other: 'needs you',
}

export function handoffPhrase(reason: NeedsUserReason): string {
  return Object.hasOwn(HANDOFF_PHRASES, reason) ? HANDOFF_PHRASES[reason] : HANDOFF_PHRASES.other
}

/** A setting's title as it reads inside a sentence: "Store" becomes "store", "PIN" stays. */
function inSentence(title: string): string {
  const plain = plainName(title)
  if (plain.length > 1 && plain[1] === plain[1]?.toUpperCase() && /[A-Z]/.test(plain[1] ?? '')) return plain
  return plain.charAt(0).toLowerCase() + plain.slice(1)
}

/** Enough of a Needs you item to name it. Matches the AttentionItem kinds in apps/desktop. */
export type NeedsYouSubject =
  | { readonly kind: 'confirmation'; readonly adapterName: string; readonly toolTitle: string }
  | { readonly kind: 'needs-user'; readonly adapterName: string; readonly reason: NeedsUserReason }
  | { readonly kind: 'remote-consent' }
  | {
      readonly kind: 'review'
      readonly adapterName: string
      readonly version: string
      /** No version of the site was approved before: a first install. */
      readonly firstInstall?: boolean
    }
  | { readonly kind: 'setting-missing'; readonly adapterName: string; readonly settingTitle: string }
  | { readonly kind: 'login-missing'; readonly adapterName: string }
  | { readonly kind: 'repair'; readonly adapterName: string }
  | { readonly kind: 'onepassword-locked' }
  | { readonly kind: 'setup'; readonly stepsLeft: number }
  | { readonly kind: 'audit-broken' }

/** The one title for a Needs you item, wherever it is shown. */
export function needsYouTitle(subject: NeedsYouSubject): string {
  switch (subject.kind) {
    case 'confirmation':
      return `Confirm: ${plainName(subject.toolTitle)} (${plainName(subject.adapterName)})`
    case 'needs-user':
      return `Log in to ${plainName(subject.adapterName)} (${handoffPhrase(subject.reason)})`
    case 'remote-consent':
      return 'Approve a connection'
    case 'review':
      return subject.firstInstall === true
        ? `Review ${plainName(subject.adapterName)} before first use`
        : `Review the ${plainName(subject.adapterName)} update (${plainName(subject.version, 30)})`
    case 'setting-missing':
      return `Choose your ${plainName(subject.adapterName)} ${inSentence(subject.settingTitle)}`
    case 'login-missing':
      return `Give Valet your ${plainName(subject.adapterName)} login`
    case 'repair':
      return `${plainName(subject.adapterName)} changed: the adapter needs an update`
    case 'onepassword-locked':
      return 'Unlock 1Password'
    case 'setup':
      return `Finish setup (${subject.stepsLeft} ${subject.stepsLeft === 1 ? 'step' : 'steps'} left)`
    case 'audit-broken':
      return 'The audit log doesn’t check out'
  }
}

/** The title of an item nobody answered in time. */
export function missedTitle(originalTitle: string): string {
  return `Missed: ${originalTitle}`
}

/** Where the person finds a call: "The person can see it in Valet, Activity, call 7F2A". */
export function seeCallSentence(callId: string): string {
  return `The person can see it in Valet, Activity, call ${callRef(callId)}`
}

/** A site the person paused: the status words, and what a tool result says. */
export function sitePausedLabel(adapterName: string): string {
  return `${plainName(adapterName)} paused`
}

export const PAUSED_LABEL = 'Paused'
export const LOCKED_DOWN_LABEL = 'Locked down'

/** Tool result: Valet as a whole is paused. */
export const PAUSED_RESULT =
  'Valet is paused, so this call was not started and nothing was sent (stage config: unavailable); ' +
  'the person can resume from the menu bar or the Valet window.'

/** Tool result: the person locked Valet down. */
export const LOCKED_DOWN_RESULT =
  'Valet is locked down by the person, so this call was refused and nothing was sent ' +
  '(config: locked-down). The endpoint stays up so agents get this text; cloud agents were removed.'

/** Tool result: one site is paused. */
export function sitePausedResult(adapterName: string): string {
  const site = plainName(adapterName)
  return (
    `${site} is paused in Valet, so this call was not started and nothing was sent ` +
    `(config: site-paused); ask the person to resume ${site} in Valet.`
  )
}

/** Tool result: the person closed a login hand-off without finishing it. */
export const GAVE_UP_RESULT =
  'The person closed the login without finishing (needs-user: gave-up); nothing was sent.'

/** Site limiting, in the app and in tool results. */
export function siteLimitingLabel(
  adapterName: string,
  resumesAt: string | number | Date,
  timeZone?: string,
): string {
  return `${plainName(adapterName)} is limiting requests · calls resume at ${clockTime(resumesAt, timeZone)}`
}

/** Valet's own hourly cap for a site. */
export function ownCapLabel(adapterName: string, until: string | number | Date, timeZone?: string): string {
  return `Valet is limiting its requests to ${plainName(adapterName)} until ${clockTime(until, timeZone)}`
}
