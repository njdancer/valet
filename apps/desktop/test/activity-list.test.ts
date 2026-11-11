import { describe, expect, it } from 'vitest'
import { foldRetries } from '../src/renderer/screens/Activity'
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
    expect(foldRetries(list).map((l) => [l.run.callId, l.retries])).toEqual([
      ['ok', 2],
      ['before', 0],
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
