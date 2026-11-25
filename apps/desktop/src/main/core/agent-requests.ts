// An agent's request, as the Mac's Needs you shows it (docs/approval-broker.md, "Approving at the
// Mac"). The phone renders the same request from its signed text; this is the Mac's reading of it.
//
// Only the kinds no other item shows are here. Installs and updates are review items, a pairing
// and a resume are the person's own, and an irreversible call has its own confirmation panel.
// Every line is built from the request's subject. Text an adapter or agent wrote (a setting's
// label, the agent's note) is quoted or kept apart, never the headline's verb.

import { plainName, type SerializedRequest } from '@valet/core'
import type { AgentRequestItem, ReviewRequestInfo } from '../../shared/api'
import { requestRef } from './approvals/prompts'

type CardKind = AgentRequestItem['requestKind']
const CARD_KINDS: ReadonlySet<string> = new Set<CardKind>([
  'setting',
  'authoring-session',
  'browser-grant',
  'private-network',
  'tool-enable',
  'secret-grant',
])

/**
 * An agent's request to install its draft, as the Mac's review shows it: the ref the agent was told
 * to quote, who asked, its note, and the checks the Mac wrote on the card. Null for any other request.
 */
export function draftReviewRequest(serialized: SerializedRequest): ReviewRequestInfo | null {
  const request = serialized.request
  if (request.kind !== 'adapter-install' || request.requester.kind !== 'agent') return null
  const display = request.display
  return {
    ref: requestRef(serialized),
    client: display?.client?.label ?? request.requester.clientName,
    remote: display?.client?.badge === 'remote',
    note: request.agentNote,
    checks: [...(display?.checks ?? [])],
    agentTests: display?.agentTests === undefined ? null : { ...display.agentTests },
    draftId: request.context?.kind === 'draft' ? request.context.draftId : null,
    expiresAt: request.expiresAt,
  }
}

/** The Needs you item for a waiting request, or null for one another item shows (or the person's own). */
export function agentRequestItem(
  serialized: SerializedRequest,
  /** The installed site's name for an adapter id ("Woolworths"), or null when none is installed. */
  siteName: (adapterId: string) => string | null = () => null,
): AgentRequestItem | null {
  const request = serialized.request
  // The name the person approved the site under, not its id: "A Woolworths setting", not "woolworths".
  const nameOf = (adapterId: string): string => plainName(siteName(adapterId) ?? adapterId)
  if (request.requester.kind !== 'agent' || !CARD_KINDS.has(request.kind)) return null
  const base = {
    kind: 'agent-request' as const,
    id: request.id,
    ref: requestRef(serialized),
    agentName: request.requester.clientName,
    agentNote: request.agentNote,
    requestedAt: request.createdAt,
    expiresAt: request.expiresAt,
  }
  switch (request.kind) {
    case 'setting': {
      const s = request.subject
      const choices = s.choices ?? null
      return {
        ...base,
        requestKind: 'setting',
        adapterId: s.adapterId,
        title: `Change a setting: “${s.label}”`,
        details: [
          s.scope === 'valet'
            ? 'A Valet setting.'
            : s.adapterId === undefined || s.adapterId === null
              ? 'A setting of a site.'
              : `A ${nameOf(s.adapterId)} setting.`,
          choices === null ? `From “${s.from}” to “${s.to}”.` : `Now “${s.from}”. You pick the new value.`,
        ],
        choices: choices === null ? null : choices.map((c) => ({ value: c.value, label: c.label })),
      }
    }
    case 'authoring-session': {
      const s = request.subject
      return {
        ...base,
        requestKind: 'authoring-session',
        adapterId: s.adapterId,
        title: `Lend the agent your signed-in ${nameOf(s.adapterId)} session`,
        details: [
          `For up to ${s.minutes} minutes, on ${s.origins.join(', ')}.`,
          `To build or repair draft ${s.draftId}. It drives Valet’s browser; it never sees your password or cookies.`,
        ],
        choices: null,
      }
    }
    case 'browser-grant': {
      const s = request.subject
      return {
        ...base,
        requestKind: 'browser-grant',
        adapterId: s.adapterId,
        title: `Let the agent browse ${nameOf(s.adapterId)} signed in, read only`,
        details: [
          `Its reason: “${s.purpose}”`,
          `For up to ${s.minutes} minutes, on ${s.origins.join(', ')}. Only page loads and reads reach the site.`,
          'It never sees your password or session. Payment, password and security pages close on sight. You can end it any time.',
        ],
        choices: null,
      }
    }
    case 'private-network': {
      const s = request.subject
      return {
        ...base,
        requestKind: 'private-network',
        adapterId: s.adapterId,
        title: 'Let the agent’s scratch browser reach your home network',
        details: [
          `Only ${s.address}${s.port === null ? '' : ` port ${s.port}`}, for up to ${s.minutes} minutes.`,
          `For draft ${s.draftId}.`,
        ],
        choices: null,
      }
    }
    case 'tool-enable': {
      const s = request.subject
      return {
        ...base,
        requestKind: 'tool-enable',
        adapterId: s.adapterId,
        title: `Turn on ${s.adapterId}.${s.tool}${s.scope === 'remote' ? ' for this cloud agent' : ''}`,
        details: [
          s.sideEffect === 'read'
            ? 'It only reads.'
            : s.sideEffect === 'write'
              ? 'It changes things on the site.'
              : 'It does something that can’t be undone; each call still asks you.',
        ],
        choices: null,
      }
    }
    case 'secret-grant': {
      const s = request.subject
      return {
        ...base,
        requestKind: 'secret-grant',
        adapterId: s.adapterId,
        title: `Let ${nameOf(s.adapterId)} use your login`,
        details: [
          `The 1Password item “${s.itemTitle}” (${s.fields.join(', ')}), typed only into ${s.origins.join(', ')}.`,
        ],
        choices: null,
      }
    }
    default:
      return null
  }
}
