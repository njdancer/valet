import { tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { articleUrl, field, getJson, plain, siteUrl, str } from './site'

/** A title as a person or agent writes it. Kept to one line and one path segment's worth. */
const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (t) => !/[#<>[\]{}|]/.test(t) && ![...t].some((c) => c.charCodeAt(0) < 0x20),
    'not a valid article title',
  )

export const searchArticles = tool({
  input: z.object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  output: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        description: z.string().nullable(),
        excerpt: z.string().nullable(),
        url: z.string(),
      }),
    ),
  }),
  async run(ctx, input) {
    const body = await getJson(
      ctx,
      siteUrl(ctx, '/w/rest.php/v1/search/page', { q: input.query, limit: String(input.limit) }),
    )
    const pages = field(body, 'pages')
    if (!Array.isArray(pages)) throw new ValetError('tool-run', 'site-changed')
    return {
      results: pages.flatMap((p) => {
        const title = str(field(p, 'title'))
        if (title === null) return []
        return [
          {
            title,
            description: str(field(p, 'description')),
            excerpt: plain(field(p, 'excerpt')),
            url: articleUrl(ctx, title),
          },
        ]
      }),
    }
  },
})

export const getSummary = tool({
  input: z.object({ title: titleSchema }),
  output: z.object({
    title: z.string(),
    description: z.string().nullable(),
    summary: z.string(),
    /** standard, disambiguation, or another kind the site names. */
    type: z.string().nullable(),
    lastEdited: z.string().nullable(),
    url: z.string(),
  }),
  async run(ctx, input) {
    const segment = encodeURIComponent(input.title.replace(/ /g, '_'))
    const body = await getJson(
      ctx,
      siteUrl(ctx, `/api/rest_v1/page/summary/${segment}`, { redirect: 'true' }),
    )
    if (body === null) throw new ValetError('tool-run', 'not-found')
    const title = str(field(body, 'title'))
    const summary = str(field(body, 'extract'))
    if (title === null || summary === null) throw new ValetError('tool-run', 'site-changed')
    return {
      title,
      description: str(field(body, 'description')),
      summary,
      type: str(field(body, 'type')),
      lastEdited: str(field(body, 'timestamp')),
      url: articleUrl(ctx, title),
    }
  },
})

export const getArticle = tool({
  input: z.object({ title: titleSchema, maxChars: z.number().int().min(500).max(100_000).default(20_000) }),
  output: z.object({ title: z.string(), text: z.string(), truncated: z.boolean(), url: z.string() }),
  async run(ctx, input) {
    const body = await getJson(
      ctx,
      siteUrl(ctx, '/w/api.php', {
        action: 'query',
        prop: 'extracts',
        explaintext: '1',
        exsectionformat: 'wiki',
        redirects: '1',
        titles: input.title,
        format: 'json',
        formatversion: '2',
      }),
    )
    const pages = field(field(body, 'query'), 'pages')
    const page = Array.isArray(pages) ? pages[0] : undefined
    if (page === undefined) throw new ValetError('tool-run', 'site-changed')
    if (field(page, 'missing') === true || field(page, 'invalid') === true)
      throw new ValetError('tool-run', 'not-found')
    const title = str(field(page, 'title'))
    const text = str(field(page, 'extract'))
    if (title === null || text === null) throw new ValetError('tool-run', 'site-changed')
    const truncated = text.length > input.maxChars
    return {
      title,
      text: truncated ? text.slice(0, input.maxChars) : text,
      truncated,
      url: articleUrl(ctx, title),
    }
  },
})
