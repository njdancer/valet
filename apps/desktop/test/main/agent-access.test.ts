// Each agent's own access to Mail accounts, calendars and lists (agent-access.ts, docs/access.md).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentAccessStore,
  accessAppOf,
  accessLabel,
  accessReach,
  accessWidening,
  applyAccessChange,
  editableIds,
  NO_APP_ACCESS,
  readableIds,
  withWidening,
} from '../../src/main/core/agent-access'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function path() {
  const dir = mkdtempSync(join(tmpdir(), 'access-'))
  dirs.push(dir)
  return join(dir, 'agent-access.json')
}

describe('agent access', () => {
  it('works out what a change adds, and applies only that when signed', () => {
    const before = { items: { A: 'read', B: 'edit' }, full: false } as const
    const after = applyAccessChange(before, { items: { A: 'edit', B: 'off', C: 'read' } })
    expect(after).toEqual({ items: { A: 'edit', C: 'read' }, full: false })
    expect(accessWidening(before, after)).toEqual({
      items: [
        { id: 'A', level: 'edit' },
        { id: 'C', level: 'read' },
      ],
      full: false,
    })
    // Narrowing only: nothing to sign.
    expect(accessWidening(before, applyAccessChange(before, { items: { B: 'read' } }))).toEqual({
      items: [],
      full: false,
    })
    expect(accessWidening(NO_APP_ACCESS, { items: {}, full: true }).full).toBe(true)
    // A widening never lowers anything.
    expect(
      withWidening(before, {
        items: [
          { id: 'B', level: 'read' },
          { id: 'D', level: 'edit' },
        ],
        full: true,
      }),
    ).toEqual({
      items: { A: 'read', B: 'edit', D: 'edit' },
      full: true,
    })
    expect([...readableIds(after)]).toEqual(['A', 'C'])
    expect([...editableIds(after)]).toEqual(['A'])
    expect(accessReach(after)).toEqual({ read: true, edit: true })
    expect(accessReach(NO_APP_ACCESS)).toEqual({ read: false, edit: false })
  })

  it('names the apps whose own tools it covers, and cleans labels for the card', () => {
    expect(accessAppOf('mail')).toBe('mail')
    expect(accessAppOf('reminders')).toBe('reminders')
    expect(accessAppOf('woolworths')).toBeNull()
    expect(accessLabel('  Home \n calendar ')).toBe('Home calendar')
    expect(accessLabel('x'.repeat(100))).toHaveLength(80)
    expect(accessLabel('‮')).toBe('Untitled')
  })

  it('keeps records per agent across a restart, drops items and agents, and seeds once', async () => {
    const file = path()
    const store = new AgentAccessStore(file)
    await store.load()
    expect(store.seeded).toBe(false)
    await store.seed({
      'local:a': { mail: { items: { M1: 'read' }, full: false }, calendar: { items: {}, full: false } },
      'remote:b': {},
    })
    expect(store.seeded).toBe(true)
    expect(store.clientIds()).toEqual(['local:a'])
    // A second seed changes nothing.
    await store.seed({ 'remote:b': { mail: { items: { M1: 'edit' }, full: false } } })
    expect(store.get('remote:b')).toEqual({})
    await store.set('remote:b', 'calendar', { items: { C1: 'edit', C2: 'read' }, full: false })
    await store.set('local:a', 'calendar', { items: { C1: 'read' }, full: false })
    expect([...store.usage('calendar').entries()]).toEqual([
      [
        'C1',
        [
          { clientId: 'local:a', level: 'read' },
          { clientId: 'remote:b', level: 'edit' },
        ],
      ],
      ['C2', [{ clientId: 'remote:b', level: 'read' }]],
    ])
    await store.dropItem('calendar', 'C1')
    await store.dropItem('calendar', 'gone')
    expect(store.app('remote:b', 'calendar')).toEqual({ items: { C2: 'read' }, full: false })
    expect(store.app('local:a', 'calendar')).toEqual({ items: {}, full: false })

    const again = new AgentAccessStore(file)
    await again.load()
    expect(again.seeded).toBe(true)
    expect(again.app('local:a', 'mail')).toEqual({ items: { M1: 'read' }, full: false })
    // Emptied: nothing is kept for it.
    await again.set('local:a', 'mail', NO_APP_ACCESS)
    await again.set('local:a', 'calendar', NO_APP_ACCESS)
    expect(again.clientIds()).toEqual(['remote:b'])
    await again.forget('remote:b')
    await again.forget('remote:b')
    expect(again.clientIds()).toEqual([])
  })

  it('reads a damaged file as nobody having anything', async () => {
    const file = path()
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        seeded: true,
        clients: { 'local:a': { mail: { items: { M: 'own' }, full: false } } },
      }),
    )
    const store = new AgentAccessStore(file)
    await store.load()
    expect(store.app('local:a', 'mail')).toEqual(NO_APP_ACCESS)
    // And never seeds from the old picks again, which could give back what was taken away.
    expect(store.seeded).toBe(true)
    const again = new AgentAccessStore(file)
    await again.load()
    expect(again.seeded).toBe(true)
  })

  it('gives a created calendar only while Full access is saved, so a Save that ran first is never undone', async () => {
    const store = new AgentAccessStore(path())
    await store.load()
    await store.set('remote:agent', 'calendar', { items: { Family: 'edit' }, full: true })
    // The person narrows while the agent's add is still running: the two writes queue, the Save first.
    const narrowed = store.set('remote:agent', 'calendar', { items: {}, full: false })
    const given = store.addCreated('remote:agent', 'calendar', 'Trips')
    await narrowed
    expect(await given).toBe(false)
    expect(store.app('remote:agent', 'calendar')).toEqual(NO_APP_ACCESS)

    await store.set('remote:agent', 'calendar', { items: { Family: 'read' }, full: true })
    expect(await store.addCreated('remote:agent', 'calendar', 'Trips')).toBe(true)
    expect(store.app('remote:agent', 'calendar')).toEqual({
      items: { Family: 'read', Trips: 'edit' },
      full: true,
    })
    // Another agent holds nothing, so it is given nothing.
    expect(await store.addCreated('remote:other', 'calendar', 'X')).toBe(false)
    expect(store.app('remote:other', 'calendar')).toEqual(NO_APP_ACCESS)
  })
})
