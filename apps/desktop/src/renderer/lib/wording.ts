// Human wording for every code the runtime reports. Codes cross the process boundary, wording never
// does: the app renders its own text, so an adapter can't phrase what the person reads. Each table
// is a Record over core's union, so adding a code to core fails the typecheck until it has words.
// An unrecognised code (a newer main process, say) gets a fixed fallback, never the code's text.

import type {
  BlockedRequest,
  ErrorClass,
  NeedsUserReason,
  ProviderKind,
  RunOutcome,
  Stage,
} from '@valet/core'
import type { FillCheck, SessionState } from '../../shared/api'

export interface ReasonWording {
  /** Short, for lists: "Verification check". */
  readonly short: string
  /** One sentence for the hand-off banner, after "<Site> needs you to finish logging in." */
  readonly detail: string
}

export const NEEDS_USER_WORDING: Readonly<Record<NeedsUserReason, ReasonWording>> = {
  'login-required': {
    short: 'Login needed',
    detail: "It needs you to sign in yourself; Valet couldn't do it with the secrets you granted.",
  },
  'otp-required': {
    short: 'One-time code',
    detail: 'It asked for a one-time code that Valet has no grant to read.',
  },
  captcha: {
    short: 'Verification check',
    detail: "It showed a verification check that Valet won't solve for you.",
  },
  'account-locked': {
    short: 'Account locked',
    detail: 'It says the account is locked. Valet has stopped trying so it is not locked out further.',
  },
  'terms-update': {
    short: 'Terms to accept',
    detail: 'It wants you to read and accept updated terms. Valet never accepts them for you.',
  },
  'site-changed': {
    short: 'Site changed',
    detail: "Its login page doesn't look the way the adapter expects. The adapter may need an update.",
  },
  'login-attempt-pending': {
    short: 'Earlier login unfinished',
    detail: 'An earlier login attempt never finished, so Valet won’t try again until you check the account.',
  },
  other: {
    short: 'Needs you',
    detail: 'It stopped at a step Valet can’t finish by itself.',
  },
}

const UNKNOWN_REASON: ReasonWording = {
  short: 'Needs you',
  detail: 'It stopped for a reason this version of the app doesn’t know.',
}

export function needsUserWording(reason: NeedsUserReason): ReasonWording {
  return Object.hasOwn(NEEDS_USER_WORDING, reason) ? NEEDS_USER_WORDING[reason] : UNKNOWN_REASON
}

export const STAGE_WORDING: Readonly<Record<Stage, string>> = {
  manifest: 'Adapter manifest',
  grant: 'Secret grant',
  credential: '1Password',
  navigate: 'Navigation',
  'auth-step': 'Login step',
  'secret-fill': 'Filling a secret',
  otp: 'One-time code',
  probe: 'Login check',
  'session-handoff': 'Session hand-off',
  'request-surface': 'Request surface',
  egress: 'Egress allowlist',
  'tool-input': 'Tool input',
  'tool-run': 'Tool code',
  'tool-output': 'Tool output',
  confirm: 'Confirmation',
  timeout: 'Timeout',
  login: 'Login',
  config: 'App files',
  update: 'App update',
}

/** Why a build doesn't update itself (UpdateStatus.disabledReason). */
export const UPDATES_OFF_WORDING: Readonly<Record<'not-configured' | 'development' | 'unsigned', string>> = {
  'not-configured': 'Off: this build has no update feed',
  development: 'Off in a development or demo build',
  unsigned: 'Off: Squirrel.Mac only installs updates for a Developer ID build',
}

export function updatesOffWording(reason: string): string {
  return Object.hasOwn(UPDATES_OFF_WORDING, reason)
    ? UPDATES_OFF_WORDING[reason as keyof typeof UPDATES_OFF_WORDING]
    : 'Off'
}

export function stageWording(stage: Stage): string {
  return Object.hasOwn(STAGE_WORDING, stage) ? STAGE_WORDING[stage] : 'Unknown stage'
}

export const ERROR_WORDING: Readonly<Record<ErrorClass, string>> = {
  invalid: 'Invalid',
  'not-granted': 'Not granted',
  locked: '1Password is locked',
  'not-found': 'Not found',
  'field-missing': 'Field missing from the item',
  unavailable: 'Unavailable',
  'origin-mismatch': 'Wrong origin',
  'element-missing': 'Element missing',
  'element-unsuitable': 'Field type not suitable',
  'form-action-mismatch': 'Form submits elsewhere',
  'navigation-escaped': 'Left the allowed sites',
  'condition-timeout': 'Waited too long',
  'auth-failed': 'Login failed',
  'not-logged-in': 'Not logged in',
  'blocked-by-site': 'Blocked by site',
  'rate-limited': 'Rate limited',
  'undeclared-request': 'Undeclared request',
  'denied-path': 'Denied path',
  'host-not-allowed': 'Host not allowed',
  'request-ceiling': 'Too many requests',
  'ambiguous-path': 'Ambiguous path',
  'unexpected-shape': 'Unexpected response',
  'site-changed': 'Site changed, adapter needs an update',
  'input-unreachable': 'Field unreachable',
  'insecure-file': 'Insecure file permissions',
  'login-in-progress': 'Login already running',
  unsupported: 'Unsupported',
  'signature-invalid': 'Signature didn’t verify',
  expired: 'Expired',
  declined: 'Declined',
  'timed-out': 'Timed out',
  aborted: 'Aborted',
  internal: 'Internal error',
}

export function errorWording(errorClass: ErrorClass): string {
  return Object.hasOwn(ERROR_WORDING, errorClass) ? ERROR_WORDING[errorClass] : 'Unknown error'
}

export const BLOCKED_WORDING: Readonly<Record<BlockedRequest['reason'], string>> = {
  'host-not-allowed': 'host not allowed',
  undeclared: 'undeclared request',
  'denied-path': 'denied path',
  'ambiguous-path': 'ambiguous path',
  'purpose-exceeded': 'beyond the tool’s side effect',
  'request-ceiling': 'over the request ceiling',
  'bad-url': 'malformed URL',
}

export function blockedWording(reason: BlockedRequest['reason']): string {
  return Object.hasOwn(BLOCKED_WORDING, reason) ? BLOCKED_WORDING[reason] : 'blocked'
}

/** What the blocked-request inspector says happened, by reason. */
export const BLOCKED_EXPLANATION: Readonly<Record<BlockedRequest['reason'], string>> = {
  'host-not-allowed':
    'The host is not in the manifest’s egress allowlist, so the request never left the page.',
  undeclared: 'The manifest declares no matching request, so it was cancelled before it left the page.',
  'denied-path':
    'The path touches checkout, payment or payees, and the matching declaration is not irreversible.',
  'ambiguous-path':
    'The path has encoded slashes or dot segments that servers read differently, so it is never sent.',
  'purpose-exceeded': 'The request is declared, but for a stronger side effect than this tool declares.',
  'request-ceiling': 'The run had already made as many requests as the manifest allows.',
  'bad-url': 'The URL could not be parsed.',
}

export function blockedExplanation(reason: BlockedRequest['reason']): string {
  return Object.hasOwn(BLOCKED_EXPLANATION, reason) ? BLOCKED_EXPLANATION[reason] : 'The request was refused.'
}

export const OUTCOME_WORDING: Readonly<Record<RunOutcome | 'running', string>> = {
  ok: 'ok',
  needsUser: 'needsUser',
  failed: 'failed',
  blocked: 'blocked',
  declined: 'declined',
  running: 'running',
}

export const OUTCOME_TONE: Readonly<Record<RunOutcome | 'running', 'ok' | 'warn' | 'bad' | 'info' | ''>> = {
  ok: 'ok',
  needsUser: 'warn',
  failed: 'bad',
  blocked: 'bad',
  declined: '',
  running: 'info',
}

export const PROVIDER_WORDING: Readonly<
  Record<ProviderKind, { readonly title: string; readonly detail: string }>
> = {
  'keychain-copy': {
    title: 'Copy in your Keychain',
    detail:
      'Copied once from your own 1Password item, with your approval there. Works while you’re away. When the password changes, re-sync it from 1Password.',
  },
  'onepassword-desktop': {
    title: '1Password, approved each time',
    detail:
      'Asks you to approve Valet in 1Password, then reads the item you picked. Approval lapses after ten idle minutes or when 1Password locks.',
  },
  'onepassword-service-account': {
    title: '1Password service account',
    detail:
      'Vault “Valet” only. Works while your Mac is locked or 1Password is closed. Revoke it any time at 1password.com.',
  },
  'onepassword-cli': {
    title: '1Password app',
    detail:
      'Asks for Touch ID when 1Password is locked or its CLI session has expired. If you’re away, the call returns needsUser.',
  },
  messages: {
    title: 'Messages',
    detail: 'Reads one-time codes that arrive by SMS from one sender you approve. Needs Full Disk Access.',
  },
  fake: {
    title: 'Test provider',
    detail: 'Fixed test values for development. Never used for a real site.',
  },
}

export const SESSION_WORDING: Readonly<Record<SessionState, string>> = {
  'logged-in': 'Logged in',
  expired: 'Expired',
  unknown: 'Not checked yet',
  'logging-in': 'Logging in',
  'needs-user': 'Login window open',
}

export const FILL_CHECK_WORDING: Readonly<Record<FillCheck, string>> = {
  'frame-origin': 'frame origin',
  'input-type': 'input type',
  'form-action': 'form submits to an allowed origin',
  'paced-keystrokes': 'typed as paced keystrokes',
  'input-reachable': 'trusted input reaches the field',
}

/**
 * Display names for the self-reported client names we know. Every client shares one token, so a
 * name is only what the client says: any process holding the token can call itself "claude-code".
 * Screens show the label as a claim (clientClaim, or ClientName with its "unverified" title).
 */
const CLIENT_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude Desktop',
}

/** Unknown names are cut to this many characters, so a long one can't push the wording off screen. */
export const MAX_CLIENT_NAME = 40

/**
 * The display form of a reported name. Anything unknown is shown as reported, minus control and
 * format characters (bidi overrides, zero-width joiners) that could make it read as something else.
 */
export function clientLabel(reportedName: string): string {
  if (Object.hasOwn(CLIENT_NAMES, reportedName)) return CLIENT_NAMES[reportedName] as string
  const visible = reportedName.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  if (visible === '') return 'unnamed client'
  const chars = [...visible]
  return chars.length > MAX_CLIENT_NAME ? `${chars.slice(0, MAX_CLIENT_NAME - 1).join('')}…` : visible
}

/** A reported name worded as the claim it is: “A client calling itself “Claude Code””. */
export function clientClaim(reportedName: string, start: 'sentence' | 'inline' = 'sentence'): string {
  return `${start === 'sentence' ? 'A' : 'a'} client calling itself “${clientLabel(reportedName)}”`
}

export const TRANSPORT_WORDING: Readonly<Record<'stdio' | 'http', string>> = {
  stdio: 'the stdio bridge',
  http: 'HTTP',
}

export const FIELD_WORDING = { username: 'username', password: 'password', otp: 'one-time code' } as const
