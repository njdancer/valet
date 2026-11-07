// Tool code that tries to get out of the isolated tool process's context. Each probe reports what
// it found; the tests assert every way out is closed. Built into a tool script by buildToolScript,
// which would refuse a static import of a Node built-in, so the probes reach for them at run time.

import { type ToolContext, tool } from '@valet/core'
import { z } from 'zod'

type Probe = () => unknown

function attempt(probe: Probe): string {
  try {
    const value = probe()
    return value === undefined ? 'undefined' : typeof value
  } catch (error) {
    return `threw ${(error as { name?: string })?.name ?? 'something'}`
  }
}

const g = globalThis as Record<string, unknown>

export const tools = {
  globals: tool({
    input: z.object({}),
    output: z.record(z.string(), z.string()),
    run: async () => {
      const names = [
        'require',
        'process',
        'module',
        'Buffer',
        'fetch',
        'WebSocket',
        'XMLHttpRequest',
        'RTCPeerConnection',
        'Worker',
        'setTimeout',
        'setInterval',
        'queueMicrotask',
        'SharedArrayBuffer',
        'Atomics',
        'WebAssembly',
        'console',
      ]
      return Object.fromEntries(names.map((name) => [name, typeof g[name]]))
    },
  }),
  constructors: tool({
    input: z.object({}),
    output: z.record(z.string(), z.string()),
    run: async (ctx: ToolContext) => {
      const make = (f: unknown) => () =>
        (f as { constructor: FunctionConstructor }).constructor('return process')()
      return {
        globalThis: attempt(make(globalThis.constructor)),
        page: attempt(make(ctx.page.fetch)),
        confirm: attempt(make(ctx.confirm)),
        ensure: attempt(make(ctx.session.ensure)),
        // biome-ignore lint/security/noGlobalEval: the escape attempt under test
        eval: attempt(() => (0, eval)('process')),
        functionCtor: attempt(() => Function('return process')()),
        asyncFunction: attempt(make(async () => {})),
      }
    },
  }),
  dynamic_import: tool({
    input: z.object({}),
    output: z.string(),
    run: async () => {
      const specifier = ['node', 'fs'].join(':')
      try {
        await import(/* @vite-ignore */ specifier)
        return 'imported'
      } catch (error) {
        return `threw ${(error as { name?: string })?.name ?? 'something'}`
      }
    },
  }),
  error_escape: tool({
    input: z.object({}),
    output: z.string(),
    run: async (ctx: ToolContext) => {
      // An error from a capability is the context's own class, so its constructor chain stays inside.
      try {
        await ctx.page.fetch('https://evil.test/')
        return 'fetched'
      } catch (error) {
        return attempt(() =>
          (error as { constructor: FunctionConstructor }).constructor.constructor('return process')(),
        )
      }
    },
  }),
  pollute: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async (ctx: ToolContext) => {
      const report: Record<string, string> = {}
      const original = ctx.page.fetch
      try {
        ;(ctx.page as { fetch: unknown }).fetch = () => 'mine'
      } catch {
        // Strict code throws; sloppy code is ignored. Either way the capability stays.
      }
      report['kept'] = ctx.page.fetch === original ? 'yes' : 'no'
      ;(Object.prototype as Record<string, unknown>)['polluted'] = 'yes'
      ;(Array.prototype as unknown as Record<string, unknown>)['polluted'] = 'yes'
      const response = await ctx.page.fetch('/api/trolley')
      return { report, body: response.body }
    },
  }),
  odd_arguments: tool({
    input: z.object({}),
    output: z.array(z.string()),
    run: async (ctx: ToolContext) => {
      const out: string[] = []
      const cyclic: Record<string, unknown> = {}
      cyclic['self'] = cyclic
      const getter = Object.defineProperty({}, 'method', { get: () => 'GET', enumerable: true })
      for (const init of [cyclic, getter, new Proxy({}, {})]) {
        out.push(
          await ctx.page.fetch('/api/trolley', init as never).then(
            () => 'sent',
            (e: { stage?: string; errorClass?: string }) => `${e.stage}/${e.errorClass}`,
          ),
        )
      }
      return out
    },
  }),
  flood: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async (ctx: ToolContext) => {
      // Clicks wait their turn under the site's pacing, so they pile up in flight.
      await Promise.all(Array.from({ length: 10_000 }, () => ctx.page.click('#add')))
      return 'done'
    },
  }),
  spin: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async () => {
      for (;;) {
        // Never yields: only killing the process ends this.
      }
    },
  }),
  remember: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async () => {
      const seen = g['__valetMemory'] ?? null
      g['__valetMemory'] = 'from an earlier run'
      return seen
    },
  }),
  cyclic_output: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async () => {
      const out: Record<string, unknown> = {}
      out['self'] = out
      return out
    },
  }),
}
