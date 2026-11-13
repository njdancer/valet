// How the audit log words each event kind, from the record's structured fields only. Every map here
// is a Record over core's AuditEvent['type'] (checked with `satisfies`), so a kind added to core fails
// the typecheck until it has words: one line in EVENT_WORDS, one in EVENT_FIELDS and a case in
// details(). Kinds this build doesn't know (a newer main process) still show, as "Other event".

import type { AuditEvent, AuditRecord } from '@valet/core'
import { Badge, type BadgeProps, Code, type DotTone, HashChip } from '@valet/ui'
import type { ReactNode } from 'react'
import { formatDuration, formatTime, hostOf } from '../../lib/format'
import {
  blockedWording,
  clientLabel,
  errorWording,
  needsUserWording,
  PROVIDER_WORDING,
  stageWording,
  waitWording,
} from '../../lib/wording'

type EventType = AuditEvent['type']

/** The kind of record in plain words, with a dot tone. */
export const EVENT_WORDS = {
  'adapter-approved': { label: 'Version approved', tone: 'success' },
  'adapter-rejected': { label: 'Version rejected', tone: 'neutral' },
  'adapter-installed': { label: 'Version installed', tone: 'neutral' },
  'adapter-activated': { label: 'Rolled back', tone: 'warning' },
  'adapter-refused': { label: 'Version refused', tone: 'danger' },
  'adapter-removed': { label: 'Site removed', tone: 'neutral' },
  'grant-made': { label: 'Login given', tone: 'brass' },
  'grant-revoked': { label: 'Login taken back', tone: 'neutral' },
  'grant-copied': { label: 'Login copied', tone: 'brass' },
  'tool-called': { label: 'Call started', tone: 'accent' },
  'tool-finished': { label: 'Call finished', tone: 'success' },
  'call-waited': { label: 'Call waited', tone: 'neutral' },
  'login-started': { label: 'Login started', tone: 'neutral' },
  'login-finished': { label: 'Login finished', tone: 'success' },
  'secret-used': { label: 'Login typed', tone: 'brass' },
  'local-access': { label: 'Local data used', tone: 'brass' },
  'request-blocked': { label: 'Request blocked', tone: 'danger' },
  'breaker-opened': { label: 'Site paused calls', tone: 'warning' },
  'breaker-closed': { label: 'Site allows calls again', tone: 'success' },
  'update-downloaded': { label: 'App update downloaded', tone: 'neutral' },
  'update-installed': { label: 'App updated', tone: 'neutral' },
  'remote-state': { label: 'Remote access changed', tone: 'neutral' },
  'remote-tool': { label: 'Cloud agent tool changed', tone: 'neutral' },
  'setting-changed': { label: 'Setting changed', tone: 'neutral' },
  'remote-consent': { label: 'Cloud agent connection', tone: 'neutral' },
  'remote-revoked': { label: 'Cloud agent removed', tone: 'neutral' },
  'remote-token-reuse': { label: 'Stolen token refused', tone: 'danger' },
  confirmation: { label: 'Confirmation answered', tone: 'warning' },
  'lock-down': { label: 'Lock down', tone: 'danger' },
  'site-paused': { label: 'Site paused', tone: 'warning' },
  'approval-requested': { label: 'Approval asked', tone: 'warning' },
  'approval-answered': { label: 'Approval answered', tone: 'neutral' },
  'agent-change': { label: 'Agent change', tone: 'neutral' },
  'device-paired': { label: 'Phone paired', tone: 'brass' },
  'device-revoked': { label: 'Phone removed', tone: 'neutral' },
  'store-refused': { label: 'Saved approvals refused', tone: 'danger' },
  'draft-created': { label: 'Draft started', tone: 'neutral' },
  'draft-submitted': { label: 'Draft submitted', tone: 'warning' },
  'draft-deleted': { label: 'Draft deleted', tone: 'neutral' },
  'draft-trial': { label: 'Draft tried on the site', tone: 'neutral' },
} as const satisfies Readonly<Record<EventType, { readonly label: string; readonly tone: DotTone }>>

const OTHER = { label: 'Other event', tone: 'neutral' } as const

/** A record's kind in words; a finished call or login takes its tone from how it ended. */
export function eventWords(event: AuditEvent): { readonly label: string; readonly tone: DotTone } {
  const words: { readonly label: string; readonly tone: DotTone } = Object.hasOwn(EVENT_WORDS, event.type)
    ? EVENT_WORDS[event.type]
    : OTHER
  if (event.type === 'tool-finished' || event.type === 'login-finished') {
    if (event.outcome === 'failed' || event.outcome === 'blocked')
      return { label: event.type === 'tool-finished' ? 'Call failed' : 'Login failed', tone: 'danger' }
    if (event.outcome === 'needsUser')
      return { label: event.type === 'tool-finished' ? 'Call needs you' : 'Login stopped', tone: 'warning' }
    if (event.outcome === 'declined') return { label: 'Call declined', tone: 'neutral' }
  }
  // One event type records both directions.
  if (event.type === 'site-paused' && !event.paused) return { label: 'Site resumed', tone: 'success' }
  return words
}

type Tone = NonNullable<BadgeProps['tone']>

const OUTCOME_TONE: Readonly<Record<string, Tone>> = {
  ok: 'success',
  needsUser: 'warning',
  failed: 'danger',
  blocked: 'danger',
  declined: 'neutral',
}

const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  ok: 'ok',
  needsUser: 'needs you',
  failed: 'failed',
  blocked: 'blocked',
  declined: 'declined',
}

function Outcome({ outcome }: { readonly outcome: string }) {
  return (
    <Badge tone={OUTCOME_TONE[outcome] ?? 'neutral'}>
      {Object.hasOwn(OUTCOME_TEXT, outcome) ? OUTCOME_TEXT[outcome] : 'other'}
    </Badge>
  )
}

function Quiet({ children }: { readonly children: ReactNode }) {
  return <span className="text-sm text-fg-muted">{children}</span>
}

const BLOCKED_REASONS = new Set([
  'host-not-allowed',
  'undeclared',
  'denied-path',
  'ambiguous-path',
  'purpose-exceeded',
  'request-ceiling',
  'bad-url',
])

function isBlockedReason(reason: string): reason is Parameters<typeof blockedWording>[0] {
  return BLOCKED_REASONS.has(reason)
}

function providerTitle(provider: string): string {
  return Object.hasOwn(PROVIDER_WORDING, provider)
    ? PROVIDER_WORDING[provider as keyof typeof PROVIDER_WORDING].title
    : provider
}

/** One line per event, from structured fields only. */
export function details(event: AuditEvent, now: number): ReactNode {
  switch (event.type) {
    case 'adapter-approved':
      return (
        <>
          {event.adapterId} {event.version} <HashChip value={event.adapterHash} label="adapter hash" />
          {event.previousHash === null ? <Quiet> first install</Quiet> : null}
        </>
      )
    case 'adapter-rejected':
      return (
        <>
          {event.adapterId} {event.version} <HashChip value={event.adapterHash} label="adapter hash" />{' '}
          <Badge>rejected</Badge>
        </>
      )
    case 'adapter-installed':
      return (
        <>
          {event.adapterId} {event.version} <HashChip value={event.adapterHash} label="adapter hash" />{' '}
          <Quiet>from {event.source === 'builtin' ? 'the app' : event.source}, waiting for approval</Quiet>
        </>
      )
    case 'adapter-activated':
      return (
        <>
          {event.adapterId} back to {event.version}{' '}
          <HashChip value={event.adapterHash} label="adapter hash" />
        </>
      )
    case 'adapter-refused':
      return (
        <>
          {event.adapterId} <HashChip value={event.adapterHash} label="adapter hash" />{' '}
          <Quiet>failed its checks ({event.reason}) and did not run</Quiet>
        </>
      )
    case 'adapter-removed':
      return (
        <>
          {event.adapterId} {event.version} <HashChip value={event.adapterHash} label="adapter hash" />{' '}
          <Quiet>
            removed, with its logins and browser data
            {event.clientId === null ? '' : `, as ${event.clientId} asked`}
          </Quiet>
        </>
      )
    case 'grant-made':
      return (
        <>
          {event.secret} → {providerTitle(event.provider)} · for{' '}
          <HashChip value={event.adapterHash} label="adapter hash" /> on{' '}
          <Code>{event.origins.map(hostOf).join(', ')}</Code>
        </>
      )
    case 'grant-copied':
      return (
        <>
          {event.adapterId} · {event.secret} <Quiet>copied from 1Password</Quiet>
        </>
      )
    case 'grant-revoked':
      return (
        <>
          {event.adapterId} · {event.secret} <Quiet>revoked</Quiet>
        </>
      )
    case 'tool-called':
      return (
        <>
          <Code>{event.tool}</Code> · “{clientLabel(event.client)}”
        </>
      )
    case 'tool-finished':
      return (
        <>
          <Outcome outcome={event.outcome} />{' '}
          <Quiet>
            {event.needsUser !== undefined ? `${needsUserWording(event.needsUser).short} · ` : ''}
            {event.stage !== undefined && event.errorClass !== undefined
              ? `${stageWording(event.stage)} / ${errorWording(event.errorClass)} · `
              : ''}
            {formatDuration(event.durationMs)}
          </Quiet>
        </>
      )
    case 'call-waited':
      return <Quiet>{waitWording(event.reason, event.waitedMs, event.ahead ?? null)}</Quiet>
    case 'login-started':
      return <Quiet>{event.callId === null ? 'Started from the app' : 'Started by a tool call'}</Quiet>
    case 'login-finished':
      return (
        <>
          <Outcome outcome={event.outcome} />{' '}
          {event.needsUser !== undefined ? <Quiet>{needsUserWording(event.needsUser).short}</Quiet> : null}
          {event.stage !== undefined && event.errorClass !== undefined ? (
            <Quiet>
              {stageWording(event.stage)} / {errorWording(event.errorClass)}
            </Quiet>
          ) : null}
        </>
      )
    case 'secret-used':
      return (
        <>
          {event.secret}.{event.field} · <Code>{hostOf(event.origin)}</Code>
        </>
      )
    case 'local-access':
      return (
        <>
          <Code>{event.capability}</Code>{' '}
          <Quiet>{event.errorClass === null ? 'allowed' : event.errorClass}</Quiet>
        </>
      )
    case 'request-blocked':
      return (
        <>
          {event.method} <Code>{event.target}</Code>{' '}
          <Quiet>
            {event.initiator === 'page' ? 'page · ' : ''}
            {isBlockedReason(event.reason) ? blockedWording(event.reason) : 'blocked'}
          </Quiet>
        </>
      )
    case 'breaker-opened':
      return (
        <>
          <Code>{event.host}</Code>{' '}
          <Quiet>
            {event.cause === 'rate-limited' ? 'rate limited' : 'blocked by site'} · until{' '}
            {formatTime(event.retryAt, now)}
          </Quiet>
        </>
      )
    case 'breaker-closed':
      return (
        <>
          <Code>{event.host}</Code> <Quiet>calls allowed again</Quiet>
        </>
      )
    case 'confirmation':
      return (
        <>
          <Code>{event.tool}</Code> ·{' '}
          <Badge tone={event.answer === 'approved' ? 'success' : 'neutral'}>{event.answer}</Badge>{' '}
          <Quiet>“{clientLabel(event.client)}”</Quiet>
        </>
      )
    case 'update-downloaded':
    case 'update-installed':
      return (
        <>
          <Code>{event.from}</Code> → <Code>{event.to}</Code>
        </>
      )
    case 'remote-state':
      return (
        <Quiet>
          {event.state === 'on' ? 'Turned on' : 'Paused'}
          {event.revokedTokens > 0 ? ` · ${event.revokedTokens} tokens revoked` : ''}
        </Quiet>
      )
    case 'remote-tool':
      return (
        <>
          {event.adapterId} · <Code>{event.tool}</Code>{' '}
          <Quiet>{event.enabled ? 'allowed' : 'not allowed'}</Quiet>
        </>
      )
    case 'setting-changed':
      return (
        <>
          {event.adapterId} · <Code>{event.setting}</Code>{' '}
          <Quiet>{event.cleared ? 'cleared' : 'chosen'}</Quiet>
        </>
      )
    case 'remote-consent':
      return (
        <>
          <Code>{event.clientHost}</Code> <Quiet>{event.answer}</Quiet>
        </>
      )
    case 'remote-revoked':
      return <Quiet>{event.clientId === null ? `All ${event.clients} removed` : 'One removed'}</Quiet>
    case 'remote-token-reuse':
      return (
        <Quiet>A used {event.token === 'code' ? 'code' : 'refresh token'} came back; access revoked</Quiet>
      )
    case 'lock-down':
      return event.locked ? (
        <>
          Locked down
          {event.revokedClients > 0 ? (
            <Quiet>
              {' '}
              · {event.revokedClients} cloud {event.revokedClients === 1 ? 'agent' : 'agents'} removed
            </Quiet>
          ) : null}
        </>
      ) : (
        <>Unlocked</>
      )
    case 'site-paused':
      return (
        <>
          {event.adapterId} <Quiet>{event.paused ? 'paused' : 'resumed'}</Quiet>
        </>
      )
    case 'approval-requested':
      return <Code>{event.kind}</Code>
    case 'approval-answered':
      return <Quiet>{event.answer}</Quiet>
    case 'agent-change':
      return (
        <>
          <Code>{event.target}</Code>{' '}
          <Quiet>
            {event.action === 'tool-off'
              ? 'turned off for the agent'
              : event.action === 'disconnect'
                ? 'disconnected itself'
                : `set to ${event.value ?? ''}`}
          </Quiet>
        </>
      )
    case 'device-paired':
    case 'device-revoked':
      return <Code>{event.deviceId.slice(0, 8)}</Code>
    case 'draft-created':
    case 'draft-submitted':
    case 'draft-deleted':
    case 'draft-trial':
      return (
        <>
          <Code>{event.adapterId}</Code> <Quiet>{event.draftId}</Quiet>
        </>
      )
    case 'store-refused':
      return (
        <>
          <Code>{event.store}</Code>{' '}
          <Quiet>
            {event.reason === 'anchor-mismatch'
              ? 'changed outside Valet'
              : `${event.records} without a valid approval`}
          </Quiet>
        </>
      )
    default:
      return null
  }
}

/** The site a record is about, if any. */
export function siteOf(event: AuditEvent): string | null {
  return 'adapterId' in event && typeof event.adapterId === 'string' ? event.adapterId : null
}

/** The call a record belongs to, if any. */
export function callOf(event: AuditEvent): string | null {
  return 'callId' in event && typeof event.callId === 'string' ? event.callId : null
}

/**
 * The fields core's AuditEvent defines, per type. The inspector and Copy record show these and
 * nothing else, so a field the main process should never have written can't reach the screen.
 */
export const EVENT_FIELDS = {
  'adapter-approved': ['type', 'adapterId', 'adapterHash', 'version', 'previousHash'],
  'adapter-rejected': ['type', 'adapterId', 'adapterHash', 'version'],
  'adapter-installed': [
    'type',
    'adapterId',
    'adapterHash',
    'version',
    'source',
    'previousHash',
    'appVersion',
    'preludeHash',
    'compiler',
  ],
  'adapter-activated': ['type', 'adapterId', 'adapterHash', 'version', 'previousHash'],
  'adapter-refused': ['type', 'adapterId', 'adapterHash', 'reason'],
  'adapter-removed': ['type', 'adapterId', 'adapterHash', 'version', 'clientId'],
  'grant-made': ['type', 'adapterId', 'adapterHash', 'secret', 'provider', 'origins'],
  'grant-revoked': ['type', 'adapterId', 'secret'],
  'grant-copied': ['type', 'adapterId', 'secret', 'fields'],
  'tool-called': ['type', 'adapterId', 'adapterHash', 'tool', 'client', 'clientId', 'callId'],
  'tool-finished': [
    'type',
    'adapterId',
    'callId',
    'outcome',
    'needsUser',
    'stage',
    'errorClass',
    'durationMs',
  ],
  'call-waited': ['type', 'adapterId', 'callId', 'reason', 'waitedMs', 'ahead'],
  'login-started': ['type', 'adapterId', 'callId'],
  'login-finished': ['type', 'adapterId', 'outcome', 'needsUser', 'stage', 'errorClass'],
  'secret-used': ['type', 'adapterId', 'adapterHash', 'secret', 'field', 'origin', 'callId'],
  'local-access': ['type', 'adapterId', 'callId', 'capability', 'errorClass'],
  'request-blocked': ['type', 'adapterId', 'method', 'target', 'reason', 'initiator', 'partition', 'callId'],
  'breaker-opened': ['type', 'host', 'cause', 'retryAt', 'callId'],
  'breaker-closed': ['type', 'host'],
  'update-downloaded': ['type', 'from', 'to'],
  'update-installed': ['type', 'from', 'to'],
  'remote-state': ['type', 'state', 'revokedTokens'],
  'remote-tool': ['type', 'adapterId', 'tool', 'enabled', 'sideEffect'],
  'setting-changed': ['type', 'adapterId', 'setting', 'cleared'],
  'remote-consent': ['type', 'clientId', 'clientHost', 'source', 'tools', 'answer'],
  'remote-revoked': ['type', 'clientId', 'clients'],
  'remote-token-reuse': ['type', 'clientId', 'token'],
  confirmation: ['type', 'adapterId', 'tool', 'client', 'callId', 'answer'],
  'lock-down': ['type', 'locked', 'revokedClients'],
  'site-paused': ['type', 'adapterId', 'paused'],
  'approval-requested': ['type', 'requestId', 'kind', 'digest', 'clientId'],
  'approval-answered': ['type', 'requestId', 'answer', 'deviceId', 'reason'],
  'agent-change': ['type', 'clientId', 'action', 'target', 'value'],
  'device-paired': ['type', 'deviceId', 'platform'],
  'device-revoked': ['type', 'deviceId', 'by'],
  'store-refused': ['type', 'store', 'reason', 'records'],
  'draft-created': ['type', 'draftId', 'adapterId', 'clientId'],
  'draft-submitted': ['type', 'draftId', 'adapterId', 'clientId', 'adapterHash', 'packageHash', 'requestId'],
  'draft-deleted': ['type', 'draftId', 'adapterId', 'clientId'],
  'draft-trial': ['type', 'draftId', 'adapterId', 'clientId', 'tool', 'host', 'packageHash', 'outcome'],
} as const satisfies {
  readonly [K in EventType]: readonly (keyof Extract<AuditEvent, { readonly type: K }>)[]
}

type Shown = string | number | boolean | null | readonly string[]

/** A field's value if it is the kind core writes (a scalar or a list of strings), else a placeholder. */
function shownValue(value: unknown): Shown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value as Shown
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  return '[not shown]'
}

/** The record with only the fields core's audit format defines. */
export function shownRecord(record: AuditRecord): Record<string, unknown> {
  const type = record.event.type
  const fields: readonly string[] = Object.hasOwn(EVENT_FIELDS, type) ? EVENT_FIELDS[type] : ['type']
  const event = record.event as unknown as Record<string, unknown>
  const shown: Record<string, Shown> = {}
  for (const field of fields) {
    if (Object.hasOwn(event, field) && event[field] !== undefined) shown[field] = shownValue(event[field])
  }
  return {
    seq: shownValue(record.seq),
    at: shownValue(record.at),
    event: shown,
    prev: shownValue(record.prev),
    hash: shownValue(record.hash),
  }
}

/** A hash field as text, or null when the record holds something that isn't a hash string. */
export function hashText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
