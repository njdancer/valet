// @vitest-environment node
// The gate between tool calls and the app's own login work on an adapter.

import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { AdapterGate } from '../../src/main/core/adapter-gate'
import { FakeAuthPage, FakeDriver, ManualTimers } from './fixtures'

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const policy = { egress: [], requests: [], maxPurpose: 'read', ceiling: 1 } as const

describe('AdapterGate', () => {
  it('runs exclusive work at once when nothing is going on', async () => {
    const gate = new AdapterGate(new ManualTimers())
    expect(await gate.exclusive('shop', 1000, async () => 'done')).toBe('done')
    expect(gate.busy('shop')).toBe(false)
  })

  it('waits for calls in flight, and holds new calls until it is done', async () => {
    const gate = new AdapterGate(new ManualTimers())
    const order: string[] = []
    const leaveFirst = await gate.enter('shop')
    expect(gate.busy('shop')).toBe(true)
    const work = gate.exclusive('shop', 1000, async () => {
      order.push('exclusive')
    })
    const second = gate.enter('shop').then((leave) => {
      order.push('second call')
      return leave
    })
    await flush()
    expect(order).toEqual([])
    leaveFirst()
    leaveFirst() // harmless twice
    await work
    const leaveSecond = await second
    expect(order).toEqual(['exclusive', 'second call'])
    leaveSecond()
    expect(gate.busy('shop')).toBe(false)
  })

  it('waits for a run the runtime left open after its call returned', async () => {
    const gate = new AdapterGate(new ManualTimers())
    const inner = new FakeDriver()
    const driver = gate.track('shop', inner)
    driver.beginRun(policy, () => {})
    expect(gate.busy('shop')).toBe(true)
    let ran = false
    const work = gate.exclusive('shop', 1000, async () => {
      ran = true
    })
    await flush()
    expect(ran).toBe(false)
    driver.endRun()
    await work
    expect(ran).toBe(true)
    expect(inner.log).toEqual(['begin', 'end'])
  })

  it('counts a run as ended even when the driver’s endRun throws', async () => {
    const gate = new AdapterGate(new ManualTimers())
    const inner = new FakeDriver()
    inner.endRun = () => {
      throw new Error('gone')
    }
    const driver = gate.track('shop', inner)
    driver.beginRun(policy, () => {})
    expect(() => driver.endRun()).toThrow('gone')
    expect(gate.busy('shop')).toBe(false)
  })

  it('does not count a run whose beginRun threw', () => {
    const gate = new AdapterGate(new ManualTimers())
    const inner = new FakeDriver()
    inner.beginRun = () => {
      throw new Error('refused')
    }
    const driver = gate.track('shop', inner)
    expect(() => driver.beginRun(policy, () => {})).toThrow('refused')
    expect(gate.busy('shop')).toBe(false)
  })

  it('gives up without running the work when the adapter stays busy, and lets calls go again', async () => {
    const timers = new ManualTimers()
    const gate = new AdapterGate(timers)
    const leave = await gate.enter('shop')
    let ran = false
    const work = gate.exclusive('shop', 30_000, async () => {
      ran = true
    })
    await flush()
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([30_000])
    timers.fire()
    await expect(work).rejects.toEqual(new SiteAdapterError('login', 'timed-out'))
    expect(ran).toBe(false)
    // A call that arrived meanwhile isn't stuck behind the abandoned work.
    const next = await gate.enter('shop')
    next()
    leave()
  })

  it('runs exclusive work one at a time, in order, and survives one that throws', async () => {
    const gate = new AdapterGate(new ManualTimers())
    const order: string[] = []
    let release: () => void = () => {}
    const first = gate.exclusive('shop', 1000, async () => {
      order.push('first start')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push('first end')
      throw new Error('first failed')
    })
    const second = gate.exclusive('shop', 1000, async () => {
      order.push('second')
    })
    await flush()
    expect(order).toEqual(['first start'])
    release()
    await expect(first).rejects.toThrow('first failed')
    await second
    expect(order).toEqual(['first start', 'first end', 'second'])
  })

  it('keeps adapters apart', async () => {
    const gate = new AdapterGate(new ManualTimers())
    const leave = await gate.enter('shop')
    expect(await gate.exclusive('other', 1000, async () => 'other done')).toBe('other done')
    leave()
  })

  it('passes every driver method through to the real driver', async () => {
    const gate = new AdapterGate(new ManualTimers())
    const inner = new FakeDriver()
    const page = new FakeAuthPage()
    inner.nextPage = () => page
    inner.sessionValues = ['v']
    const driver = gate.track('shop', inner)
    expect(await driver.openAuthPage()).toBe(page)
    expect(await driver.toolPage()).toBe(await inner.toolPage())
    await driver.handoff(['www.shop.test'], [])
    expect(inner.handoffs).toEqual([{ cookieDomains: ['www.shop.test'], storage: [] }])
    expect(await driver.sessionSecrets(['www.shop.test'], [])).toEqual(['v'])
    expect(await driver.cookieNames(['www.shop.test'])).toEqual(['sid'])
    let unlocked = false
    inner.unlockIrreversible = () => {
      unlocked = true
    }
    driver.unlockIrreversible()
    expect(unlocked).toBe(true)
    await driver.close()
    expect(inner.closed).toBe(true)
  })
})
