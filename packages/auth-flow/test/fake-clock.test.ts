import { describe, expect, it } from 'vitest'
import { FakeClock, RunawayLoop } from './fakes'
import { START } from './fixtures'

describe('FakeClock', () => {
  it('moves only when slept', async () => {
    const clock = new FakeClock(START)
    expect(clock.clock().getTime()).toBe(START)
    await clock.sleep(250)
    expect(clock.clock().getTime()).toBe(START + 250)
    expect(clock.sleeps).toEqual([250])
  })

  it('refuses a sleep past the cap on the number of sleeps', async () => {
    const clock = new FakeClock(START)
    for (let i = 0; i < FakeClock.MAX_SLEEPS; i++) await clock.sleep(0)
    await expect(clock.sleep(0)).rejects.toBeInstanceOf(RunawayLoop)
    expect(clock.runaway).toBe(true)
  })

  it('refuses a sleep past the cap on fake time', async () => {
    const clock = new FakeClock(START)
    await clock.sleep(FakeClock.MAX_ELAPSED_MS)
    await expect(clock.sleep(1)).rejects.toBeInstanceOf(RunawayLoop)
  })

  it('refuses a NaN sleep, which would otherwise never move the clock', async () => {
    const clock = new FakeClock(START)
    await expect(clock.sleep(Number.NaN)).rejects.toBeInstanceOf(RunawayLoop)
    expect(clock.sleeps).toEqual([])
  })

  it('refuses a negative sleep', async () => {
    const clock = new FakeClock(START)
    await expect(clock.sleep(-1)).rejects.toBeInstanceOf(RunawayLoop)
  })
})
