import { describe, expect, it } from 'vitest'
import { systemClock, systemSleep } from '../src/clock'

describe('systemClock', () => {
  it('reads the wall clock', () => {
    const before = Date.now()
    expect(systemClock.now()).toBeGreaterThanOrEqual(before)
  })
})

describe('systemSleep', () => {
  it('resolves after the delay', async () => {
    await expect(systemSleep(1)).resolves.toBeUndefined()
  })

  it('resolves with a signal that never aborts', async () => {
    await expect(systemSleep(1, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('rejects as aborted when the signal fires while sleeping', async () => {
    const controller = new AbortController()
    const sleeping = systemSleep(60_000, controller.signal)
    controller.abort()
    await expect(sleeping).rejects.toMatchObject({ stage: 'tool-run', errorClass: 'aborted' })
  })

  it('rejects at once when the signal has already fired', async () => {
    await expect(systemSleep(60_000, AbortSignal.abort())).rejects.toMatchObject({ errorClass: 'aborted' })
  })
})
