// The four tools of Nick's brief: list projects, list threads, read messages and send a message.
// A project is what claude.ai's API calls a channel; its chat is the channel's timeline, where the
// person and the project's coordinator talk; a thread is a message with replies, worked on by its
// own Claude.

import { type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { api, field, idPattern, list, str, withLogin } from './site'

const projectId = z.string().regex(idPattern('chan'), 'a project id, like chan_01AbC…')
const threadId = z.string().regex(idPattern('cmsg'), 'a thread id, like cmsg_01AbC…')

const messageSchema = z.object({
  id: z.string(),
  at: z.string(),
  /** 'person' for anything the person's account sent (send_message included), 'claude' otherwise. */
  from: z.enum(['person', 'claude']),
  text: z.string(),
  /** What kind of notice it is, for the project's own notices (a thread started, a message routed). */
  kind: z.string().optional(),
  /** The thread a notice is about, when it names one. */
  threadId: z.string().optional(),
  /** The thread's title, when a notice gives one. */
  title: z.string().optional(),
  truncated: z.boolean().optional(),
})
type Message = z.infer<typeof messageSchema>

const DEFAULT_MAX_CHARS = 4000
/** The project chat is read newest first, a page at a time; one page is plenty between two reads. */
const TIMELINE_PAGE = 50

// ---------- Reading ----------

/**
 * A time claude.ai writes ("2026-11-20T05:52:32.260207Z") as a key that sorts the same way as the
 * time, whatever digits its fraction has.
 */
export function timeKey(at: string): string {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(at)
  if (match === null) return at
  return `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z`
}

/** One message as the tools return it, or null for one with nothing to show. */
export function toMessage(raw: unknown, maxChars: number): Message | null {
  const id = str(field(raw, 'id'))
  const at = str(field(raw, 'created_at'))
  if (id === null || at === null) return null
  const from = str(field(raw, 'author_account_id')) === null ? 'claude' : 'person'
  const body = typeof field(raw, 'body') === 'string' ? (field(raw, 'body') as string) : ''
  let text = body
  let kind: string | undefined
  let thread: string | undefined
  let title: string | undefined
  // The project's own notices (a thread started, a message routed to a thread) are JSON.
  if (body.startsWith('{')) {
    try {
      const notice: unknown = JSON.parse(body)
      const noticeKind = str(field(notice, 'kind'))
      if (noticeKind !== null) {
        kind = noticeKind
        text = str(field(notice, 'text')) ?? ''
        thread = str(field(notice, 'thread_root_id')) ?? undefined
        title = str(field(notice, 'title')) ?? undefined
      }
    } catch {
      // Not a notice: a message that starts with a brace.
    }
  }
  if (text.trim() === '' && thread === undefined) return null
  const truncated = text.length > maxChars
  return {
    id,
    at,
    from,
    text: truncated ? text.slice(0, maxChars) : text,
    ...(kind === undefined ? {} : { kind }),
    ...(thread === undefined ? {} : { threadId: thread }),
    ...(title === undefined ? {} : { title }),
    ...(truncated ? { truncated: true } : {}),
  }
}

interface Conversation {
  /** Oldest first. */
  readonly messages: readonly unknown[]
  readonly working: boolean
  /** True when the read may have missed messages between the cursor and the oldest one it saw. */
  readonly gap: boolean
}

/** Where a conversation is: the project chat (no thread) or one thread. */
export interface Target {
  readonly projectId: string
  readonly threadId?: string | undefined
}

/**
 * Reads one conversation. For the project chat, `sessionOf` remembers the coordinator's session
 * across reads in one call, so a wait doesn't look it up every time.
 */
export class Reader {
  private coordinator: string | null | undefined
  requests = 0

  constructor(
    private readonly ctx: ToolContext,
    private readonly target: Target,
  ) {}

  async read(after: string | null): Promise<Conversation> {
    return this.target.threadId === undefined ? this.readChat(after) : this.readThread(this.target.threadId)
  }

  private async readThread(thread: string): Promise<Conversation> {
    const body = await this.call(`/v1/code/channels/${this.target.projectId}/threads/${thread}`)
    if (body === null) throw new ValetError('tool-run', 'not-found')
    const messages = list(field(body, 'data'))
    const working = messages.some((m) => field(m, 'thread_any_session_working') === true)
    return { messages, working, gap: false }
  }

  private async readChat(after: string | null): Promise<Conversation> {
    const session = await this.coordinatorSession()
    const body = await this.call(`/v1/code/channels/${this.target.projectId}/timeline`, {
      limit: TIMELINE_PAGE,
    })
    if (body === null) throw new ValetError('tool-run', 'not-found')
    const newestFirst = list(field(body, 'data'))
    const messages = [...newestFirst].reverse()
    const oldest = str(field(messages[0], 'created_at'))
    const gap =
      after !== null &&
      newestFirst.length >= TIMELINE_PAGE &&
      oldest !== null &&
      timeKey(oldest) > timeKey(after)
    let working = false
    if (session !== null) {
      const state = await this.call(`/v1/code/sessions/${session}`)
      const shape = field(state, 'response_shape') ?? state
      const status = str(field(shape, 'worker_status'))
      working = status !== null && status !== 'idle'
    }
    return { messages, working, gap }
  }

  private async coordinatorSession(): Promise<string | null> {
    if (this.coordinator !== undefined) return this.coordinator
    const body = await this.call(`/v1/code/channels/${this.target.projectId}`)
    if (body === null) throw new ValetError('tool-run', 'not-found')
    const session = str(field(field(body, 'channel'), 'channel_session_id'))
    this.coordinator = session !== null && idPattern('cse').test(session) ? session : null
    return this.coordinator
  }

  private async call(path: string, query: Record<string, string | number> = {}): Promise<unknown> {
    this.requests++
    return api(this.ctx, path, query)
  }
}

/** The messages after `after` (all of them without it), as the tools return them. */
export function newerThan(raw: readonly unknown[], after: string | null, maxChars: number): Message[] {
  const out: Message[] = []
  for (const m of raw) {
    const message = toMessage(m, maxChars)
    if (message === null) continue
    if (after !== null && timeKey(message.at) <= timeKey(after)) continue
    out.push(message)
  }
  return out
}

/** The newest message time seen, or `fallback`. */
function cursorOf(raw: readonly unknown[], fallback: string | null): string | null {
  let cursor = fallback
  for (const m of raw) {
    const at = str(field(m, 'created_at'))
    if (at !== null && (cursor === null || timeKey(at) > timeKey(cursor))) cursor = at
  }
  return cursor
}

const cursorSchema = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/, 'a cursor from send_message or read_messages')

const targetFields = {
  projectId,
  threadId: threadId
    .optional()
    .describe("The thread's id. Leave out for the project chat (the coordinator)."),
}

// ---------- The tools ----------

export const listProjects = tool({
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        lastActivity: z.string().nullable(),
        threadCount: z.number().nullable(),
      }),
    ),
  }),
  async run(ctx) {
    return withLogin(ctx, async () => {
      const body = await api(ctx, '/v1/code/channels', { scope: 'joined', limit: 50 })
      if (body === null) throw new ValetError('tool-run', 'site-changed')
      const rows = field(body, 'data')
      if (!Array.isArray(rows)) throw new ValetError('tool-run', 'site-changed')
      return {
        projects: rows.flatMap((c) => {
          const id = str(field(c, 'id'))
          if (id === null || field(c, 'archived_at') || field(c, 'disabled_at')) return []
          const count = Number(field(c, 'thread_count'))
          return [
            {
              id,
              title: str(field(c, 'name')) ?? id,
              description: str(field(c, 'topic')),
              lastActivity: str(field(c, 'last_activity_at')),
              threadCount: Number.isFinite(count) ? count : null,
            },
          ]
        }),
      }
    })
  },
})

const HIDDEN_BY_DEFAULT = ['resolved', 'archived']

export const listThreads = tool({
  input: z.object({
    projectId,
    includeResolved: z.boolean().default(false).describe('Also list recently resolved threads.'),
  }),
  output: z.object({
    threads: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        statusLine: z.string().nullable(),
        working: z.boolean(),
        lastActivity: z.string().nullable(),
      }),
    ),
  }),
  async run(ctx, input) {
    return withLogin(ctx, async () => {
      const body = await api(ctx, `/v1/code/channels/${input.projectId}/threads`, { limit: 20 })
      if (body === null) throw new ValetError('tool-run', 'not-found')
      const sections = field(body, 'sections')
      if (!Array.isArray(sections)) throw new ValetError('tool-run', 'site-changed')
      return {
        threads: sections.flatMap((section) => {
          const status = str(field(section, 'status')) ?? 'unknown'
          if (!input.includeResolved && HIDDEN_BY_DEFAULT.includes(status)) return []
          return list(field(section, 'data')).flatMap((t) => {
            const id = str(field(t, 'id'))
            if (id === null) return []
            const session = list(field(t, 'bound_sessions'))[0]
            const firstLine = (str(field(t, 'body')) ?? '').split('\n')[0]?.slice(0, 120) ?? ''
            return [
              {
                id,
                title: str(field(session, 'title')) ?? (firstLine === '' ? id : firstLine),
                status: str(field(t, 'thread_status')) ?? status,
                statusLine: str(field(t, 'thread_preview')),
                working: field(t, 'thread_any_session_working') === true,
                lastActivity: str(field(t, 'last_reply_at')) ?? str(field(t, 'created_at')),
              },
            ]
          })
        }),
      }
    })
  },
})

const conversationOutput = {
  messages: z.array(messageSchema),
  cursor: z.string().nullable(),
  working: z.boolean(),
  /** Some messages between the cursor and the first one here may have been missed. */
  missedSome: z.boolean().optional(),
}

export const readMessages = tool({
  input: z.object({
    ...targetFields,
    after: cursorSchema.optional().describe('Only messages after this cursor.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Without after: how many of the latest.'),
    maxChars: z.number().int().min(200).max(20_000).default(DEFAULT_MAX_CHARS),
  }),
  output: z.object(conversationOutput),
  async run(ctx, input) {
    return withLogin(ctx, async () => {
      const reader = new Reader(ctx, input)
      const after = input.after ?? null
      const conversation = await reader.read(after)
      let messages = newerThan(conversation.messages, after, input.maxChars)
      if (after === null) messages = messages.slice(-input.limit)
      return {
        messages,
        cursor: cursorOf(conversation.messages, after),
        working: conversation.working,
        ...(conversation.gap ? { missedSome: true } : {}),
      }
    })
  },
})

/** Requests a send may make in all: the runtime's per-run ceiling is 30. */
const SEND_REQUEST_BUDGET = 26

/** A client message id: claude.ai's own page sends a UUID. The tool process has no crypto. */
function clientMessageId(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  const variant = '89ab'[Math.floor(Math.random() * 4)]
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`
}

export const sendMessage = tool({
  input: z.object({
    ...targetFields,
    text: z.string().trim().min(1).max(20_000),
    wait: z.boolean().default(true).describe('Wait for the reply to finish, up to waitSeconds.'),
    waitSeconds: z.number().int().min(1).max(30).default(30),
    maxChars: z.number().int().min(200).max(20_000).default(DEFAULT_MAX_CHARS),
  }),
  output: z.object({ messageId: z.string(), ...conversationOutput }),
  async run(ctx, input) {
    // Only the send is retried after a fresh sign-in: a 401 means it was refused, so nothing was sent.
    const messageId = await withLogin(ctx, async () => {
      const sent = await api(
        ctx,
        `/v1/code/channels/${input.projectId}/messages`,
        {},
        {
          method: 'POST',
          json: {
            body: input.text,
            client_message_id: clientMessageId(),
            ...(input.threadId === undefined ? {} : { reply_to_message_id: input.threadId }),
          },
        },
      )
      const id = str(field(sent, 'message_id'))
      if (id === null) throw new ValetError('tool-run', 'unexpected-shape')
      return id
    })
    const started = Date.now()
    const reader = new Reader(ctx, input)
    let conversation = await reader.read(null)
    const own = conversation.messages.find((m) => field(m, 'id') === messageId)
    // The message's own time is the cursor: what comes after it is the reply.
    let cursor = str(field(own, 'created_at')) ?? cursorOf(conversation.messages, null)
    const replyCursor = cursor
    let messages = newerThan(conversation.messages, replyCursor, input.maxChars)
    const finished = () => messages.some((m) => m.from === 'claude') && !conversation.working
    while (
      input.wait &&
      !finished() &&
      Date.now() - started < input.waitSeconds * 1000 &&
      reader.requests + 2 < SEND_REQUEST_BUDGET
    ) {
      if (ctx.signal.aborted) break
      conversation = await reader.read(replyCursor)
      messages = newerThan(conversation.messages, replyCursor, input.maxChars)
    }
    cursor = cursorOf(conversation.messages, cursor)
    return {
      messageId,
      messages,
      cursor,
      working: conversation.working || !messages.some((m) => m.from === 'claude'),
    }
  },
})
