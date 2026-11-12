// Tool code that tries the escapes specific to QuickJS and to the sandbox's limits. Built into a
// tool script by buildToolScript, like the runtime's hostile tools.

import { type ToolContext, tool } from '@valet/core'
import { z } from 'zod'

const g = globalThis as Record<string, unknown>

export const tools = {
  quickjs_globals: tool({
    input: z.object({}),
    output: z.record(z.string(), z.string()),
    run: async () => {
      const names = [
        'std',
        'os',
        'gc',
        'print',
        'scriptArgs',
        'bjson',
        'performance',
        'navigator',
        'queueMicrotask',
      ]
      return Object.fromEntries(names.map((name) => [name, typeof g[name]]))
    },
  }),
  compile_and_look: tool({
    input: z.object({}),
    output: z.record(z.string(), z.string()),
    run: async () => {
      // Compiling more QuickJS code is allowed; it finds nothing more than tool code already has.
      const look = (source: string): string => {
        try {
          // biome-ignore lint/security/noGlobalEval: the escape attempt under test
          return typeof (0, eval)(source)
        } catch (error) {
          return `threw ${(error as { name?: string }).name}`
        }
      }
      return {
        process: look('process'),
        require: look('require'),
        hostFunction: look('(function(){}).constructor("return typeof process")()'),
        importMeta: look('typeof import.meta'),
      }
    },
  }),
  memory_bomb: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async () => {
      const hoard: number[][] = []
      for (let i = 0; ; i++) hoard.push(new Array(1 << 16).fill(i))
    },
  }),
  stack_bomb: tool({
    input: z.object({}),
    output: z.string(),
    run: async () => {
      const down = (n: number): number => down(n + 1) + 1
      try {
        down(0)
        return 'returned'
      } catch (error) {
        return `threw ${(error as { name?: string }).name}`
      }
    },
  }),
  promise_storm: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async () => {
      // An unbounded chain of microtasks: never yields to the host.
      const again = (): Promise<void> => Promise.resolve().then(again)
      await again()
    },
  }),
  read_file: tool({
    input: z.object({ path: z.string() }),
    output: z.string(),
    run: async (ctx: ToolContext, { path }) => {
      if (ctx.local === undefined) return 'no local'
      return ctx.local.files.read(path)
    },
  }),
  probe_local: tool({
    input: z.object({}),
    output: z.record(z.string(), z.string()),
    run: async (ctx: ToolContext): Promise<Record<string, string>> => {
      const local = ctx.local
      if (local === undefined) return { local: 'missing' }
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => 'allowed',
          (e: { stage?: string; errorClass?: string }) => `${e.stage}/${e.errorClass}`,
        )
      return {
        list: await outcome(local.files.list('~/Documents')),
        fetch: await outcome(local.fetch('https://example.com/')),
        service: await outcome(local.service(11434, '/')),
        run: await outcome(local.run([])),
        appleScript: await outcome(local.appleScript('com.apple.reminders', 'name')),
      }
    },
  }),
}
