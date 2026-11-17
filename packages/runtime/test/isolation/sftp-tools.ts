// Tool code for the SFTP adapter's isolation tests, built into a tool script by buildToolScript.

import { type ToolContext, tool } from '@valet/core'
import { z } from 'zod'

const sftp = (ctx: ToolContext) => {
  if (ctx.sftp === undefined) throw new Error('no ctx.sftp')
  return ctx.sftp
}

export const tools = {
  read_files: tool({
    input: z.object({ do: z.string().optional() }),
    output: z.unknown(),
    run: async (ctx: ToolContext, input: { do?: string }) => {
      if (input.do === 'list') return sftp(ctx).list('/docs')
      if (input.do === 'read') return sftp(ctx).read('/docs/a.txt', { encoding: 'utf8' })
      if (input.do === 'write') return sftp(ctx).write('/inbox/a.txt', 'x')
      if (input.do === 'escape') return sftp(ctx).read('/docs/../private/key')
      if (input.do === 'raw') {
        // Reaching past the typed methods: the channel only carries known operations.
        const access = sftp(ctx) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
        return access['op']?.('remove', ['/docs/a.txt']) ?? 'no raw op'
      }
      return null
    },
  }),
  file_files: tool({
    input: z.object({ do: z.string().optional() }),
    output: z.unknown(),
    run: async (ctx: ToolContext) => sftp(ctx).write('/inbox/a.txt', 'x'),
  }),
}
