// @vitest-environment node
// The ToolCaller seam, the preload's API object, run previews and the audit views.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditEvent, AuditRecord } from '@siteadapter/core'
import { AuditLog, REDACTED } from '@siteadapter/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AdapterLookup,
  AuditReader,
  auditPage,
  callCounts,
  runSummaries,
  runTrace,
  statsToday,
} from '../../src/main/core/audit-view'
import {
  type AppRefusal,
  outcomeOf,
  PAUSED_REFUSAL,
  REVOKED_REFUSAL,
  RuntimeToolCaller,
} from '../../src/main/core/caller'
import { INVOKE_METHODS, invokeChannel } from '../../src/main/core/channels'
import { previewParts, RunMemory } from '../../src/main/core/run-memory'
import { buildApi, eventFrom, type IpcLike } from '../../src/preload/api'

describe('RuntimeToolCaller', () => {
  function host() {
    const calls: unknown[] = []
    return {
      calls,
      host: {
        listTools: async () => [
          {
            adapterId: 'shop',
            adapterName: 'Shop',
            adapterHash: 'a'.repeat(64),
            declaration: { name: 'echo', title: 'Echo', description: 'd', sideEffect: 'read' as const },
            input: {} as never,
            output: {} as never,
          },
        ],
        call: async (request: unknown) => {
          calls.push(request)
          return { status: 'ok' as const, output: { text: 'hi' } }
        },
      },
    }
  }
  const call = { adapterId: 'shop', tool: 'echo', input: { text: 'hi' }, client: 'Claude Code', callId: 'c1' }

  it('lists from a cached copy, without the hash, refreshed on demand', async () => {
    const h = host()
    const caller = new RuntimeToolCaller(h.host, {
      paused: () => false,
      revoked: () => false,
      started: () => {},
      finished: () => {},
      refused: async () => {},
      enter: async () => () => {},
    })
    expect(caller.listTools()).toEqual([])
    await caller.refresh()
    expect(caller.listTools().map((t) => t.declaration.name)).toEqual(['echo'])
    expect(Object.keys(caller.listTools()[0] ?? {})).not.toContain('adapterHash')
  })

  it('runs a call through the runtime, telling the app before and after', async () => {
    const h = host()
    const seen: string[] = []
    const caller = new RuntimeToolCaller(h.host, {
      paused: () => false,
      revoked: () => false,
      started: (c) => seen.push(`started ${c.callId}`),
      finished: (c, r) => seen.push(`finished ${c.callId} ${r.status}`),
      refused: async () => {
        seen.push('refused')
      },
      enter: async (adapterId) => {
        seen.push(`enter ${adapterId}`)
        return () => seen.push(`leave ${adapterId}`)
      },
    })
    expect(await caller.call({ ...call, signal: new AbortController().signal })).toEqual({
      status: 'ok',
      output: { text: 'hi' },
    })
    expect(h.calls).toEqual([call])
    expect(seen).toEqual(['enter shop', 'started c1', 'finished c1 ok', 'leave shop'])
  })

  it('refuses while paused and for a revoked client name, before the runtime sees the call', async () => {
    const h = host()
    const refused: [string, AppRefusal][] = []
    const entered: string[] = []
    const hooks = {
      started: () => {},
      finished: () => {},
      refused: async (c: { callId: string }, r: AppRefusal) => {
        refused.push([c.callId, r])
      },
      enter: async (adapterId: string) => {
        entered.push(adapterId)
        return () => {}
      },
    }
    const paused = new RuntimeToolCaller(h.host, { ...hooks, paused: () => true, revoked: () => false })
    // Not a rate limit: the site isn't involved, and the class says the app refused.
    expect(await paused.call(call)).toEqual({ status: 'failed', stage: 'config', errorClass: 'unavailable' })
    const revoked = new RuntimeToolCaller(h.host, {
      ...hooks,
      paused: () => false,
      revoked: (c) => c === 'Claude Code',
    })
    expect(await revoked.call(call)).toEqual({ status: 'failed', stage: 'config', errorClass: 'not-granted' })
    expect(h.calls).toEqual([])
    expect(entered).toEqual([])
    expect(refused).toEqual([
      ['c1', PAUSED_REFUSAL],
      ['c1', REVOKED_REFUSAL],
    ])
  })

  it('still refuses when the refusal can’t be audited', async () => {
    const h = host()
    const caller = new RuntimeToolCaller(h.host, {
      paused: () => true,
      revoked: () => false,
      started: () => {},
      finished: () => {},
      refused: async () => {
        throw new Error('disk full')
      },
      enter: async () => () => {},
    })
    expect(await caller.call(call)).toEqual(outcomeOf(PAUSED_REFUSAL))
    expect(h.calls).toEqual([])
  })

  it('leaves the gate even when the runtime throws', async () => {
    const left: string[] = []
    const caller = new RuntimeToolCaller(
      {
        listTools: async () => [],
        call: async () => {
          throw new Error('boom')
        },
      },
      {
        paused: () => false,
        revoked: () => false,
        started: () => {},
        finished: () => {},
        refused: async () => {},
        enter: async (adapterId) => () => left.push(adapterId),
      },
    )
    await expect(caller.call(call)).rejects.toThrow('boom')
    expect(left).toEqual(['shop'])
  })

  it('maps every runtime result onto the endpoint’s outcome', () => {
    expect(outcomeOf({ status: 'needsUser', reason: 'captcha' })).toEqual({
      status: 'needsUser',
      reason: 'captcha',
    })
    expect(outcomeOf({ status: 'failed', stage: 'probe', errorClass: 'unavailable' })).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'unavailable',
    })
    expect(outcomeOf({ status: 'blocked', retryAfterMs: 1000 })).toEqual({
      status: 'blocked',
      stage: 'tool-run',
      errorClass: 'blocked-by-site',
      retryAfterMs: 1000,
    })
    expect(outcomeOf({ status: 'declined' })).toEqual({ status: 'declined' })
  })
})

describe('the preload’s API', () => {
  function ipc() {
    const invoked: { channel: string; args: unknown[] }[] = []
    const listeners = new Map<string, ((event: unknown, message: unknown) => void)[]>()
    const fake: IpcLike = {
      invoke: async (channel, ...args) => {
        invoked.push({ channel, args })
        return null
      },
      on: (channel, listener) => listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
      removeListener: (channel, listener) =>
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((l) => l !== listener),
        ),
    }
    return { fake, invoked, listeners }
  }

  it('has exactly one method per channel and onEvent', async () => {
    const { fake, invoked } = ipc()
    const api = buildApi(fake) as unknown as Record<string, Record<string, unknown>>
    for (const method of INVOKE_METHODS) {
      const parts = method.split('.')
      const fn = parts.length === 1 ? api[parts[0] as string] : api[parts[0] as string]?.[parts[1] as string]
      expect(typeof fn).toBe('function')
    }
    const typed = buildApi(fake)
    await typed.adapters.get('woolworths')
    await typed.runs.list(undefined)
    expect(invoked).toEqual([
      { channel: invokeChannel('adapters.get'), args: ['woolworths'] },
      { channel: invokeChannel('runs.list'), args: [] },
    ])
  })

  it('passes on only known events, as fresh objects, and unsubscribes', () => {
    const { fake, listeners } = ipc()
    const api = buildApi(fake)
    const got: unknown[] = []
    const off = api.onEvent((e) => got.push(e))
    const deliver = (message: unknown) => {
      for (const l of listeners.get('siteadapter:event') ?? []) l({}, message)
    }
    deliver({ type: 'grants-changed', token: 'leak' })
    deliver({ type: 'audit-appended', seq: 7, record: { secret: 'x' } })
    deliver({ type: 'audit-appended', seq: 'x' })
    deliver({ type: 'not-ours' })
    deliver(null)
    off()
    deliver({ type: 'app-changed' })
    expect(got).toEqual([
      { type: 'grants-changed' },
      { type: 'audit-appended', seq: 7 },
      { type: 'audit-appended', seq: 0 },
    ])
    expect(eventFrom('grants-changed')).toBeNull()
  })
})

describe('run previews', () => {
  it('splits redaction markers out of the JSON and clips long output', () => {
    const preview = previewParts({ name: 'Milk', session: REDACTED, nested: [REDACTED] })
    expect(preview.redactions).toBe(2)
    expect(preview.parts.filter((p) => p.kind === 'redacted')).toEqual([
      { kind: 'redacted', label: 'secret', ref: null },
      { kind: 'redacted', label: 'secret', ref: null },
    ])
    expect(JSON.stringify(preview.parts)).not.toContain(REDACTED)
    const long = previewParts({ text: 'x'.repeat(30_000) })
    expect((long.parts[0] as { text: string }).text.length).toBeLessThan(20_010)
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    expect(previewParts(cycle).parts).toEqual([{ kind: 'text', text: '(not shown)' }])
  })

  it('keeps a bounded number of runs, in memory only', () => {
    const memory = new RunMemory()
    for (let i = 0; i < 205; i++) memory.started(`c${i}`, 'echo', 'Claude Code', { i }, 'http')
    expect(memory.get('c0')).toBeUndefined()
    memory.finished('c204', { text: 'done' })
    expect(memory.get('c204')?.outputBytes).toBeGreaterThan(0)
    memory.finished('c204', undefined)
    memory.finished('nope', { x: 1 })
    expect(memory.get('nope')).toBeUndefined()
  })
})

describe('audit views', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  async function log(
    events: AuditEvent[],
    at = (i: number) => Date.parse('2026-11-07T09:00:00.000') + i * 60_000,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'sa-audit-'))
    dirs.push(dir)
    const path = join(dir, 'audit.jsonl')
    let i = 0
    const audit = new AuditLog(path, { now: () => at(i++) })
    for (const event of events) await audit.append(event)
    return { path, reader: new AuditReader(path) }
  }

  const lookup: AdapterLookup = {
    name: (id) => (id === 'shop' ? 'Shop' : id),
    sideEffect: () => 'write',
    fillSelector: () => '#pass',
  }
  const events: AuditEvent[] = [
    {
      type: 'tool-called',
      adapterId: 'shop',
      adapterHash: 'a'.repeat(64),
      tool: 'add',
      client: 'Claude Code',
      callId: 'c1',
    },
    { type: 'login-started', adapterId: 'shop', callId: 'c1' },
    {
      type: 'secret-used',
      adapterId: 'shop',
      adapterHash: 'a'.repeat(64),
      secret: 'login',
      field: 'password',
      origin: 'https://login.shop.test',
      callId: 'c1',
    },
    { type: 'login-finished', adapterId: 'shop', outcome: 'ok' },
    {
      type: 'request-blocked',
      adapterId: 'shop',
      method: 'GET',
      target: 'https://ads.test/',
      reason: 'host-not-allowed',
      initiator: 'page',
      callId: 'c1',
    },
    {
      type: 'confirmation',
      adapterId: 'shop',
      tool: 'add',
      client: 'Claude Code',
      callId: 'c1',
      answer: 'approved',
    },
    { type: 'tool-finished', adapterId: 'shop', callId: 'c1', outcome: 'ok', durationMs: 1200 },
    {
      type: 'tool-called',
      adapterId: 'shop',
      adapterHash: 'a'.repeat(64),
      tool: 'echo',
      client: 'Other',
      callId: 'c2',
    },
    {
      type: 'tool-finished',
      adapterId: 'shop',
      callId: 'c2',
      outcome: 'needsUser',
      needsUser: 'captcha',
      durationMs: 10,
    },
    {
      type: 'tool-called',
      adapterId: 'shop',
      adapterHash: 'a'.repeat(64),
      tool: 'echo',
      client: 'Other',
      callId: 'c3',
    },
    {
      type: 'tool-finished',
      adapterId: 'shop',
      callId: 'c3',
      outcome: 'failed',
      stage: 'probe',
      errorClass: 'unavailable',
      durationMs: 10,
    },
    { type: 'grant-revoked', adapterId: 'shop', secret: 'login' },
  ]

  it('pages newest first, filtered, with a cursor', async () => {
    const { reader } = await log(events)
    const records = await reader.records()
    expect(records).toHaveLength(12)
    const first = auditPage(records, { category: 'tool-calls', limit: 2 })
    expect(first.records.map((r) => r.seq)).toEqual([11, 10])
    expect(first.total).toBe(6)
    expect(first.nextBeforeSeq).toBe(10)
    const next = auditPage(records, { category: 'tool-calls', limit: 10, beforeSeq: 10 })
    expect(next.records.map((r) => r.seq)).toEqual([9, 8, 7, 1])
    expect(next.nextBeforeSeq).toBeNull()
    expect(auditPage(records, { client: 'Other' }).total).toBe(2)
    expect(auditPage(records, { search: 'ADS.test' }).records.map((r) => r.event.type)).toEqual([
      'request-blocked',
    ])
    expect(auditPage(records, { adapterId: 'other' }).total).toBe(0)
    expect(auditPage(records, { since: '2026-11-07T09:10:00.000+11:00' }).total).toBe(2)
  })

  it('summarises runs and traces one from its own events', async () => {
    const { reader } = await log(events)
    const records = await reader.records()
    const runs = runSummaries(records, lookup)
    expect(runs.map((r) => [r.callId, r.outcome, r.blockedRequests])).toEqual([
      ['c3', 'failed', 0],
      ['c2', 'needsUser', 0],
      ['c1', 'ok', 1],
    ])
    expect(runSummaries(records, lookup, { adapterId: 'x' })).toEqual([])
    const memory = new RunMemory()
    memory.started('c1', 'add', 'Claude Code', { item: 'milk' }, 'http')
    memory.finished('c1', { added: true, note: REDACTED })
    const trace = runTrace(records, 'c1', lookup, memory, () => ({ version: '1.0.0', hash: 'a'.repeat(64) }))
    expect(trace?.steps.map((s) => s.type)).toEqual([
      'called',
      'login-started',
      'secret-fill',
      'request',
      'confirmation',
      'output',
    ])
    expect(trace?.steps.find((s) => s.type === 'secret-fill')).toMatchObject({
      selector: '#pass',
      checks: expect.arrayContaining(['form-action']),
    })
    expect(trace?.steps.find((s) => s.type === 'request')).toMatchObject({
      blockedReason: 'host-not-allowed',
      decision: 'blocked',
    })
    expect(trace?.secretsUsed).toEqual([{ secret: 'login', field: 'password' }])
    expect(trace?.output?.some((p) => p.kind === 'redacted')).toBe(true)
    const failed = runTrace(records, 'c3', lookup, memory, () => ({ version: '1.0.0', hash: '' }))
    expect(failed?.steps.at(-1)).toMatchObject({ type: 'failed', errorClass: 'unavailable' })
    expect(failed?.output).toBeNull()
    expect(failed?.input).toEqual([{ kind: 'text', text: '(not kept: the app restarted since this call)' }])
    expect(
      runTrace(records, 'c2', lookup, memory, () => ({ version: '', hash: '' }))?.steps.at(-1),
    ).toMatchObject({ type: 'needs-user' })
    expect(runTrace(records, 'nope', lookup, memory, () => ({ version: '', hash: '' }))).toBeNull()
  })

  it('counts today by hour, and the last seven days', async () => {
    const { reader } = await log(events)
    const records = await reader.records()
    const stats = statsToday(records, new Date('2026-11-07T10:30:00.000'))
    expect(stats).toMatchObject({ toolCalls: 3, logins: 1, loginsFailed: 0, blockedRequests: 1 })
    expect(stats.hourly.toolCalls).toHaveLength(11)
    expect(stats.hourly.toolCalls[9]).toBe(3)
    expect(callCounts(records, new Date('2026-11-07T10:30:00.000')).get('shop/echo')).toBe(2)
    expect(callCounts(records, new Date('2026-11-20T10:30:00.000')).get('shop')).toBeUndefined()
  })

  it('reads only what was appended since the last read, and a torn last line once it is whole', async () => {
    const { reader, path } = await log(events.slice(0, 2))
    const first = await reader.records()
    expect(first.map((r) => r.seq)).toEqual([1, 2])
    const { appendFileSync, readFileSync } = await import('node:fs')
    const lines = readFileSync(path, 'utf8').split('\n')
    const record = JSON.parse(lines[1] as string) as AuditRecord
    const third = JSON.stringify({ ...record, seq: 3 })
    // Half a line: not read yet.
    appendFileSync(path, third.slice(0, 20))
    expect((await reader.records()).map((r) => r.seq)).toEqual([1, 2])
    appendFileSync(path, `${third.slice(20)}\n`)
    expect((await reader.records()).map((r) => r.seq)).toEqual([1, 2, 3])
    // What was read before isn't parsed again: an earlier line edited in place goes unnoticed until
    // verify, which reads from the top.
    const edited = readFileSync(path, 'utf8').replace('"seq":1', '"seq":7')
    writeFileSync(path, edited)
    expect((await reader.records()).map((r) => r.seq)).toEqual([1, 2, 3])
    await reader.verify(new Date(0))
    expect((await reader.records()).map((r) => r.seq)).toEqual([7, 2, 3])
  })

  it('starts again when the file is replaced or shrinks, and parallel reads don’t double up', async () => {
    const { reader, path } = await log(events.slice(0, 3))
    const [a, b] = await Promise.all([reader.records(), reader.records()])
    expect(a.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(b.map((r) => r.seq)).toEqual([1, 2, 3])
    const { readFileSync, renameSync, rmSync: remove } = await import('node:fs')
    const firstLine = `${readFileSync(path, 'utf8').split('\n')[0]}\n`
    // Shrunk in place.
    writeFileSync(path, firstLine)
    expect((await reader.records()).map((r) => r.seq)).toEqual([1])
    // Replaced by another file of the same size.
    const other = `${path}.new`
    writeFileSync(other, firstLine.replace('"seq":1', '"seq":5'))
    renameSync(other, path)
    expect((await reader.records()).map((r) => r.seq)).toEqual([5])
    remove(path)
    expect(await reader.records()).toEqual([])
  })

  it('verifies the chain and reports where it breaks; skips lines that don’t parse', async () => {
    const { reader, path } = await log(events.slice(0, 3))
    expect(await reader.verify(new Date(0))).toMatchObject({ state: 'intact', records: 3, headSeq: 3 })
    const lines = (await import('node:fs')).readFileSync(path, 'utf8').split('\n')
    const edited = JSON.parse(lines[1] as string) as AuditRecord
    writeFileSync(
      path,
      [
        lines[0],
        JSON.stringify({ ...edited, at: '2020-01-01T00:00:00.000Z' }),
        lines[2],
        'not json',
        '',
      ].join('\n'),
    )
    expect(await reader.verify(new Date(0))).toMatchObject({ state: 'broken', firstBadSeq: 2 })
    expect((await reader.records()).map((r) => r.seq)).toEqual([1, 2, 3])
    expect(await new AuditReader(join(path, 'missing')).records()).toEqual([])
  })
})
