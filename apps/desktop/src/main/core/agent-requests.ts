// An agent's request, as the Mac's Needs you shows it (docs/approval-broker.md, "Approving at the
// Mac"). The phone renders the same request from its signed text; this is the Mac's reading of it.
//
// Only the kinds no other item shows are here. Installs and updates are review items, a pairing
// and a resume are the person's own, and an irreversible call has its own confirmation panel.
// Every line is built from the request's subject. Text an adapter or agent wrote (a setting's
// label, the agent's note) is quoted or kept apart, never the headline's verb.

import type { SerializedRequest } from '@valet/core'
import type { AgentRequestItem } from '../../shared/api'
import { requestRef } from './approvals/prompts'

type CardKind = AgentRequestItem['requestKind']
const CARD_KINDS: ReadonlySet<string> = new Set<CardKind>([
  'setting',
  'authoring-session',
  'private-network',
  'tool-enable',
  'secret-grant',
])

/** The Needs you item for a waiting request, or null for one another item shows (or the person's own). */
export function agentRequestItem(serialized: SerializedRequest): AgentRequestItem | null {
  const request = serialized.request
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
          s.scope === 'valet' ? 'A Valet setting.' : `A setting of the ${s.adapterId ?? 'site'} adapter.`,
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
        title: `Lend the agent your signed-in ${s.adapterId} session`,
        details: [
          `For up to ${s.minutes} minutes, on ${s.origins.join(', ')}.`,
          `To build or repair draft ${s.draftId}. It drives Valet’s browser; it never sees your password or cookies.`,
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
        title: `Let ${s.adapterId} use your login`,
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
