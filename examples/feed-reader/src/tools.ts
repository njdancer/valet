// The example feed reader (docs/adapter-kinds.md#h-example-adapters): RSS from one host and Atom
// from another, each one request, read with parseFeed from @valet/core. A feed is just HTTP: the
// manifest declares the exact paths, and the tool code turns what comes back into plain text.

import { type Feed, parseFeed, type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { plainText } from './text'

const SECTIONS = {
  top: '/news/rss.xml',
  world: '/news/world/rss.xml',
  uk: '/news/uk/rss.xml',
  business: '/news/business/rss.xml',
  technology: '/news/technology/rss.xml',
  science: '/news/science_and_environment/rss.xml',
  health: '/news/health/rss.xml',
  entertainment: '/news/entertainment_and_arts/rss.xml',
} as const

/** GitHub's own rule for an owner or repository name. */
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/

const entry = z.object({
  title: z.string(),
  link: z.string().nullable(),
  /** ISO 8601, or null when the feed gives no date. */
  time: z.string().nullable(),
  summary: z.string(),
})

async function getFeed(ctx: ToolContext, url: string): Promise<Feed> {
  if (ctx.http === undefined) throw new ValetError('tool-run', 'not-granted')
  const response = await ctx.http.fetch(url, {
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9' },
  })
  if (response.status === 404) throw new ValetError('tool-input', 'not-found')
  if (response.status === 429) throw new ValetError('tool-run', 'rate-limited')
  if (response.status !== 200) throw new ValetError('tool-run', 'unavailable')
  try {
    return parseFeed(response.body)
  } catch {
    throw new ValetError('tool-run', 'unexpected-shape')
  }
}

/** One feed item as the tools return it: plain text, cut short, a link only if it is http(s). Pure. */
export function toEntry(item: Feed['items'][number], summaryChars: number): z.infer<typeof entry> {
  const link = item.link !== null && /^https?:\/\//.test(item.link) ? item.link.slice(0, 2000) : null
  return {
    title: plainText(item.title ?? '', 300),
    link,
    time: item.published ?? item.updated,
    summary: plainText(item.summary ?? item.content ?? '', summaryChars),
  }
}

export const tools = {
  get_headlines: tool({
    input: z.object({
      section: z
        .enum(Object.keys(SECTIONS) as [keyof typeof SECTIONS, ...(keyof typeof SECTIONS)[]])
        .default('top'),
      limit: z.number().int().min(1).max(30).default(10),
    }),
    output: z.object({ feed: z.string(), headlines: z.array(entry) }),
    async run(ctx, input) {
      const feed = await getFeed(ctx, `https://feeds.bbci.co.uk${SECTIONS[input.section]}`)
      return {
        feed: plainText(feed.title ?? 'BBC News', 200),
        headlines: feed.items.slice(0, input.limit).map((item) => toEntry(item, 500)),
      }
    },
  }),

  list_releases: tool({
    input: z.object({
      owner: z.string().regex(NAME),
      repo: z.string().regex(NAME),
      limit: z.number().int().min(1).max(20).default(5),
    }),
    output: z.object({ releases: z.array(entry.extend({ tag: z.string() })) }),
    async run(ctx, input) {
      const feed = await getFeed(
        ctx,
        `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/releases.atom`,
      )
      return {
        releases: feed.items.slice(0, input.limit).map((item) => {
          const e = toEntry(item, 2000)
          return { ...e, tag: e.title }
        }),
      }
    },
  }),
}
