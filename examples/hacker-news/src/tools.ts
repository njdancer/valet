// The example http adapter (docs/adapter-kinds.md#h-example-adapters): Hacker News's public
// Firebase API, read with ctx.http. No page, no login and no workaround: each list is one request
// and each story one more. The manifest's two request patterns are everything it can ask for.

import { type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { plainText } from './text'

const HOST = 'https://hacker-news.firebaseio.com'
const LISTS = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
  ask: 'askstories',
  show: 'showstories',
  jobs: 'jobstories',
} as const

const story = z.object({
  id: z.number(),
  kind: z.enum(['story', 'job', 'poll']),
  title: z.string(),
  /** The story's own link, or null for Ask HN and other text posts. */
  url: z.string().nullable(),
  by: z.string().nullable(),
  points: z.number().nullable(),
  comments: z.number().nullable(),
  /** ISO 8601. */
  time: z.string().nullable(),
  /** The Hacker News page for it. */
  discussion: z.string(),
})

interface Item {
  id?: unknown
  type?: unknown
  by?: unknown
  time?: unknown
  title?: unknown
  url?: unknown
  text?: unknown
  score?: unknown
  descendants?: unknown
  kids?: unknown
  deleted?: unknown
  dead?: unknown
}

async function getJson(ctx: ToolContext, path: string): Promise<unknown> {
  if (ctx.http === undefined) throw new ValetError('tool-run', 'not-granted')
  const response = await ctx.http.fetch(`${HOST}${path}`, { headers: { accept: 'application/json' } })
  if (response.status === 429) throw new ValetError('tool-run', 'rate-limited')
  if (response.status !== 200) throw new ValetError('tool-run', 'unavailable')
  try {
    return JSON.parse(response.body)
  } catch {
    throw new ValetError('tool-run', 'unexpected-shape')
  }
}

async function getItem(ctx: ToolContext, id: number): Promise<Item | null> {
  const body = await getJson(ctx, `/v0/item/${id}.json`)
  if (body === null) return null
  if (typeof body !== 'object' || Array.isArray(body)) throw new ValetError('tool-run', 'unexpected-shape')
  return body as Item
}

/** A story as the tools return it, or null for a deleted, dead or non-story item. Pure. */
export function toStory(item: Item): z.infer<typeof story> | null {
  if (item.deleted === true || item.dead === true) return null
  if (item.type !== 'story' && item.type !== 'job' && item.type !== 'poll') return null
  if (typeof item.id !== 'number' || typeof item.title !== 'string') return null
  return {
    id: item.id,
    kind: item.type,
    title: item.title.slice(0, 300),
    url: typeof item.url === 'string' && /^https?:\/\//.test(item.url) ? item.url.slice(0, 2000) : null,
    by: typeof item.by === 'string' ? item.by.slice(0, 40) : null,
    points: typeof item.score === 'number' ? item.score : null,
    comments: typeof item.descendants === 'number' ? item.descendants : null,
    time: typeof item.time === 'number' ? new Date(item.time * 1000).toISOString() : null,
    discussion: `https://news.ycombinator.com/item?id=${item.id}`,
  }
}

function ids(value: unknown): number[] {
  if (!Array.isArray(value)) throw new ValetError('tool-run', 'unexpected-shape')
  return value.filter((v): v is number => Number.isSafeInteger(v) && v > 0)
}

export const tools = {
  list_stories: tool({
    input: z.object({
      list: z.enum(['top', 'new', 'best', 'ask', 'show', 'jobs']).default('top'),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    output: z.object({ stories: z.array(story) }),
    async run(ctx, input) {
      const all = ids(await getJson(ctx, `/v0/${LISTS[input.list]}.json`))
      const stories: z.infer<typeof story>[] = []
      // One request per story, in list order; deleted and dead ones are skipped, not replaced, so
      // a run never asks for more than limit + 1 things.
      for (const id of all.slice(0, input.limit)) {
        const item = await getItem(ctx, id)
        const s = item === null ? null : toStory(item)
        if (s !== null) stories.push(s)
      }
      return { stories }
    },
  }),

  get_story: tool({
    input: z.object({
      id: z.number().int().positive().max(1e10),
      comments: z.number().int().min(0).max(10).default(5),
    }),
    output: z.object({
      story,
      text: z.string().nullable(),
      comments: z.array(z.object({ id: z.number(), by: z.string().nullable(), text: z.string() })),
    }),
    async run(ctx, input) {
      const item = await getItem(ctx, input.id)
      const s = item === null ? null : toStory(item)
      if (item === null || s === null) throw new ValetError('tool-run', 'not-found')
      const comments: { id: number; by: string | null; text: string }[] = []
      const kids = item.kids === undefined ? [] : ids(item.kids)
      for (const id of kids.slice(0, input.comments)) {
        const kid = await getItem(ctx, id)
        if (kid === null || kid.deleted === true || kid.dead === true || typeof kid.text !== 'string')
          continue
        comments.push({
          id,
          by: typeof kid.by === 'string' ? kid.by.slice(0, 40) : null,
          text: plainText(kid.text),
        })
      }
      return { story: s, text: typeof item.text === 'string' ? plainText(item.text) : null, comments }
    },
  }),
}
