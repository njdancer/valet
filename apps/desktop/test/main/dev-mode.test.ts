// Developer mode's key (docs/approval-broker.md#developer-mode): one prompt turns it on, it signs
// only while on, it ends on its timer or when turned off, and a key left by a run before is revoked.

import { describe, expect, it } from 'vitest'
import {
  AnchoredFile,
  DEV_MODE_MS,
  DeviceStore,
  DevMode,
  type DevModeEnd,
  type FileOps,
  MemoryAnchor,
  SoftwareSigner,
  TrustedLedger,
} from '../../src/main/core/approvals'

class MemoryFiles implements FileOps {
  readonly files = new Map<string, string>()
  async read(path: string) {
    return this.files.get(path) ?? null
  }
  async write(path: string, text: string) {
    this.files.set(path, text)
  }
}

async function setup(over: { available?: boolean; present?: boolean; noChannel?: boolean } = {}) {
  const signer = new SoftwareSigner(() => over.present ?? true)
  const keys = await signer.keys()
  const ledger = await TrustedLedger.open(
    new AnchoredFile('/t.json', 'trusted', new MemoryAnchor(), new MemoryFiles()),
  )
  const devices = new DeviceStore(ledger, keys)
  let now = Date.parse('2026-11-27T00:00:00Z')
  const pending = new Map<number, () => void>()
  let next = 0
  const changes: Array<[boolean, 'on' | DevModeEnd]> = []
  const options = {
    available: over.available ?? true,
    devices,
    channel: over.noChannel === true ? undefined : signer.channel,
    now: () => now,
    timers: {
      setTimeout: (run: () => void) => {
        next += 1
        pending.set(next, run)
        return next
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number)
      },
    },
    changed: (on: boolean, why: 'on' | DevModeEnd) => {
      changes.push([on, why])
    },
  }
  const dev = new DevMode(options)
  return {
    dev,
    devices,
    signer,
    changes,
    pending,
    advance: (ms: number) => {
      now += ms
    },
    options,
  }
}

describe('developer mode', () => {
  it('does not turn on in a build without it, without the approval key, or when cancelled', async () => {
    for (const over of [{ available: false }, { noChannel: true }, { present: false }]) {
      const { dev, devices, changes } = await setup(over)
      expect(await dev.turnOn()).toBe(false)
      expect(dev.status().until).toBeNull()
      expect(dev.deviceId()).toBeNull()
      expect(await dev.sign('x')).toBeNull()
      expect(devices.activeDev()).toEqual([])
      expect(changes).toEqual([])
    }
    const { dev } = await setup({ available: false })
    expect(dev.status()).toEqual({ available: false, until: null })
  })

  it('turns on with one prompt, signs while on, and ends on its timer', async () => {
    const { dev, devices, signer, changes, pending, advance } = await setup()
    expect(await dev.turnOn()).toBe(true)
    expect(signer.prompts).toEqual(['turn on developer mode for 8 hours'])
    expect(dev.status()).toEqual({
      available: true,
      until: new Date(Date.parse('2026-11-27T00:00:00Z') + DEV_MODE_MS).toISOString(),
    })
    const id = dev.deviceId()
    expect(devices.activeDev().map((r) => r.deviceId)).toEqual([id])
    expect(typeof (await dev.sign('payload'))).toBe('string')
    // Past its end it signs nothing, even before the timer has run.
    advance(DEV_MODE_MS)
    expect(await dev.sign('payload')).toBeNull()
    expect(pending.size).toBe(1)
    for (const run of pending.values()) run()
    await new Promise((r) => setTimeout(r, 10))
    expect(dev.deviceId()).toBeNull()
    expect(devices.activeDev()).toEqual([])
    expect(changes).toEqual([
      [true, 'on'],
      [false, 'expired'],
    ])
  })

  it('starts a new key on turning on again, and turning off twice tells once', async () => {
    const { dev, devices, changes, pending } = await setup()
    await dev.turnOn()
    const first = dev.deviceId()
    await dev.turnOn()
    const second = dev.deviceId()
    expect(second).not.toBe(first)
    expect(devices.activeDev().map((r) => r.deviceId)).toEqual([second])
    expect(pending.size).toBe(1)
    await dev.turnOff('turned-off')
    await dev.turnOff('lockdown')
    expect(pending.size).toBe(0)
    expect(changes).toEqual([
      [true, 'on'],
      [true, 'on'],
      [false, 'turned-off'],
    ])
  })

  it('revokes a key a previous run left, and keeps its own', async () => {
    const { dev, devices, options } = await setup()
    await dev.turnOn()
    const left = dev.deviceId()
    // A new process: the old key is gone with the old one, its record still active.
    const restarted = new DevMode(options)
    expect(await restarted.revokeLeftovers()).toBe(1)
    expect(devices.activeDev()).toEqual([])
    expect(await restarted.revokeLeftovers()).toBe(0)
    await restarted.turnOn()
    expect(await restarted.revokeLeftovers()).toBe(0)
    expect(devices.activeDev().map((r) => r.deviceId)).toEqual([restarted.deviceId()])
    expect(left).not.toBe(restarted.deviceId())
  })
})
