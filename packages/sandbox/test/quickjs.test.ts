// Tool code in QuickJS (docs/sandbox.md#inside-quickjs), run in this process through the same
// ToolChannel the sandbox renderer gives. The runtime's honest and hostile tools run here exactly as
// they do in the `vm` worker, plus the escapes and limits specific to QuickJS.

import { join } from 'node:path'
import { type AdapterDefinition, defineAdapter, type ToolDeclaration } from '@valet/core'
import type { ToolProcessFactory } from '@valet/runtime'
import { beforeAll, describe, expect, it } from 'vitest'
import { systemSleep } from '../../runtime/src/clock'
import type { ToolHostOptions } from '../../runtime/src/tool-host'
import { call, fixture, HOME, manifest } from '../../runtime/test/fixtures'
import { tools as honestTools } from '../../runtime/test/isolation/honest-tools'
import { tools as hostileTools } from '../../runtime/test/isolation/hostile-tools'
import { HONEST, HOSTILE, scriptFor } from '../../runtime/test/isolation/processes'
import { inProcessQuickJS } from '../src/in-process'
import { nodeQuickJS } from '../src/node-module'
import { openQuickJSRun } from '../src/quickjs'
import { tools as sandboxTools } from './sandbox-tools'

const SANDBOX = join(import.meta.dirname, 'sandbox-tools.ts')
let factory: Awaited<ReturnType<typeof nodeQuickJS>>
let module: Awaited<ReturnType<typeof factory>>
beforeAll(async () => {
  factory = await nodeQuickJS()
  module = await factory()
})

function counted(start: ToolProcessFactory) {
  let started = 0
  let killed = 0
  const factory: ToolProcessFactory = () => {
    started++
    const channel = start()
    return {
      ...channel,
      kill: () => {
        killed++
        channel.kill()
      },
    }
  }
  return { factory, started: () => started, killed: () => killed }
}

async function inQuickJS(
  entry: string,
  tools: AdapterDefinition['tools'],
  overrides: Partial<ToolHostOptions> = {},
  limits?: Parameters<typeof inProcessQuickJS>[1],
  sideEffect: ToolDeclaration['sideEffect'] = 'write',
) {
  const script = await scriptFor(entry)
  const processes = counted(inProcessQuickJS(factory, limits))
  const definition = defineAdapter({
    manifest: {
      ...manifest,
      tools: Object.keys(tools).map((name) => ({ name, title: name, description: name, sideEffect })),
    },
    tools,
  })
  const world = fixture(definition, overrides, { script, start: processes.factory })
  return {
    ...world,
    processes,
    run: (tool: string, input: unknown = {}) => world.host.call({ ...call, tool, input }),
  }
}

describe('a tool in QuickJS', () => {
  it('reaches the session and the page only through capability calls', async () => {
    const w = await inQuickJS(HONEST, honestTools)
    expect(await w.run('read_trolley')).toEqual({
      status: 'ok',
      output: {
        ensured: { status: 'ok' },
        body: { items: [{ name: 'Milk', quantity: 2 }] },
        url: w.page.currentUrl(),
      },
    })
    expect(w.page.toolFetches()).toContain(`${HOME}/api/trolley`)
    expect(w.processes.started()).toBe(2)
  })

  it('drives the page, asks the person, and carries errors as the vm worker does', async () => {
    const w = await inQuickJS(HONEST, honestTools)
    w.page.extractResult = 'Fresh milk'
    w.page.evaluateResult = 2
    expect(await w.run('navigate', { url: `${HOME}/shop` })).toEqual({
      status: 'ok',
      output: { extracted: 'Fresh milk', evaluated: 2, url: `${HOME}/shop` },
    })
    expect(await w.run('ask', { note: 'Swap to the 2L?' })).toEqual({ status: 'ok', output: true })
    expect(await w.run('caught')).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'host-not-allowed',
    })
    expect(await w.run('throws_valet')).toEqual({
      status: 'failed',
      stage: 'tool-run',
      errorClass: 'unexpected-shape',
    })
    expect(await w.run('throws_needs_user')).toEqual({ status: 'needsUser', reason: 'captcha' })
    expect(await w.run('throws_plain')).toEqual({
      status: 'failed',
      stage: 'tool-run',
      errorClass: 'internal',
    })
    expect(await w.run('returns_nothing')).toEqual({ status: 'ok', output: undefined })
  })

  it('gets a fresh runtime for every call', async () => {
    const w = await inQuickJS(HOSTILE, hostileTools)
    expect(await w.run('remember')).toEqual({ status: 'ok', output: null })
    expect(await w.run('remember')).toEqual({ status: 'ok', output: null })
  })
})

describe('escape attempts from tool code in QuickJS', () => {
  it('finds no Node, no network, no timers, no shared memory and no WebAssembly', async () => {
    const w = await inQuickJS(HOSTILE, hostileTools)
    const result = await w.run('globals')
    const found = (result as { output: Record<string, string> }).output
    for (const [name, type] of Object.entries(found)) expect([name, type]).toEqual([name, 'undefined'])
  })

  it('finds none of quickjs-ng’s own extras', async () => {
    const w = await inQuickJS(SANDBOX, sandboxTools)
    const result = await w.run('quickjs_globals')
    const found = (result as { output: Record<string, string> }).output
    for (const [name, type] of Object.entries(found)) expect([name, type]).toEqual([name, 'undefined'])
  })

  it('can’t compile strings or climb a constructor chain, as in the vm worker', async () => {
    const w = await inQuickJS(SANDBOX, sandboxTools)
    expect(await w.run('compile_and_look')).toEqual({
      status: 'ok',
      output: {
        process: 'threw EvalError',
        require: 'threw EvalError',
        hostFunction: 'threw EvalError',
        importMeta: 'threw EvalError',
      },
    })
    const hostile = await inQuickJS(HOSTILE, hostileTools)
    expect(await hostile.run('constructors')).toEqual({
      status: 'ok',
      output: {
        globalThis: 'threw EvalError',
        page: 'threw EvalError',
        confirm: 'threw EvalError',
        ensure: 'threw EvalError',
        eval: 'threw EvalError',
        functionCtor: 'threw EvalError',
        asyncFunction: 'threw EvalError',
      },
    })
  })

  it('can’t import a module', async () => {
    const w = await inQuickJS(HOSTILE, hostileTools)
    const result = await w.run('dynamic_import')
    expect((result as { output: string }).output).toMatch(/^threw /)
  })

  it('can’t reach the host through a capability’s error, or keep a polluted prototype', async () => {
    const w = await inQuickJS(HOSTILE, hostileTools)
    expect(await w.run('error_escape')).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'host-not-allowed',
    })
    expect(await w.run('pollute')).toEqual({
      status: 'ok',
      output: { report: { kept: 'yes' }, body: { items: [{ name: 'Milk', quantity: 2 }] } },
    })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(await w.run('odd_arguments')).toEqual({
      status: 'ok',
      output: ['tool-run/invalid', 'sent', 'sent'],
    })
    expect(await w.run('cyclic_output')).toEqual({
      status: 'failed',
      stage: 'tool-output',
      errorClass: 'invalid',
    })
  })

  it('fails a call that floods the host with capability calls', async () => {
    const w = await inQuickJS(HOSTILE, hostileTools, {
      sleep: systemSleep,
      pacingSleep: systemSleep,
      timeoutMs: 20_000,
    })
    expect(await w.run('flood')).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'invalid' })
  })

  it('stops a loop that never yields at the slice deadline', async () => {
    const w = await inQuickJS(
      HOSTILE,
      hostileTools,
      { sleep: systemSleep, pacingSleep: systemSleep, timeoutMs: 20_000 },
      {
        limits: { memoryBytes: 64 * 1024 * 1024, stackBytes: 512 * 1024, sliceMs: 200 },
      },
    )
    const started = Date.now()
    expect(await w.run('spin')).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'internal' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('stops an unbounded promise chain at the slice deadline', async () => {
    const w = await inQuickJS(
      SANDBOX,
      sandboxTools,
      { sleep: systemSleep, pacingSleep: systemSleep, timeoutMs: 20_000 },
      {
        limits: { memoryBytes: 64 * 1024 * 1024, stackBytes: 512 * 1024, sliceMs: 200 },
      },
    )
    expect(await w.run('promise_storm')).toEqual({
      status: 'failed',
      stage: 'tool-run',
      errorClass: 'internal',
    })
  })

  it('stops a memory bomb at the heap limit', async () => {
    const w = await inQuickJS(
      SANDBOX,
      sandboxTools,
      { sleep: systemSleep, pacingSleep: systemSleep, timeoutMs: 20_000 },
      {
        limits: { memoryBytes: 32 * 1024 * 1024, stackBytes: 512 * 1024, sliceMs: 5_000 },
      },
    )
    expect(await w.run('memory_bomb')).toEqual({
      status: 'failed',
      stage: 'tool-run',
      errorClass: 'internal',
    })
  })

  it('turns a stack bomb into an error tool code sees', async () => {
    const w = await inQuickJS(SANDBOX, sandboxTools)
    expect(await w.run('stack_bomb')).toEqual({ status: 'ok', output: 'threw RangeError' })
  })

  it('gets not-granted for every local capability when no exceptions are wired', async () => {
    const w = await inQuickJS(SANDBOX, sandboxTools)
    expect(await w.run('probe_local')).toEqual({
      status: 'ok',
      output: {
        list: 'tool-run/not-granted',
        fetch: 'tool-run/not-granted',
        service: 'tool-run/not-granted',
        run: 'tool-run/not-granted',
        appleScript: 'tool-run/not-granted',
      },
    })
  })
})

describe('openQuickJSRun', () => {
  it('answers a script that fails to load with other, and ignores what comes after', () => {
    const sent: string[] = []
    const run = openQuickJSRun(module, 'throw new Error("no")', (t) => sent.push(t))
    run.deliver(JSON.stringify({ t: 'describe' }))
    expect(sent.map((t) => JSON.parse(t))).toEqual([{ t: 'done', ok: false, error: { kind: 'other' } }])
    expect(run.broken).toBe(false)
    run.dispose()
    run.dispose()
  })

  it('reports a script that defines no tools', () => {
    const sent: string[] = []
    const run = openQuickJSRun(module, 'var __valetTools = undefined', (t) => sent.push(t))
    expect(sent.map((t) => JSON.parse(t))).toEqual([{ t: 'done', ok: false, error: { kind: 'other' } }])
    run.dispose()
  })

  it('breaks on a script that never finishes loading, and says so once', () => {
    const sent: string[] = []
    let broken = 0
    let clock = 0
    const run = openQuickJSRun(module, 'for (;;) {}', (t) => sent.push(t), {
      limits: { memoryBytes: 16 * 1024 * 1024, stackBytes: 256 * 1024, sliceMs: 50 },
      now: () => (clock += 10),
      onBroken: () => broken++,
    })
    expect(run.broken).toBe(true)
    expect(broken).toBe(1)
    expect(sent.map((t) => JSON.parse(t))).toEqual([{ t: 'done', ok: false, error: { kind: 'other' } }])
    run.deliver(JSON.stringify({ t: 'describe' }))
    expect(sent).toHaveLength(1)
  })
})

describe('the built-in adapters in QuickJS', () => {
  it('describe exactly as they do in the vm worker', async () => {
    const { describeIsolated } = await import('../../runtime/src/isolation/host')
    const { inMemory } = await import('../../runtime/test/isolation/processes')
    for (const adapter of ['woolworths', 'yahoo-finance', 'wikipedia']) {
      const script = await scriptFor(join(import.meta.dirname, `../../../adapters/${adapter}/src/tools.ts`))
      const inVm = await describeIsolated(inMemory().start, script)
      const inQuick = await describeIsolated(inProcessQuickJS(factory), script)
      expect(Object.keys(inQuick).length).toBeGreaterThan(0)
      expect(inQuick).toEqual(inVm)
    }
  }, 30_000)
})
