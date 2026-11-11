// @vitest-environment node
// The order Needs you lists items in, the missed items' 24 hours, and the kill switches' file.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppStateStore } from '../../src/main/core/app-state'
import { attentionDeadline, MissedItems, sortAttention } from '../../src/main/core/attention'
import { RuntimeToolCaller } from '../../src/main/core/caller'
import type { AttentionItem } from '../../src/shared/api'

const T = (minute: number) => new Date(Date.UTC(2026, 10, 7, 10, minute)).toISOString()

const confirmation = {
  kind: 'confirmation',
  id: 'cf_1',
  requestedAt: T(48),
  expiresAt: T(50),
} as unknown as AttentionItem
const consent: AttentionItem = {
  kind: 'remote-consent',
  id: 'cs_1',
  clientHost: 'claude.ai',
  clientName: 'Claude (claude.ai)',
  source: '203.0.113.24',
  requestedAt: T(47),
  expiresAt: T(52),
}
const login = { kind: 'needs-user', id: 'nu_w', at: T(47), closesAt: T(62) } as unknown as AttentionItem
const openEnded = { kind: 'needs-user', id: 'nu_x', at: T(1), closesAt: null } as unknown as AttentionItem
const review: AttentionItem = {
  kind: 'review',
  id: 'rv_w',
  adapterId: 'w',
  adapterName: 'Woolworths',
  version: '0.4.0',
  addsPermissions: true,
}
const repair: AttentionItem = {
  kind: 'repair',
  id: 'rp_w',
  adapterId: 'w',
  adapterName: 'Woolworths',
  callId: '6b3e',
  errorClass: 'site-changed',
  at: T(5),
}
const missingLogin: AttentionItem = {
  kind: 'login-missing',
  id: 'lm_w_login',
  adapterId: 'w',
  adapterName: 'Woolworths',
  secret: 'login',
}

describe('sortAttention', () => {
  it('lists the soonest deadline first, then the rest oldest first (IA section 5)', () => {
    expect(
      sortAttention([missingLogin, review, repair, login, consent, openEnded, confirmation]).map((i) => i.id),
    ).toEqual(['cf_1', 'cs_1', 'nu_w', 'nu_x', 'rp_w', 'rv_w', 'lm_w_login'])
  })

  it('keeps a confirmation ahead of anything ending at the same moment', () => {
    const sameEnd = { ...consent, expiresAt: T(50) }
    expect(sortAttention([sameEnd, confirmation]).map((i) => i.id)).toEqual(['cf_1', 'cs_1'])
    expect(sortAttention([confirmation, { ...confirmation, id: 'cf_2' }]).map((i) => i.id)).toEqual([
      'cf_1',
      'cf_2',
    ])
  })

  it('gives a missed item its 24 hours as a deadline', () => {
    const missed = { kind: 'missed', id: 'ms', at: T(0), missedAt: T(2) } as unknown as AttentionItem
    expect(attentionDeadline(missed)).toBe(Date.parse(T(2)) + 24 * 60 * 60_000)
    expect(attentionDeadline(review)).toBeNull()
  })
})

describe('MissedItems', () => {
  it('keeps items for 24 hours, survives a reload, and dismisses by id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-missed-'))
    let now = Date.parse(T(12))
    let changes = 0
    const options = { path: join(dir, 'missed.json'), now: () => now, changed: () => changes++ }
    const missed = new MissedItems(options)
    await missed.load()
    expect(missed.nextExpiry()).toBeNull()
    const item = missed.add({
      of: 'confirmation',
      id: 'cf_1',
      title: 'Confirm: Remove from cart (Woolworths)',
      adapterId: 'woolworths',
      adapterName: 'Woolworths',
      callId: '5c10',
      at: T(10),
    })
    expect(item.title).toBe('Missed: Confirm: Remove from cart (Woolworths)')
    expect(changes).toBe(1)
    await missed.flushed()
    const reloaded = new MissedItems(options)
    await reloaded.load()
    expect(reloaded.list()).toEqual([item])
    expect(reloaded.dismiss('nope')).toBe(false)
    now += 24 * 60 * 60_000
    expect(reloaded.list()).toEqual([])
    expect(missed.dismiss(item.id)).toBe(true)
    await missed.flushed()
    expect(JSON.parse(readFileSync(options.path, 'utf8'))).toEqual([])
    // A damaged file reads as none.
    writeFileSync(options.path, '{')
    const damaged = new MissedItems(options)
    await damaged.load()
    expect(damaged.list()).toEqual([])
  })
})

describe('AppStateStore', () => {
  it('starts unlocked with nothing paused, and keeps what it is told', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sa-state-')), 'app-state.json')
    const store = new AppStateStore(path)
    await store.load()
    expect(store.lockedDown).toBe(false)
    await store.setSitePaused('woolworths', true)
    await store.setSitePaused('wikipedia', true)
    await store.setSitePaused('wikipedia', false)
    await store.setLockedDown(true)
    const again = new AppStateStore(path)
    await again.load()
    expect(again.lockedDown).toBe(true)
    expect(again.sitePaused('woolworths')).toBe(true)
    expect(again.sitePaused('wikipedia')).toBe(false)
  })
})

describe('the caller’s own refusals', () => {
  it('puts lock down before pause, and pause before one site', async () => {
    const refused: string[] = []
    const state = { locked: true, paused: true, site: true }
    const caller = new RuntimeToolCaller(
      {
        listTools: async () => [],
        call: async () => ({ status: 'declined', timedOut: true }),
      },
      {
        paused: () => state.paused,
        lockedDown: () => state.locked,
        sitePaused: () => state.site,
        started: () => {},
        finished: () => {},
        refused: async (_call, refusal) => {
          refused.push(refusal.errorClass)
        },
        explain: () => {
          throw new Error('explain broke')
        },
      },
    )
    const call = { adapterId: 'w', tool: 't', input: {}, client: 'c', callId: 'call_1' }
    await caller.call(call)
    state.locked = false
    await caller.call(call)
    state.paused = false
    await caller.call(call)
    expect(refused).toEqual(['locked-down', 'unavailable', 'site-paused'])
    state.site = false
    // An explanation that throws leaves the outcome as it was.
    expect(await caller.call(call)).toEqual({ status: 'declined', timedOut: true })
  })
})
