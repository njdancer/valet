import { describe, expect, it } from 'vitest'
import { KeyedMutex } from '../src/mutex'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('KeyedMutex', () => {
  it('runs tasks for one key one at a time, in arrival order', async () => {
    const mutex = new KeyedMutex()
    const events: string[] = []
    const gate = deferred()

    const first = mutex.run('woolworths', async () => {
      events.push('first:start')
      await gate.promise
      events.push('first:end')
    })
    const second = mutex.run('woolworths', async () => {
      events.push('second:start')
    })
    const third = mutex.run('woolworths', async () => {
      events.push('third:start')
    })
    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    gate.resolve()
    await Promise.all([first, second, third])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'third:start'])
  })

  it('lets different keys run at the same time', async () => {
    const mutex = new KeyedMutex()
    const gate = deferred()
    const events: string[] = []

    const first = mutex.run('woolworths', async () => {
      events.push('woolworths')
      await gate.promise
    })
    const second = mutex.run('coles', async () => {
      events.push('coles')
    })
    await second
    expect(events).toEqual(['woolworths', 'coles'])
    gate.resolve()
    await first
  })

  it('releases the lock when a task throws', async () => {
    const mutex = new KeyedMutex()
    await expect(
      mutex.run('woolworths', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(mutex.run('woolworths', async () => 'next')).resolves.toBe('next')
    expect(mutex.busy('woolworths')).toBe(false)
  })

  it('reports a key as busy while a task holds or waits for it', async () => {
    const mutex = new KeyedMutex()
    const gate = deferred()
    const running = mutex.run('woolworths', () => gate.promise)

    expect(mutex.busy('woolworths')).toBe(true)
    gate.resolve()
    await running
    expect(mutex.busy('woolworths')).toBe(false)
  })

  it('hands out a release function that is safe to call twice', async () => {
    const mutex = new KeyedMutex()
    const release = await mutex.acquire('woolworths')
    const waiting = mutex.acquire('woolworths')
    const third = mutex.acquire('woolworths')
    release()
    release()
    const second = await waiting
    // A second release from the first holder must not let the third in early.
    let thirdIn = false
    void third.then(() => {
      thirdIn = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(thirdIn).toBe(false)
    second()
    ;(await third)()
    expect(mutex.busy('woolworths')).toBe(false)
  })
})
