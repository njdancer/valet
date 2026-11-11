import { describe, expect, it } from 'vitest'
import { NO_CALL_FILTERS } from '../src/renderer/lib/routes'
import { eventWords } from '../src/renderer/screens/activity/audit-events'
import {
  describeFilters,
  foldRetries,
  matchesFilters,
  matchesOutcome,
  parseLogin,
} from '../src/renderer/screens/activity/calls-list'
import { outcomeWords, redactionLabel } from '../src/renderer/screens/activity/shared'
import type { RunSummary } from '../src/shared/api'

const T0 = Date.parse('2026-11-11T10:00:00Z')

function run(callId: string, minutes: number, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    callId,
    adapterId: 'woolworths',
    adapterName: 'Woolworths',
    tool: 'get_cart',
    sideEffect: 'read',
    client: 'claude-code',
    startedAt: new Date(T0 + minutes * 60_000).toISOString(),
    durationMs: 100,
    outcome: 'ok',
    needsUser: null,
    stage: null,
    errorClass: null,
    blockedRequests: 0,
    detail: null,
    ...extra,
  }
}

const retry = { outcome: 'failed', errorClass: 'login-in-progress' } as const

describe('folding retries into the call that followed (F12)', () => {
  it('folds a chain of retry answers into the call that ended it', () => {
    const list = [run('ok', 3), run('r2', 2, retry), run('r1', 1, retry), run('before', 0)]
    expect(foldRetries(list).map((l) => [l.run.callId, l.retries, l.firstRetry])).toEqual([
      ['ok', 2, 'r1'],
      ['before', 0, null],
    ])
  })

  it('keeps a retry on its own when no call followed from the same client to the same tool soon after', () => {
    const list = [
      run('later', 20),
      run('other-tool', 2, { tool: 'search_products' }),
      run('other-client', 1, { client: 'claude-ai' }),
      run('r', 0, retry),
    ]
    expect(foldRetries(list).map((l) => [l.run.callId, l.retries])).toEqual([
      ['later', 0],
      ['other-tool', 0],
      ['other-client', 0],
      ['r', 0],
    ])
  })

  it('leaves real failures alone', () => {
    const list = [run('ok', 1), run('failed', 0, { outcome: 'failed', errorClass: 'blocked-by-site' })]
    expect(foldRetries(list)).toHaveLength(2)
  })
})

describe('the Calls filters', () => {
  it('keeps calls by site, tool, app and outcome', () => {
    const r = run('a', 0)
    expect(matchesFilters(r, NO_CALL_FILTERS, null)).toBe(true)
    expect(matchesFilters(r, { ...NO_CALL_FILTERS, site: 'coles' }, null)).toBe(false)
    expect(matchesFilters(r, { ...NO_CALL_FILTERS, tool: 'get_cart' }, null)).toBe(true)
    expect(matchesFilters(r, { ...NO_CALL_FILTERS, tool: 'add_to_cart' }, null)).toBe(false)
    expect(matchesFilters(r, { ...NO_CALL_FILTERS, client: 'claude-ai' }, null)).toBe(false)
    expect(matchesFilters(r, { ...NO_CALL_FILTERS, outcome: 'failed' }, null)).toBe(false)
  })

  it('keeps only the calls that used a login, and none until that is known', () => {
    const filters = { ...NO_CALL_FILTERS, login: 'woolworths/login' }
    expect(matchesFilters(run('a', 0), filters, null)).toBe(false)
    expect(matchesFilters(run('a', 0), filters, new Set(['a']))).toBe(true)
    expect(matchesFilters(run('b', 0), filters, new Set(['a']))).toBe(false)
  })

  it('tells outcomes apart, with a retry answer not counted as a failure', () => {
    expect(matchesOutcome(run('a', 0), 'ok')).toBe(true)
    expect(matchesOutcome(run('a', 0, retry), 'failed')).toBe(false)
    expect(matchesOutcome(run('a', 0, { outcome: 'failed', errorClass: 'site-changed' }), 'failed')).toBe(
      true,
    )
    expect(matchesOutcome(run('a', 0, { outcome: 'blocked' }), 'blocked')).toBe(true)
    expect(matchesOutcome(run('a', 0, { outcome: 'needsUser' }), 'needs-you')).toBe(true)
    expect(matchesOutcome(run('a', 0, { outcome: 'declined' }), 'declined')).toBe(true)
    expect(matchesOutcome(run('a', 0, { outcome: 'running' }), 'running')).toBe(true)
  })

  it('reads a login filter and refuses a malformed one', () => {
    expect(parseLogin('woolworths/login')).toEqual({ site: 'woolworths', secret: 'login' })
    expect(parseLogin('woolworths')).toBeNull()
    expect(parseLogin('/login')).toBeNull()
    expect(parseLogin('woolworths/')).toBeNull()
  })

  it('says the filters as a phrase for an empty result', () => {
    const name = (id: string) => (id === 'woolworths' ? 'Woolworths' : id)
    expect(describeFilters(NO_CALL_FILTERS, name)).toBe('calls')
    expect(describeFilters({ ...NO_CALL_FILTERS, site: 'woolworths', outcome: 'failed' }, name)).toBe(
      'failed Woolworths calls',
    )
    expect(describeFilters({ ...NO_CALL_FILTERS, tool: 'get_cart' }, name)).toBe('get_cart calls')
  })
})

describe('a call’s outcome in words', () => {
  it('says what happened, never only a colour', () => {
    expect(outcomeWords(run('a', 0))).toEqual({ text: 'Ok', tone: 'success' })
    expect(outcomeWords(run('a', 0, { blockedRequests: 2 }))).toEqual({ text: 'Ok, 2 blocked', tone: 'info' })
    expect(outcomeWords(run('a', 0, { outcome: 'needsUser', needsUser: 'captcha' }))).toEqual({
      text: 'Needs you · Verification check',
      tone: 'warning',
    })
    expect(outcomeWords(run('a', 0, retry))).toEqual({ text: 'Call again', tone: 'info' })
    expect(outcomeWords(run('a', 0, { outcome: 'failed' }))).toEqual({ text: 'Failed', tone: 'danger' })
    expect(outcomeWords(run('a', 0, { outcome: 'declined' }))).toEqual({ text: 'Declined', tone: 'neutral' })
    expect(outcomeWords(run('a', 0, { outcome: 'running' }))).toEqual({ text: 'Running', tone: 'accent' })
  })

  it('labels redactions by kind, and an unknown kind as redacted', () => {
    expect(redactionLabel({ kind: 'redacted', label: 'secret', ref: 'login.username' })).toBe(
      '[secret:login.username]',
    )
    expect(redactionLabel({ kind: 'redacted', label: 'session-cookie', ref: null })).toBe('[session cookie]')
    expect(redactionLabel({ kind: 'redacted', label: 'other' as 'secret', ref: null })).toBe('[redacted]')
  })
})

describe('audit event words', () => {
  it('names a resume as a resume, though one event type records both', () => {
    expect(eventWords({ type: 'site-paused', adapterId: 'woolworths', paused: true }).label).toBe(
      'Site paused',
    )
    expect(eventWords({ type: 'site-paused', adapterId: 'woolworths', paused: false }).label).toBe(
      'Site resumed',
    )
  })
})
