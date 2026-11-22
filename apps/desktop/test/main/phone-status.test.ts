// What the phone's Agents and Activity tabs show, from the Mac's records (phone-status.ts). Every
// value must pass the protocol's own schema, or the phone refuses the whole status.

import { type AuditEvent, type AuditRecord, macToPhoneMessageSchema } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { PHONE_LIST_MAX, phoneAgents, phoneRecent, phoneText } from '../../src/main/core/phone-status'

let seq = 0
const record = (at: string, event: AuditEvent): AuditRecord => ({ seq: ++seq, at, event }) as AuditRecord
const called = (at: string, clientId: string, tool = 'get_quote', adapterId = 'yahoo-finance') =>
  record(at, {
    type: 'tool-called',
    adapterId,
    adapterHash: 'a'.repeat(64),
    tool,
    client: 'Claude-User',
    clientId,
    callId: `c${seq}`,
  })

function parses(agents: unknown, recent: unknown): boolean {
  return macToPhoneMessageSchema.safeParse({
    type: 'status',
    seq: 1,
    at: '2026-11-22T11:00:00.000Z',
    safety: 'running',
    sites: [],
    agents,
    devices: [],
    recent,
  }).success
}

describe('the phone’s Agents tab', () => {
  it('lists local apps and remote connectors, most recently used first, and leaves out revoked apps', () => {
    const records = [
      called('2026-11-22T10:00:00.000Z', 'remote:r_claude'),
      called('2026-11-22T10:05:00.000Z', 'local:c_code'),
    ]
    const agents = phoneAgents(
      [
        { id: 'c_code', name: 'Claude Code', revokedAt: null },
        { id: 'c_old', name: 'Old app', revokedAt: '2026-11-01T00:00:00.000Z' },
      ],
      [
        { id: 'r_claude', host: 'claude.ai', clientName: 'Claude' },
        { id: 'r_idle', host: 'chatgpt.com', clientName: null },
      ],
      records,
    )
    expect(agents).toEqual([
      {
        clientId: 'local:c_code',
        label: 'Claude Code',
        transport: 'local',
        lastCallAt: '2026-11-22T10:05:00.000Z',
      },
      {
        clientId: 'remote:r_claude',
        label: 'claude.ai (Claude)',
        transport: 'remote',
        lastCallAt: '2026-11-22T10:00:00.000Z',
      },
      { clientId: 'remote:r_idle', label: 'chatgpt.com', transport: 'remote', lastCallAt: null },
    ])
    expect(parses(agents, [])).toBe(true)
  })

  it('cleans names an agent chose so the phone never refuses the status, and caps the list', () => {
    const remote = Array.from({ length: 70 }, (_, i) => ({
      id: `r_${i}`,
      host: 'evil.example',
      clientName: `bad‮name\u0000${'x'.repeat(200)}`,
    }))
    const agents = phoneAgents([{ id: 'c_x', name: '​', revokedAt: null }], remote, [])
    expect(agents).toHaveLength(PHONE_LIST_MAX)
    expect(agents.every((a) => a.label.length <= 100)).toBe(true)
    expect(parses(agents, [])).toBe(true)
  })
})

describe('the phone’s Activity tab', () => {
  it('says what happened, newest first, with site names, and skips what the person needn’t hear', () => {
    const records = [
      record('2026-11-22T09:00:00.000Z', {
        type: 'adapter-installed',
        adapterId: 'wikipedia',
        adapterHash: 'b'.repeat(64),
        version: '1',
        source: 'builtin',
        previousHash: null,
        appVersion: '0.1.0',
        preludeHash: 'c'.repeat(64),
        compiler: 'x',
      }),
      record('2026-11-22T09:01:00.000Z', {
        type: 'remote-consent',
        clientId: 'remote:r_claude',
        clientHost: 'claude.ai',
        source: null,
        tools: [],
        answer: 'approved',
      }),
      record('2026-11-22T09:02:00.000Z', {
        type: 'remote-consent',
        clientId: 'remote:r_x',
        clientHost: 'x.example',
        source: null,
        tools: [],
        answer: 'declined',
      }),
      called('2026-11-22T09:03:00.000Z', 'remote:r_claude'),
      record('2026-11-22T09:04:00.000Z', { type: 'site-paused', adapterId: 'wikipedia', paused: true }),
      record('2026-11-22T09:05:00.000Z', {
        type: 'grant-copied',
        adapterId: 'wikipedia',
        secret: 's',
        fields: [],
      }),
    ]
    const names: Record<string, string> = { wikipedia: 'Wikipedia', 'yahoo-finance': 'Yahoo Finance' }
    const recent = phoneRecent(records, (id) => names[id])
    expect(recent).toEqual([
      { at: '2026-11-22T09:04:00.000Z', kind: 'change', text: 'Wikipedia paused' },
      { at: '2026-11-22T09:03:00.000Z', kind: 'call', text: 'Claude-User used get quote on Yahoo Finance' },
      { at: '2026-11-22T09:01:00.000Z', kind: 'change', text: 'claude.ai connected' },
      { at: '2026-11-22T09:00:00.000Z', kind: 'change', text: 'Wikipedia added' },
    ])
    expect(parses([], recent)).toBe(true)
  })

  it('keeps only the last fifty, and a client name full of control characters still parses', () => {
    const records = Array.from({ length: 120 }, (_, i) =>
      record(new Date(Date.UTC(2026, 10, 22, 0, i)).toISOString(), {
        type: 'tool-called',
        adapterId: 'wikipedia',
        adapterHash: 'a'.repeat(64),
        tool: 'search',
        client: `\u0007‮${'y'.repeat(300)}`,
        clientId: 'remote:r',
        callId: `k${i}`,
      }),
    )
    const recent = phoneRecent(records, () => undefined)
    expect(recent).toHaveLength(PHONE_LIST_MAX)
    expect(recent[0]?.at).toBe(new Date(Date.UTC(2026, 10, 22, 1, 59)).toISOString())
    expect(parses([], recent)).toBe(true)
  })
})

describe('phoneText', () => {
  it('flattens to one printable line, cuts to the limit, and gives up on nothing visible', () => {
    expect(phoneText('a\nb\tc', 10)).toBe('a b c')
    expect(phoneText('abcdefghij', 5)).toBe('abcd…')
    expect(phoneText('​​', 10)).toBeUndefined()
    expect(phoneText(null, 10)).toBeUndefined()
  })
})
