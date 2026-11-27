// Developer mode's key (docs/approval-broker.md#developer-mode): one prompt turns it on, it signs
// only while on, it ends on its timer or when turned off, and a key left by a run before is revoked.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { DevModeKeep, KeptDevMode } from '../../src/main/core/approvals/dev-mode'
import { fileDevModeKeep } from '../../src/main/core/approvals/dev-mode-keep'

class MemoryFiles implements FileOps {
  readonly files = new Map<string, string>()
  async read(path: string) {
    return this.files.get(path) ?? null
  }
  async write(path: string, text: string) {
    this.files.set(path, text)
  }
}

class MemoryKeep implements DevModeKeep {
  kept: KeptDevMode | null = null
  fail = false
  async read() {
    if (this.fail) throw new Error('keychain unavailable')
    return this.kept
  }
  async write(kept: KeptDevMode) {
    if (this.fail) throw new Error('keychain unavailable')
    this.kept = kept
  }
  async clear() {
    this.kept = null
  }
}

async function setup(
  over: { available?: boolean; present?: boolean; noChannel?: boolean; keep?: DevModeKeep } = {},
) {
  const signer = new SoftwareSigner(() => over.present ?? true)
  const keys = await signer.keys()
  const ledger = await TrustedLedger.open(
    new AnchoredFile('/t.json', 'trusted', new MemoryAnchor(), new MemoryFiles()),
  )
  const devices = new DeviceStore(ledger, keys)
  let now = Date.parse('2026-11-27T00:00:00Z')
  const pending = new Map<number, () => void>()
  let next = 0
  const changes: Array<[boolean, 'on' | 'resumed' | DevModeEnd]> = []
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
    changed: (on: boolean, why: 'on' | 'resumed' | DevModeEnd) => {
      changes.push([on, why])
    },
    ...(over.keep === undefined ? {} : { keep: over.keep }),
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

  describe('across a restart', () => {
    it('stays on with the kept key until the same end, and then ends', async () => {
      const keep = new MemoryKeep()
      const { dev, devices, options, pending, advance } = await setup({ keep })
      await dev.turnOn()
      const id = dev.deviceId()
      const until = dev.status().until
      expect(keep.kept?.deviceId).toBe(id)
      expect(keep.kept?.until).toBe(until)
      advance(3 * 3600_000)
      // A new process, the old one's timer gone with it.
      pending.clear()
      const changes: Array<[boolean, string]> = []
      const restarted = new DevMode({ ...options, changed: (on, why) => changes.push([on, why]) })
      expect(await restarted.resume(true)).toBe(true)
      expect(await restarted.revokeLeftovers()).toBe(0)
      expect(restarted.deviceId()).toBe(id)
      expect(restarted.status().until).toBe(until)
      expect(devices.activeDev().map((r) => r.deviceId)).toEqual([id])
      expect(changes).toEqual([[true, 'resumed']])
      // Its signature is the kept key's: the record's own approval key verifies it.
      expect(typeof (await restarted.sign('payload'))).toBe('string')
      // The rest of its 8 hours, not 8 more.
      expect(pending.size).toBe(1)
      advance(5 * 3600_000)
      expect(await restarted.sign('payload')).toBeNull()
      for (const run of pending.values()) run()
      await new Promise((r) => setTimeout(r, 10))
      expect(restarted.deviceId()).toBeNull()
      expect(devices.activeDev()).toEqual([])
      expect(keep.kept).toBeNull()
      expect(changes).toEqual([
        [true, 'resumed'],
        [false, 'expired'],
      ])
    })

    it('does not resume once its time is up, when locked down, turned off, or without the record', async () => {
      const cases: Array<(s: Awaited<ReturnType<typeof setup>>, keep: MemoryKeep) => Promise<boolean>> = [
        // Its 8 hours ran out while Valet was stopped.
        async (s) => {
          s.advance(DEV_MODE_MS)
          return true
        },
        // Locked down at launch.
        async () => false,
        // Its record was revoked (a phone's lockdown, say), the kept key still there.
        async (s, keep) => {
          const kept = keep.kept
          await s.dev.turnOff('lockdown')
          keep.kept = kept
          return true
        },
        // A kept time past 8 hours from now: never trusted.
        async (s, keep) => {
          if (keep.kept !== null)
            keep.kept = {
              ...keep.kept,
              until: new Date(Date.parse(keep.kept.until) + DEV_MODE_MS).toISOString(),
            }
          return true
        },
        // A key that isn't the record's.
        async (s, keep) => {
          const other = await setup({ keep: new MemoryKeep() })
          await other.dev.turnOn()
          if (keep.kept !== null)
            keep.kept = { ...keep.kept, keys: (other.options.keep as MemoryKeep).kept!.keys }
          return true
        },
      ]
      for (const prepare of cases) {
        const keep = new MemoryKeep()
        const s = await setup({ keep })
        await s.dev.turnOn()
        const allowed = await prepare(s, keep)
        const restarted = new DevMode(s.options)
        expect(await restarted.resume(allowed)).toBe(false)
        expect(restarted.deviceId()).toBeNull()
        expect(keep.kept).toBeNull()
        await restarted.revokeLeftovers()
        expect(s.devices.activeDev()).toEqual([])
      }
    })

    it('turning off clears what was kept, and a store that fails only means no resume', async () => {
      const keep = new MemoryKeep()
      const { dev, options } = await setup({ keep })
      await dev.turnOn()
      await dev.turnOff('turned-off')
      expect(keep.kept).toBeNull()
      expect(await new DevMode(options).resume(true)).toBe(false)
      keep.fail = true
      expect(await dev.turnOn()).toBe(true)
      expect(await new DevMode(options).resume(true)).toBe(false)
      // Without a store at all, a restart ends it as before.
      const plain = await setup()
      await plain.dev.turnOn()
      expect(await new DevMode(plain.options).resume(true)).toBe(false)
    })

    it('keeps it in a file only the person can read, and reads a damaged one as nothing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'valet-devkeep-'))
      try {
        const path = join(dir, 'dev-mode-key.json')
        const keep = fileDevModeKeep(path)
        expect(await keep.read()).toBeNull()
        const s = await setup({ keep })
        await s.dev.turnOn()
        expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
        expect(JSON.parse(await readFile(path, 'utf8')).deviceId).toBe(s.dev.deviceId())
        const restarted = new DevMode(s.options)
        expect(await restarted.resume(true)).toBe(true)
        await restarted.turnOff('turned-off')
        expect(await keep.read()).toBeNull()
        await keep.clear()
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, '{"keys":1}')
        expect(await keep.read()).toBeNull()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
