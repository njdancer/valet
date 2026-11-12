// Repair tickets from the audit log (src/main/core/drafts/repairs.ts).

import type { AuditEvent } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { REPAIR_ID, RepairTickets, repairIdFor } from '../../src/main/core/drafts/repairs'

let n = 0
function call(
  tickets: RepairTickets,
  outcome: 'ok' | 'failed' | 'needsUser',
  options: { tool?: string; hash?: string; stage?: string; errorClass?: string; at?: string } = {},
): boolean {
  const callId = `call-${++n}`
  const at = options.at ?? new Date(Date.UTC(2026, 10, 12, 10, n)).toISOString()
  tickets.note(
    {
      type: 'tool-called',
      adapterId: 'shop',
      adapterHash: options.hash ?? 'a'.repeat(64),
      tool: options.tool ?? 'get_item',
      client: 'Claude',
      callId,
    } as AuditEvent,
    at,
  )
  return tickets.note(
    {
      type: 'tool-finished',
      adapterId: 'shop',
      callId,
      outcome,
      ...(outcome === 'failed'
        ? { stage: options.stage ?? 'tool-output', errorClass: options.errorClass ?? 'invalid' }
        : {}),
      durationMs: 10,
    } as AuditEvent,
    at,
  )
}

describe('repair tickets', () => {
  it('opens one on the second failure in a row of a kind only a new version fixes', () => {
    const tickets = new RepairTickets(() => Date.UTC(2026, 10, 12, 12))
    expect(call(tickets, 'failed')).toBe(false)
    expect(tickets.list()).toEqual([])
    expect(call(tickets, 'failed')).toBe(true)
    const [ticket] = tickets.list()
    expect(ticket).toMatchObject({
      adapterId: 'shop',
      tool: 'get_item',
      stage: 'tool-output',
      errorClass: 'invalid',
      failures: 2,
      state: 'open',
    })
    expect(ticket?.id).toMatch(REPAIR_ID)
    expect(tickets.openForAdapter('shop')?.id).toBe(ticket?.id)
    // A third failure is the same ticket.
    call(tickets, 'failed')
    expect(tickets.list()).toHaveLength(1)
    expect(tickets.list()[0]?.failures).toBe(3)
  })

  it('ignores trouble a new version wouldn’t fix, and needs the same failure twice', () => {
    const tickets = new RepairTickets()
    call(tickets, 'failed', { stage: 'egress', errorClass: 'rate-limited' })
    call(tickets, 'failed', { stage: 'egress', errorClass: 'rate-limited' })
    call(tickets, 'failed', { stage: 'navigate', errorClass: 'blocked-by-site' })
    call(tickets, 'failed', { stage: 'navigate', errorClass: 'blocked-by-site' })
    call(tickets, 'failed', { stage: 'tool-output', errorClass: 'invalid' })
    call(tickets, 'failed', { stage: 'tool-run', errorClass: 'element-missing' })
    call(tickets, 'failed', { stage: 'tool-output', errorClass: 'invalid', tool: 'other_tool' })
    expect(tickets.list()).toEqual([])
  })

  it('closes when the tool works again, and a good call between failures resets the count', () => {
    const tickets = new RepairTickets(() => Date.UTC(2026, 10, 12, 12))
    call(tickets, 'failed')
    call(tickets, 'ok')
    call(tickets, 'failed')
    expect(tickets.list()).toEqual([])
    call(tickets, 'failed')
    expect(tickets.list()[0]?.state).toBe('open')
    // needs-you outcomes say nothing about the code either way.
    call(tickets, 'needsUser')
    expect(tickets.list()[0]?.state).toBe('open')
    expect(call(tickets, 'ok', { hash: 'b'.repeat(64) })).toBe(true)
    expect(tickets.list()[0]).toMatchObject({ state: 'fixed' })
    expect(tickets.openForAdapter('shop')).toBeNull()
  })

  it('derives the same id from the same call, so a relaunch rebuilding from the log keeps it', () => {
    expect(repairIdFor('call-x')).toBe(repairIdFor('call-x'))
    expect(repairIdFor('call-x')).toMatch(REPAIR_ID)
  })
})
