// Tool code in its own process (overnight queue item 7, M3). The tool script runs in a fresh
// node:vm context per call, in a process the host starts per call and kills when the call ends,
// and reaches the page, the session and the person only through JSON capability calls answered by
// the same guarded context an in-process tool gets. The hostile tools try the escapes listed in
// docs/registry-and-sandbox.md#proving-it that apply before M7's sandbox exists.

import { type AdapterDefinition, defineAdapter, type ToolDeclaration, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { systemSleep } from '../src/clock'
import { runIsolated, type ToolChannel } from '../src/isolation/host'
import { decodeError, encodeError, isPlainJson, MAX_IN_FLIGHT, withinSize } from '../src/isolation/protocol'
import { buildToolScript } from '../src/isolation/tool-script'
import { evaluateToolScript } from '../src/isolation/worker'
import type { ToolHostOptions } from '../src/tool-host'
import { json } from './fakes'
import { call, fixture, HOME, manifest } from './fixtures'
import { tools as honestTools } from './isolation/honest-tools'
import { tools as hostileTools } from './isolation/hostile-tools'
import { childProcess, HONEST, HOSTILE, inMemory, scriptFor } from './isolation/processes'

/** How the fixture's guarded page refuses https://evil.test. */
const REFUSED = 'host-not-allowed'

function adapter(tools: AdapterDefinition['tools'], sideEffect: ToolDeclaration['sideEffect'] = 'write') {
  return defineAdapter({
    manifest: {
      ...manifest,
      tools: Object.keys(tools).map((name) => ({ name, title: name, description: name, sideEffect })),
    },
    tools,
  })
}

async function isolated(
  entry: string,
  tools: AdapterDefinition['tools'],
  processes = inMemory(),
  overrides: Partial<ToolHostOptions> = {},
) {
  const script = await scriptFor(entry)
  const world = fixture(adapter(tools), overrides, { script, start: processes.start })
  return {
    ...world,
    processes,
    run: (tool: string, input: unknown = {}) => world.host.call({ ...call, tool, input }),
  }
}

describe('an isolated tool', () => {
  it('reaches the session and the page only through capability calls, with the page’s URL kept current', async () => {
    const w = await isolated(HONEST, honestTools)
    expect(await w.run('read_trolley')).toEqual({
      status: 'ok',
      output: {
        ensured: { status: 'ok' },
        body: { items: [{ name: 'Milk', quantity: 2 }] },
        url: w.page.currentUrl(),
      },
    })
    expect(w.page.toolFetches()).toContain(`${HOME}/api/trolley`)
    // One process for the call, ended with it.
    expect(w.processes.channels).toHaveLength(1)
    expect(w.processes.killed()).toBe(1)
  })

  it('drives the page with every capability', async () => {
    const w = await isolated(HONEST, honestTools)
    w.page.extractResult = 'Fresh milk'
    w.page.evaluateResult = 2
    const result = await w.run('navigate', { url: `${HOME}/shop` })
    expect(result).toEqual({
      status: 'ok',
      output: { extracted: 'Fresh milk', evaluated: 2, url: `${HOME}/shop` },
    })
  })

  it('asks the person through ctx.confirm, under C4’s checks', async () => {
    const w = await isolated(HONEST, honestTools)
    expect(await w.run('ask', { note: 'Swap to the 2L?' })).toEqual({ status: 'ok', output: true })
    expect(w.prompt.requests[0]).toMatchObject({ kind: 'tool-request', note: 'Swap to the 2L?' })
  })

  it('gets a guard’s refusal as its own ValetError, and the refusal still sticks', async () => {
    const w = await isolated(HONEST, honestTools)
    expect(await w.run('caught')).toEqual({ status: 'failed', stage: 'request-surface', errorClass: REFUSED })
  })

  it('carries what tool code throws as a stage and class or a reason, and nothing else', async () => {
    const w = await isolated(HONEST, honestTools)
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
    expect(JSON.stringify(w.audit.events)).not.toContain('secret-looking')
  })

  it('validates the output in the host, as for an in-process tool', async () => {
    const w = await isolated(HONEST, honestTools)
    expect(await w.run('returns_nothing')).toEqual({ status: 'ok', output: undefined })
  })

  it('starts a fresh process, and a fresh context, for every call', async () => {
    const w = await isolated(HOSTILE, hostileTools)
    expect(await w.run('remember')).toEqual({ status: 'ok', output: null })
    expect(await w.run('remember')).toEqual({ status: 'ok', output: null })
    expect(w.processes.channels).toHaveLength(2)
  })
})

describe('escape attempts from isolated tool code', () => {
  it('finds no Node, no network, no timers and no shared memory', async () => {
    const w = await isolated(HOSTILE, hostileTools)
    const result = await w.run('globals')
    expect(result.status).toBe('ok')
    const found = (result as { output: Record<string, string> }).output
    for (const [name, type] of Object.entries(found)) expect([name, type]).toEqual([name, 'undefined'])
  })

  it('can’t compile strings or climb a constructor chain to the host', async () => {
    const w = await isolated(HOSTILE, hostileTools)
    const result = await w.run('constructors')
    expect(result).toEqual({
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

  it('can’t import a module at run time', async () => {
    const w = await isolated(HOSTILE, hostileTools)
    const result = await w.run('dynamic_import')
    expect(result).toMatchObject({ status: 'ok' })
    expect((result as { output: string }).output).toMatch(/^threw /)
  })

  it('can’t reach the host through an error a capability threw', async () => {
    const w = await isolated(HOSTILE, hostileTools)
    expect(await w.run('error_escape')).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: REFUSED,
    })
  })

  it('can’t replace a capability, and polluting its own prototypes stays in its context', async () => {
    const w = await isolated(HOSTILE, hostileTools)
    const result = await w.run('pollute')
    expect(result).toEqual({
      status: 'ok',
      output: { report: { kept: 'yes' }, body: { items: [{ name: 'Milk', quantity: 2 }] } },
    })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('sends a cyclic argument nowhere; a getter or a proxy crosses only as the data it reads as', async () => {
    const w = await isolated(HOSTILE, hostileTools)
    expect(await w.run('odd_arguments')).toEqual({
      status: 'ok',
      output: ['tool-run/invalid', 'sent', 'sent'],
    })
  })

  it('fails a call that floods the host with capability calls, and stops the process', async () => {
    // Real time, so the pacing that holds the clicks back isn't what ends the call.
    const w = await isolated(HOSTILE, hostileTools, inMemory(), {
      sleep: systemSleep,
      pacingSleep: systemSleep,
      timeoutMs: 20_000,
    })
    expect(await w.run('flood')).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'invalid' })
    expect(w.page.toolFetches().length).toBeLessThanOrEqual(MAX_IN_FLIGHT)
    expect(w.processes.killed()).toBe(1)
  })

  it('fails output that isn’t JSON', async () => {
    const w = await isolated(HOSTILE, hostileTools)
    expect(await w.run('cyclic_output')).toEqual({
      status: 'failed',
      stage: 'tool-output',
      errorClass: 'invalid',
    })
  })
})

describe('the tool process as a real child process', () => {
  it('runs a tool, then is gone', async () => {
    const processes = childProcess()
    const w = await isolated(HONEST, honestTools, processes)
    expect(await w.run('read_trolley')).toMatchObject({ status: 'ok' })
    expect(processes.killed()).toBe(1)
  }, 30_000)

  it('is killed at the deadline when tool code never yields, and the next call gets a new one', async () => {
    const processes = childProcess()
    const script = await scriptFor(HOSTILE)
    const w = fixture(
      adapter(hostileTools),
      { sleep: systemSleep, timeoutMs: 3_000 },
      { script, start: processes.start },
    )
    expect(await w.host.call({ ...call, tool: 'spin', input: {} })).toEqual({
      status: 'failed',
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(processes.killed()).toBe(1)
    expect(await w.host.call({ ...call, callId: 'call-2', tool: 'remember', input: {} })).toEqual({
      status: 'ok',
      output: null,
    })
    expect(processes.pids).toHaveLength(2)
  }, 30_000)
})

describe('runIsolated against a hostile channel', () => {
  // A channel whose "process" sends `messages` once it is given the run.
  function scripted(...messages: unknown[]) {
    let listener: (message: unknown) => void = () => {}
    let exit: () => void = () => {}
    const sent: unknown[] = []
    let killed = false
    const channel: ToolChannel = {
      send: (message) => {
        sent.push(message)
        if (message.t === 'run') for (const m of messages) queueMicrotask(() => listener(m))
      },
      onMessage: (l) => {
        listener = l
      },
      onExit: (l) => {
        exit = l
      },
      kill: () => {
        killed = true
      },
    }
    return { channel, sent, exit: () => exit(), killed: () => killed }
  }

  const ctx = (signal = new AbortController().signal) => {
    const w = fixture(adapter(honestTools))
    return {
      w,
      ctx: {
        page: {
          goto: async () => {},
          currentUrl: () => `${HOME}/`,
          click: async () => {},
          fill: async () => {},
          extract: async () => null,
          evaluate: async () => () => 'a function',
          fetch: async () => ({ status: 200, contentType: null, body: null }),
        },
        session: { ensure: async () => ({ status: 'ok' as const }) },
        confirm: async () => true,
        signal,
      },
    }
  }

  const run = (messages: unknown[], signal?: AbortSignal) => {
    const s = scripted(...messages)
    const { ctx: c } = ctx(signal)
    const result = runIsolated(() => s.channel, 'script', c, 'read_trolley', {}).then(
      (value) => ({ ok: value }),
      (error: unknown) => ({
        error: error instanceof ValetError ? `${error.stage}/${error.errorClass}` : String(error),
      }),
    )
    return { s, result }
  }

  it.each([
    ['a function', { t: 'done', ok: true, value: () => 1 }],
    ['a Map', { t: 'done', ok: true, value: new Map() }],
    ['a prototype-bearing object', { t: 'done', ok: true, value: new (class Evil {})() }],
    ['an unknown message', { t: 'shell', command: 'rm -rf /' }],
    ['an unknown capability', { t: 'call', id: 1, capability: 'process.exit', args: [] }],
    [
      'a capability with too many arguments',
      { t: 'call', id: 1, capability: 'page.goto', args: [1, 2, 3, 4] },
    ],
    ['a non-integer id', { t: 'call', id: 1.5, capability: 'page.goto', args: ['/'] }],
    ['an oversized message', { t: 'done', ok: true, value: 'x'.repeat(4_000_001) }],
  ])('ends the run as tool-run/invalid on %s, and kills the process', async (_what, message) => {
    const { s, result } = run([message])
    expect(await result).toEqual({ error: 'tool-run/invalid' })
    expect(s.killed()).toBe(true)
  })

  it('refuses a reused call id', async () => {
    const { result } = run([
      { t: 'call', id: 7, capability: 'session.ensure', args: [] },
      { t: 'call', id: 7, capability: 'session.ensure', args: [] },
    ])
    expect(await result).toEqual({ error: 'tool-run/invalid' })
  })

  it('answers a capability whose result isn’t JSON with an error, not the value', async () => {
    const { s, result } = run([{ t: 'call', id: 1, capability: 'page.evaluate', args: ['x'] }])
    await new Promise((r) => setTimeout(r, 10))
    expect(s.sent.at(-1)).toMatchObject({
      t: 'reply',
      id: 1,
      ok: false,
      error: { kind: 'valet', stage: 'tool-run', errorClass: 'unexpected-shape' },
    })
    s.exit()
    expect(await result).toEqual({ error: 'tool-run/internal' })
  })

  it('refuses a selector that isn’t a string before any guard sees it', async () => {
    const { s } = run([
      { t: 'call', id: 1, capability: 'page.click', args: [{ toString: 'x' }] },
      { t: 'call', id: 2, capability: 'page.fill', args: ['#q', 5] },
    ])
    await new Promise((r) => setTimeout(r, 10))
    expect(s.sent.filter((m) => (m as { t: string }).t === 'reply')).toMatchObject([
      { id: 1, ok: false, error: { kind: 'valet', errorClass: 'invalid' } },
      { id: 2, ok: false, error: { kind: 'valet', errorClass: 'invalid' } },
    ])
  })

  it('ends the run as tool-run/internal when the process exits first', async () => {
    const { s, result } = run([])
    await Promise.resolve()
    s.exit()
    expect(await result).toEqual({ error: 'tool-run/internal' })
  })

  it('takes a thrown error only from the fixed vocabularies', async () => {
    for (const [error, expected] of [
      [{ kind: 'valet', stage: 'tool-run', errorClass: 'rate-limited' }, 'tool-run/rate-limited'],
      [{ kind: 'valet', stage: 'rm -rf', errorClass: 'rate-limited' }, 'Error: tool code failed'],
      [{ kind: 'needsUser', reason: 'made-up' }, 'Error: tool code failed'],
    ] as const) {
      const { result } = run([{ t: 'done', ok: false, error }])
      expect(await result).toEqual({ error: expected })
    }
  })

  it('kills the process when the call is aborted, and tells it first', async () => {
    const controller = new AbortController()
    const { s, result } = run([], controller.signal)
    await Promise.resolve()
    controller.abort()
    expect(await result).toEqual({ error: 'tool-run/aborted' })
    expect(s.sent.at(-1)).toEqual({ t: 'abort' })
    expect(s.killed()).toBe(true)
  })

  it('starts nothing for a call already aborted, and fails closed when the process can’t start', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx: c } = ctx(controller.signal)
    await expect(runIsolated(() => scripted().channel, 's', c, 't', {})).rejects.toMatchObject({
      errorClass: 'aborted',
    })
    const { ctx: live } = ctx()
    await expect(
      runIsolated(
        () => {
          throw new Error('no process')
        },
        's',
        live,
        't',
        {},
      ),
    ).rejects.toMatchObject({ errorClass: 'internal' })
  })
})

describe('the protocol', () => {
  it('accepts only plain JSON', () => {
    expect(isPlainJson({ a: [1, 'b', null, true, { c: {} }] })).toBe(true)
    expect(isPlainJson(Object.create(null))).toBe(true)
    const shared = { x: 1 }
    expect(isPlainJson([shared, shared])).toBe(true)
    for (const bad of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      Symbol('s'),
      () => 1,
      new Date(),
      Object.defineProperty({}, 'x', { get: () => 1, enumerable: true }),
      { [Symbol('k')]: 1 },
      Object.setPrototypeOf([], null),
    ]) {
      expect(isPlainJson(bad)).toBe(false)
    }
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(isPlainJson(cyclic)).toBe(false)
    let deep: unknown = 1
    for (let i = 0; i < 100; i++) deep = [deep]
    expect(isPlainJson(deep)).toBe(false)
    expect(isPlainJson(new Array(300_000).fill(0))).toBe(false)
    expect(withinSize('x'.repeat(10))).toBe(true)
  })

  it('round-trips errors through the vocabularies', () => {
    expect(decodeError(encodeError(new ValetError('egress', 'host-not-allowed')))).toMatchObject({
      stage: 'egress',
      errorClass: 'host-not-allowed',
    })
    expect(encodeError(new Error('x'))).toEqual({ kind: 'other' })
    expect(decodeError(null)).toBeInstanceOf(Error)
  })
})

describe('the tool script', () => {
  it('builds the Woolworths tools with no Node or Electron in them', async () => {
    const script = await buildToolScript(`${import.meta.dirname}/../../../adapters/woolworths/src/tools.ts`)
    const sent: string[] = []
    const deliver = evaluateToolScript(script, (text) => sent.push(text))
    deliver(JSON.stringify({ t: 'run', tool: 'get_cart', input: {}, url: `${HOME}/` }))
    await new Promise((r) => setTimeout(r, 20))
    // get_cart's first act is to make sure the session is logged in.
    expect(JSON.parse(sent[0] ?? '{}')).toEqual({ t: 'call', id: 1, capability: 'session.ensure', args: [] })
  })

  it.each([
    ['node:fs', "import { readFileSync } from 'node:fs'\nexport const tools = { t: readFileSync }"],
    ['fs', "import fs from 'fs'\nexport const tools = { t: fs }"],
    ['child_process', "import cp from 'child_process'\nexport const tools = { t: cp }"],
    ['electron', "import { app } from 'electron'\nexport const tools = { t: app }"],
  ])('refuses tool code that imports %s', async (_name, source) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(`${tmpdir()}/valet-tool-script-`)
    try {
      await writeFile(`${dir}/tools.ts`, source)
      await expect(buildToolScript(`${dir}/tools.ts`)).rejects.toThrow(/tool code may not import/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a script that fails to evaluate, or that defines no tools', () => {
    for (const script of ['throw new Error("boom")', 'var x = 1']) {
      const sent: string[] = []
      evaluateToolScript(script, (text) => sent.push(text)).call(
        null,
        JSON.stringify({ t: 'run', tool: 'x', input: {} }),
      )
      expect(JSON.parse(sent[0] ?? '{}')).toEqual({ t: 'done', ok: false, error: { kind: 'other' } })
    }
  })

  it('refuses a tool the script doesn’t have', async () => {
    const sent: string[] = []
    const deliver = evaluateToolScript(await scriptFor(HONEST), (text) => sent.push(text))
    deliver(JSON.stringify({ t: 'run', tool: 'constructor', input: {} }))
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      ok: false,
      error: { stage: 'manifest', errorClass: 'not-found' },
    })
  })
})

// json is used by the fixture's own routes; keep the import honest.
void json
