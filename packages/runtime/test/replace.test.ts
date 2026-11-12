// ToolHost.replace: swapping in another version of an adapter (docs/adapter-packages.md), and the
// tool process's own input check before anything about a call happens.

import { defineAdapter, tool } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { systemSleep } from '../src/clock'
import { FakeSessionDriver } from './fakes'
import { call, fixture, HASH, manifest, OTHER_HASH } from './fixtures'
import { tools as honestTools } from './isolation/honest-tools'
import { HONEST, inMemory, scriptFor } from './isolation/processes'

function gated() {
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const definition = defineAdapter({
    manifest: {
      ...manifest,
      tools: [{ name: 'wait', title: 'Wait', description: 'Waits.', sideEffect: 'read' }],
    },
    tools: {
      wait: tool({
        input: z.object({}),
        output: z.string(),
        run: async () => {
          await gate
          return 'old'
        },
      }),
    },
  })
  return { definition, open: () => open() }
}

const newer = defineAdapter({
  manifest: {
    ...manifest,
    version: '0.2.0',
    tools: [{ name: 'wait', title: 'Wait', description: 'Waits.', sideEffect: 'read' }],
  },
  tools: { wait: tool({ input: z.object({}), output: z.string(), run: async () => 'new' }) },
})

describe('ToolHost.replace', () => {
  it('swaps in the new version, whose unapproved hash lists no tools', async () => {
    const { definition } = gated()
    const w = fixture(definition)
    expect(await w.host.listTools()).toHaveLength(1)
    await w.host.replace({ definition: newer, bundleHash: OTHER_HASH, driver: new FakeSessionDriver() })
    expect(await w.host.listTools()).toEqual([])
    expect(await w.host.call({ ...call, tool: 'wait' })).toEqual({
      status: 'failed',
      stage: 'manifest',
      errorClass: 'not-granted',
    })
  })

  it('runs the approved new version once swapped', async () => {
    const { definition } = gated()
    const w = fixture(definition)
    await w.host.replace({ definition: newer, bundleHash: HASH, driver: new FakeSessionDriver() })
    expect(await w.host.call({ ...call, tool: 'wait' })).toMatchObject({ status: 'ok', output: 'new' })
  })

  it('waits for a running call, and a call queued behind the swap starts nothing', async () => {
    const { definition, open } = gated()
    const w = fixture(definition)
    const running = w.host.call({ ...call, tool: 'wait' })
    await new Promise((r) => setTimeout(r, 20))
    let swapped = false
    const swap = w.host
      .replace({ definition: newer, bundleHash: HASH, driver: new FakeSessionDriver() })
      .then(() => {
        swapped = true
      })
    const queued = w.host.call({ ...call, callId: 'call-2', tool: 'wait' })
    await new Promise((r) => setTimeout(r, 20))
    expect(swapped).toBe(false)
    open()
    expect(await running).toMatchObject({ status: 'ok', output: 'old' })
    await swap
    expect(await queued).toMatchObject({ status: 'busy' })
    expect(await w.host.call({ ...call, callId: 'call-3', tool: 'wait' })).toMatchObject({ output: 'new' })
  })

  it('gives up when the lock stays taken, and leaves the old version in place', async () => {
    const { definition, open } = gated()
    const w = fixture(definition, { sleep: systemSleep, pacingSleep: async () => {} })
    const running = w.host.call({ ...call, tool: 'wait' })
    await new Promise((r) => setTimeout(r, 20))
    await expect(
      w.host.replace({ definition: newer, bundleHash: HASH, driver: new FakeSessionDriver() }, 30),
    ).rejects.toMatchObject({ stage: 'config', errorClass: 'busy' })
    open()
    await running
    expect(await w.host.call({ ...call, callId: 'call-2', tool: 'wait' })).toMatchObject({ output: 'old' })
  })

  it('registers an adapter it does not know yet', async () => {
    const { definition } = gated()
    const w = fixture(definition)
    const other = defineAdapter({ ...newer, manifest: { ...newer.manifest, id: 'other-shop' } })
    await w.host.replace({ definition: other, bundleHash: HASH, driver: new FakeSessionDriver() })
    await expect(
      w.host.replace({
        definition: { ...other, manifest: { ...other.manifest, id: 'Bad' } },
        bundleHash: HASH,
        driver: new FakeSessionDriver(),
      }),
    ).rejects.toThrow()
  })
})

describe('the tool process checks input first', () => {
  it('refuses input its own schema refuses, without running the tool', async () => {
    const processes = inMemory()
    const script = await scriptFor(HONEST)
    // The main process's schema is looser than the tool's own, as a derived one can be.
    const loose = { ...honestTools.refined, input: z.object({ n: z.number() }) }
    const definition = defineAdapter({
      manifest: {
        ...manifest,
        tools: [{ name: 'refined', title: 'R', description: 'R', sideEffect: 'read' }],
      },
      tools: { refined: loose },
    })
    const w = fixture(definition, {}, { script, start: processes.start })
    expect(await w.host.call({ ...call, tool: 'refined', input: { n: -1 } })).toEqual({
      status: 'failed',
      stage: 'tool-input',
      errorClass: 'invalid',
    })
    expect(processes.channels).toHaveLength(1)
    expect(await w.host.call({ ...call, callId: 'call-2', tool: 'refined', input: { n: 2 } })).toMatchObject({
      status: 'ok',
      output: 2,
    })
  })
})
