// Tool code for the protocol adapter's isolation tests, built into a tool script by buildToolScript.

import { type ToolContext, tool } from '@valet/core'
import { z } from 'zod'

const imap = (ctx: ToolContext) => {
  if (ctx.imap === undefined) throw new Error('no ctx.imap')
  return ctx.imap
}

export const tools = {
  read_mail: tool({
    input: z.object({ do: z.string().optional() }),
    output: z.unknown(),
    run: async (ctx: ToolContext, input: { do?: string }) => {
      if (input.do === 'search') return imap(ctx).search('INBOX', { seen: false }, { limit: 5 })
      if (input.do === 'message') return imap(ctx).message('INBOX', 7)
      if (input.do === 'move') return imap(ctx).move('INBOX', [1], 'Receipts')
      if (input.do === 'raw') {
        // Reaching past the typed methods: the channel only carries known operations.
        const access = imap(ctx) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
        return access['op']?.('deleteFolder', ['INBOX']) ?? 'no raw op'
      }
      return null
    },
  }),
  file_mail: tool({
    input: z.object({ do: z.string().optional() }),
    output: z.unknown(),
    run: async (ctx: ToolContext) => imap(ctx).move('INBOX', [1], 'Receipts'),
  }),
}
