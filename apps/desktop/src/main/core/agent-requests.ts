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
  'agent-access',
])

const ACCESS_APP_NAMES = { mail: 'Mail', calendar: 'Calendar', reminders: 'Reminders' } as const
/** What each level gives, by app, as the access card words it. */
const ACCESS_LEVEL_WORDS = {
  mail: { read: 'search and read it', edit: 'read it, draft, move and mark (never send)' },
  calendar: {
    read: 'see its events',
    edit: 'see, add, change and delete its events (and, with Full access, delete the calendar itself)',
  },
  reminders: {
    read: 'see its reminders',
    edit: 'see, add, change and complete its reminders (and, with Full access, delete the list itself)',
  },
} as const
/** What a tool's side effect means, as a tool line's clause. */
const TOOL_EFFECT_WORDS = {
  read: 'only reads',
  write: 'changes things on the site',
  irreversible: 'does something that can’t be undone, and each call still asks you',
} as const

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
    case 'agent-access': {
      const s = request.subject
      // Ask for changes brings See Valet: one line for Valet itself.
      const n = s.items.length + s.full.length + s.tools.length + (s.capabilities.length > 0 ? 1 : 0)
      return {
        ...base,
        requestKind: 'agent-access',
        adapterId: null,
        title: n === 1 ? `Give ${base.agentName} more access` : `Give ${base.agentName} ${n} more things`,
        // The names are the Mac's own (an account, a calendar, a site's tool), never the agent's words.
        details: [
          ...s.items.map(
            (i) =>
              `${ACCESS_APP_NAMES[i.app]}, “${i.label}”: ${i.level === 'edit' ? 'Edit' : 'Read'}, to ${ACCESS_LEVEL_WORDS[i.app][i.level]}.`,
          ),
          ...s.full.map(
            (app) =>
              `${ACCESS_APP_NAMES[app]}: Full access, to add ${app === 'calendar' ? 'calendars' : 'lists'} and delete any it may edit, with everything in them.`,
          ),
          ...s.tools.map((t) => `The tool “${t.label}”, which ${TOOL_EFFECT_WORDS[t.sideEffect]}.`),
          ...(s.capabilities.includes('ask-for-changes')
            ? ['Ask for changes: build and repair adapters, and ask you for access, settings and logins.']
            : s.capabilities.includes('see-valet')
              ? ['See Valet: its status, its sites and their health, and its own calls.']
              : []),
        ],
        choices: null,
      }
    }
    default:
      return null
  }
}
