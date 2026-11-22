// What the phone's Agents and Activity tabs show: the
// agents that can reach this Mac and the last things that happened, built from the Mac's own
// records. Everything here goes to the phone as display text, so each value is flattened and cut
// to the protocol's limits, and anything that still isn't display text is left out rather than
// sent, since the phone refuses a whole status with one bad field.

import { type AuditEvent, type AuditRecord, isDisplayText, type MacToPhoneMessage } from '@valet/core'

type PhoneStatus = Extract<MacToPhoneMessage, { type: 'status' }>
export type PhoneAgent = PhoneStatus['agents'][number]
export type PhoneRecent = PhoneStatus['recent'][number]

/** At most this many of each list: the protocol's cap. */
export const PHONE_LIST_MAX = 50

/** A value as the phone shows it: one line, printable, at most `max` long; undefined if nothing is left. */
export function phoneText(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\p{Zs}+/gu, ' ')
    .trim()
  const cut = [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat
  return cut !== '' && isDisplayText(cut) ? cut : undefined
}

export interface LocalAgent {
  readonly id: string
  readonly name: string
  readonly revokedAt: string | null
}

export interface RemoteAgent {
  readonly id: string
  readonly host: string
  readonly clientName: string | null
}

/**
 * The agents that can call this Mac: each app added here that isn't revoked, and each remote
 * connector kept (claude.ai and the like), the most recently used first.
 */
export function phoneAgents(
  local: readonly LocalAgent[],
  remote: readonly RemoteAgent[],
  records: readonly AuditRecord[],
): PhoneAgent[] {
  const lastCall = new Map<string, string>()
  for (const r of records)
    if (r.event.type === 'tool-called' && r.event.clientId !== undefined) lastCall.set(r.event.clientId, r.at)
  const agents: PhoneAgent[] = []
  for (const c of local) {
    if (c.revokedAt !== null) continue
    const clientId = `local:${c.id}`
    const label = phoneText(c.name, 100)
    if (label === undefined || !/^local:[A-Za-z0-9_-]{1,64}$/.test(clientId)) continue
    agents.push({ clientId, label, transport: 'local', lastCallAt: iso(lastCall.get(clientId)) })
  }
  for (const c of remote) {
    const clientId = `remote:${c.id}`
    // The host is the claimed identity the Mac shows first; the self-chosen name only after it.
    const name = phoneText(c.clientName, 40)
    const label = phoneText(name === undefined || name === c.host ? c.host : `${c.host} (${name})`, 100)
    if (label === undefined || !/^remote:[A-Za-z0-9_-]{1,64}$/.test(clientId)) continue
    agents.push({ clientId, label, transport: 'remote', lastCallAt: iso(lastCall.get(clientId)) })
  }
  return agents
    .sort((a, b) => (b.lastCallAt ?? '').localeCompare(a.lastCallAt ?? ''))
    .slice(0, PHONE_LIST_MAX)
}

/**
 * The last things that happened, newest first: each tool call, and each change the person would
 * want to hear about (a site installed, removed or paused, an agent connected or cut off).
 */
export function phoneRecent(
  records: readonly AuditRecord[],
  siteName: (adapterId: string) => string | undefined,
): PhoneRecent[] {
  const recent: PhoneRecent[] = []
  for (let i = records.length - 1; i >= 0 && recent.length < PHONE_LIST_MAX; i -= 1) {
    const record = records[i] as AuditRecord
    const at = iso(record.at)
    if (at === null) continue
    const line = lineFor(record.event, siteName)
    if (line === null) continue
    const text = phoneText(line.text, 200)
    if (text !== undefined) recent.push({ at, kind: line.kind, text })
  }
  return recent
}

function lineFor(
  event: AuditEvent,
  siteName: (adapterId: string) => string | undefined,
): { kind: 'call' | 'change'; text: string } | null {
  const site = (id: string) => siteName(id) ?? id
  switch (event.type) {
    case 'tool-called': {
      const agent = phoneText(event.client, 60)
      return {
        kind: 'call',
        text: `${agent ?? 'An agent'} used ${event.tool.replaceAll('_', ' ')} on ${site(event.adapterId)}`,
      }
    }
    case 'adapter-installed':
      return {
        kind: 'change',
        text: `${site(event.adapterId)} ${event.previousHash === null ? 'added' : 'updated'}`,
      }
    case 'adapter-approved':
      return { kind: 'change', text: `${site(event.adapterId)} approved` }
    case 'adapter-removed':
      return { kind: 'change', text: `${site(event.adapterId)} removed` }
    case 'site-paused':
      return { kind: 'change', text: `${site(event.adapterId)} ${event.paused ? 'paused' : 'resumed'}` }
    case 'remote-consent':
      return event.answer === 'approved' ? { kind: 'change', text: `${event.clientHost} connected` } : null
    case 'remote-revoked':
      return {
        kind: 'change',
        text: event.clientId === null ? 'Every remote agent cut off' : 'A remote agent cut off',
      }
    case 'client-added':
      return { kind: 'change', text: 'An app added' }
    case 'client-revoked':
      return { kind: 'change', text: 'An app revoked' }
    case 'lock-down':
      return { kind: 'change', text: event.locked ? 'Valet locked down' : 'Lockdown lifted' }
    default:
      return null
  }
}

function iso(at: string | undefined): string | null {
  if (at === undefined) return null
  const time = Date.parse(at)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}
