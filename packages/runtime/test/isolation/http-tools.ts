// Tool code for the http adapter's isolation tests, built into a tool script by buildToolScript.

import { parseFeed, type ToolContext, tool } from '@valet/core'
import { z } from 'zod'

const http = (ctx: ToolContext) => {
  if (ctx.http === undefined) throw new Error('no ctx.http')
  return ctx.http
}

export const tools = {
  read_it: tool({
    input: z.object({ do: z.string() }),
    output: z.unknown(),
    run: async (ctx: ToolContext, input: { do: string }) => {
      if (input.do === 'fetch') {
        const r = await http(ctx).fetch('/v1/items')
        return { status: r.status, items: JSON.parse(r.body).items.length }
      }
      if (input.do === 'socket') {
        const socket = await http(ctx).websocket('/ws/echo')
        await socket.send('hi there')
        const message = await socket.receive({ waitMs: 2000 })
        await socket.close()
        return message
      }
      if (input.do === 'close-twice') {
        // Closing again is nothing; using it after is unavailable, not a bad id.
        const socket = await http(ctx).websocket('/ws/echo')
        await socket.close()
        await socket.close()
        try {
          await socket.send('late')
          return 'sent'
        } catch (error) {
          return (error as { errorClass?: string }).errorClass
        }
      }
      if (input.do === 'feed') {
        const feed = parseFeed((await http(ctx).fetch('/feed.xml')).body)
        return feed.items.map((i) => i.title)
      }
      if (input.do === 'forbidden') return http(ctx).fetch('https://evil.example.test/v1/items')
      if (input.do === 'many-sockets') {
        for (let i = 0; i < 6; i++) await http(ctx).websocket('/ws/echo')
        return null
      }
      return null
    },
  }),
  write_it: tool({ input: z.object({}), output: z.unknown(), run: async () => null }),
}
