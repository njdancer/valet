import {
  decideRequest,
  type EnsureResult,
  type FetchInit,
  type FetchResult,
  hasLogin,
  NeedsUserError,
  type ToolContext,
  ValetError,
} from '@valet/core'
import { runInToolContext } from '@valet/runtime/in-context'
import { buildToolScript } from '@valet/runtime/tool-script'
import { describe, expect, it } from 'vitest'
import { createAdapter } from '../src/adapter'
import { createManifest, NOTES } from '../src/manifest'
import {
  listProjects,
  listThreads,
  newerThan,
  readMessages,
  sendMessage,
  timeKey,
  toMessage,
} from '../src/projects'

const ORIGIN = 'https://claude.test'
const PROJECT = 'chan_01AbcdefghijKLMNOP'
const SESSION = 'cse_01AbcdefghijKLMNOP'
const THREAD = 'cmsg_01AbcdefghijThread1'
const PERSON = 'user_01Person'

const json = (body: unknown, status = 200): FetchResult => ({
  status,
  contentType: 'application/json',
  body,
})

interface Call {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly init?: FetchInit
}

type Route = (call: Call) => FetchResult

/**
 * A tool context on the fake origin. Its fetch checks the manifest's request surface, as the
 * driver does, then answers from `routes` by "METHOD /path".
 */
function claude(routes: Record<string, Route | FetchResult>, ensure: EnsureResult = { status: 'ok' }) {
  const manifest = createManifest({ origin: ORIGIN })
  const calls: Call[] = []
  let ensured = 0
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    session: {
      ensure: async () => {
        ensured++
        return ensure
      },
    },
    confirm: async () => Promise.reject(new Error('not used')),
    page: {
      currentUrl: () => `${ORIGIN}/robots.txt`,
      goto: async () => Promise.reject(new Error('not used')),
      click: async () => Promise.reject(new Error('not used')),
      fill: async () => Promise.reject(new Error('not used')),
      extract: async () => Promise.reject(new Error('not used')),
      evaluate: async () => Promise.reject(new Error('not used')),
      fetch: async (url: string, init?: FetchInit) => {
        const method = init?.method ?? 'GET'
        const target = new URL(url)
        if (!decideRequest(method, target.href, manifest.egress, manifest.requests).allowed) {
          throw new ValetError('request-surface', 'undeclared-request')
        }
        const call: Call = {
          method,
          path: target.pathname,
          query: Object.fromEntries(target.searchParams),
          ...(init === undefined ? {} : { init }),
        }
        calls.push(call)
        const route = routes[`${method} ${target.pathname}`]
        if (route === undefined) return json({ error: 'not found' }, 404)
        return typeof route === 'function' ? route(call) : route
      },
    },
  }
  return { ctx, calls, ensured: () => ensured }
}

const message = (id: string, at: string, body: string, person = false) => ({
  id,
  created_at: at,
  body,
  channel_id: PROJECT,
  ...(person ? { author_account_id: PERSON } : { author_agent_id: 'cagt_1' }),
})

const CHANNEL = { channel: { id: PROJECT, name: 'Valet', channel_session_id: SESSION } }
const session = (status: string) => json({ response_shape: { worker_status: status, status: 'active' } })

describe('list_projects', () => {
  it('lists joined projects with their title and description, leaving out archived ones', async () => {
    const { ctx, calls } = claude({
      'GET /v1/code/channels': json({
        data: [
          {
            id: PROJECT,
            name: 'Valet',
            topic: 'Get Valet to its MVP',
            last_activity_at: '2026-11-20T05:52:32Z',
            thread_count: '76',
          },
          { id: 'chan_01Archivedxxxxxxx', name: 'Old', archived_at: '2026-01-01T00:00:00Z' },
          { id: 'chan_01Snugxxxxxxxxxxx', name: 'Snug', topic: '' },
        ],
      }),
    })
    const out = await listProjects.run(ctx, listProjects.input.parse({}))
    expect(calls[0]?.query).toMatchObject({ scope: 'joined' })
    expect(calls[0]?.init?.headers?.['anthropic-version']).toBe('2023-06-01')
    expect(out.projects).toEqual([
      {
        id: PROJECT,
        title: 'Valet',
        description: 'Get Valet to its MVP',
        lastActivity: '2026-11-20T05:52:32Z',
        threadCount: 76,
      },
      {
        id: 'chan_01Snugxxxxxxxxxxx',
        title: 'Snug',
        description: null,
        lastActivity: null,
        threadCount: null,
      },
    ])
  })

  it('reports a changed answer as site-changed', async () => {
    const { ctx } = claude({ 'GET /v1/code/channels': json({ items: [] }) })
    await expect(listProjects.run(ctx, {})).rejects.toMatchObject({ errorClass: 'site-changed' })
  })

  it('hands the person the sign-in when the session is gone', async () => {
    const { ctx, calls } = claude({}, { status: 'needsUser', reason: 'login-required' })
    await expect(listProjects.run(ctx, {})).rejects.toBeInstanceOf(NeedsUserError)
    expect(calls).toHaveLength(0)
  })

  it('signs in again once when the site answers 401, then retries', async () => {
    let first = true
    const { ctx, ensured } = claude({
      'GET /v1/code/channels': () => {
        if (first) {
          first = false
          return json({ error: 'unauthorized' }, 401)
        }
        return json({ data: [] })
      },
    })
    expect(await listProjects.run(ctx, {})).toEqual({ projects: [] })
    expect(ensured()).toBe(2)
  })

  it('maps the site’s failures to error classes', async () => {
    for (const [status, errorClass] of [
      [429, 'rate-limited'],
      [403, 'blocked-by-site'],
      [400, 'invalid'],
      [500, 'unavailable'],
    ] as const) {
      const { ctx } = claude({ 'GET /v1/code/channels': json({}, status) })
      await expect(listProjects.run(ctx, {})).rejects.toMatchObject({ errorClass })
    }
    const { ctx } = claude({
      'GET /v1/code/channels': { status: 200, contentType: 'text/html', body: '<html>' },
    })
    await expect(listProjects.run(ctx, {})).rejects.toMatchObject({ errorClass: 'unexpected-shape' })
  })
})

describe('list_threads', () => {
  const threads = json({
    sections: [
      {
        status: 'needs_input',
        data: [
          {
            id: THREAD,
            body: 'Fix the export button\nmore',
            thread_status: 'needs_input',
            thread_preview: 'Needs your go on the plan',
            thread_any_session_working: false,
            bound_sessions: [{ id: 'cse_x', title: 'Fix Safari export button' }],
            last_reply_at: '2026-11-18T14:50:34Z',
          },
        ],
      },
      {
        status: 'working',
        data: [{ id: 'cmsg_01Workingthreadxx', body: 'Build it', thread_any_session_working: true }],
      },
      { status: 'resolved', data: [{ id: 'cmsg_01Resolvedthreadx', body: 'Done' }] },
    ],
  })

  it('lists open threads with their title and status', async () => {
    const { ctx, calls } = claude({ [`GET /v1/code/channels/${PROJECT}/threads`]: threads })
    const out = await listThreads.run(ctx, listThreads.input.parse({ projectId: PROJECT }))
    expect(calls[0]?.path).toBe(`/v1/code/channels/${PROJECT}/threads`)
    expect(out.threads).toEqual([
      {
        id: THREAD,
        title: 'Fix Safari export button',
        status: 'needs_input',
        statusLine: 'Needs your go on the plan',
        working: false,
        lastActivity: '2026-11-18T14:50:34Z',
      },
      {
        id: 'cmsg_01Workingthreadxx',
        title: 'Build it',
        status: 'working',
        statusLine: null,
        working: true,
        lastActivity: null,
      },
    ])
  })

  it('includes resolved threads when asked', async () => {
    const { ctx } = claude({ [`GET /v1/code/channels/${PROJECT}/threads`]: threads })
    const out = await listThreads.run(
      ctx,
      listThreads.input.parse({ projectId: PROJECT, includeResolved: true }),
    )
    expect(out.threads.map((t) => t.status)).toEqual(['needs_input', 'working', 'resolved'])
  })

  it('refuses an id that isn’t a project id', () => {
    for (const projectId of ['chan_', '../x', 'cmsg_01AbcdefghijKLMNOP', `${PROJECT}/archive`])
      expect(listThreads.input.safeParse({ projectId }).success).toBe(false)
  })

  it('reports a missing project and a changed answer', async () => {
    const missing = claude({})
    await expect(
      listThreads.run(missing.ctx, { projectId: PROJECT, includeResolved: false }),
    ).rejects.toMatchObject({
      errorClass: 'not-found',
    })
    const changed = claude({ [`GET /v1/code/channels/${PROJECT}/threads`]: json({ items: [] }) })
    await expect(
      listThreads.run(changed.ctx, { projectId: PROJECT, includeResolved: false }),
    ).rejects.toMatchObject({
      errorClass: 'site-changed',
    })
  })
})

describe('messages', () => {
  it('turns the project’s own notices into text with the thread they name', () => {
    const notice = JSON.stringify({
      kind: 'thread_started',
      thread_root_id: THREAD,
      title: 'Fix Safari export button',
      text: 'Created a thread.',
    })
    expect(toMessage(message('cmsg_1', '2026-11-20T05:00:00Z', notice), 100)).toEqual({
      id: 'cmsg_1',
      at: '2026-11-20T05:00:00Z',
      from: 'claude',
      text: 'Created a thread.',
      kind: 'thread_started',
      threadId: THREAD,
      title: 'Fix Safari export button',
    })
    expect(toMessage(message('cmsg_2', '2026-11-20T05:00:00Z', '{not json', true), 100)).toMatchObject({
      from: 'person',
      text: '{not json',
    })
    expect(
      toMessage(message('cmsg_3', '2026-11-20T05:00:00Z', JSON.stringify({ kind: 'activity' })), 100),
    ).toBeNull()
    expect(toMessage(message('cmsg_4', '2026-11-20T05:00:00Z', '   '), 100)).toBeNull()
    expect(toMessage({ body: 'no id' }, 100)).toBeNull()
    expect(toMessage(message('cmsg_5', '2026-11-20T05:00:00Z', 'abcdef'), 3)).toMatchObject({
      text: 'abc',
      truncated: true,
    })
  })

  it('orders times whatever digits their fraction has', () => {
    expect(timeKey('2026-11-20T05:52:32.26Z') > timeKey('2026-11-20T05:52:32.260207Z')).toBe(false)
    expect(timeKey('2026-11-20T05:52:32.3Z') > timeKey('2026-11-20T05:52:32.260207Z')).toBe(true)
    expect(timeKey('2026-11-20T05:52:33Z') > timeKey('2026-11-20T05:52:32.999Z')).toBe(true)
    expect(timeKey('odd')).toBe('odd')
    const raw = [message('a', '2026-11-20T05:00:00Z', 'old'), message('b', '2026-11-20T05:00:01.5Z', 'new')]
    expect(newerThan(raw, '2026-11-20T05:00:00.000000Z', 100).map((m) => m.id)).toEqual(['b'])
  })
})

describe('read_messages', () => {
  const timeline = json({
    data: [
      message('cmsg_3', '2026-11-20T05:02:00.000003Z', 'On it, starting a thread.'),
      message('cmsg_2', '2026-11-20T05:01:00Z', 'How is the export fix going?', true),
      message('cmsg_1', '2026-11-20T05:00:00Z', 'Earlier'),
    ],
  })

  it('reads the latest of the project chat, oldest first, with whether the coordinator is working', async () => {
    const { ctx, calls } = claude({
      [`GET /v1/code/channels/${PROJECT}`]: json(CHANNEL),
      [`GET /v1/code/channels/${PROJECT}/timeline`]: timeline,
      [`GET /v1/code/sessions/${SESSION}`]: session('running'),
    })
    const out = await readMessages.run(ctx, readMessages.input.parse({ projectId: PROJECT, limit: 2 }))
    expect(out.messages.map((m) => [m.id, m.from])).toEqual([
      ['cmsg_2', 'person'],
      ['cmsg_3', 'claude'],
    ])
    expect(out.cursor).toBe('2026-11-20T05:02:00.000003Z')
    expect(out.working).toBe(true)
    expect(calls.map((c) => c.path)).toEqual([
      `/v1/code/channels/${PROJECT}`,
      `/v1/code/channels/${PROJECT}/timeline`,
      `/v1/code/sessions/${SESSION}`,
    ])
  })

  it('reads only what is newer than the cursor', async () => {
    const { ctx } = claude({
      [`GET /v1/code/channels/${PROJECT}`]: json(CHANNEL),
      [`GET /v1/code/channels/${PROJECT}/timeline`]: timeline,
      [`GET /v1/code/sessions/${SESSION}`]: session('idle'),
    })
    const out = await readMessages.run(
      ctx,
      readMessages.input.parse({ projectId: PROJECT, after: '2026-11-20T05:01:00Z' }),
    )
    expect(out.messages.map((m) => m.id)).toEqual(['cmsg_3'])
    expect(out.working).toBe(false)
    expect(out.missedSome).toBeUndefined()

    const quiet = await readMessages.run(
      ctx,
      readMessages.input.parse({ projectId: PROJECT, after: '2026-11-20T05:02:00.000003Z' }),
    )
    expect(quiet).toEqual({ messages: [], cursor: '2026-11-20T05:02:00.000003Z', working: false })
  })

  it('says when more arrived than one page holds', async () => {
    const page = Array.from({ length: 50 }, (_, i) =>
      message(`cmsg_${i}`, `2026-11-20T06:${String(59 - i).padStart(2, '0')}:00Z`, `m${i}`),
    )
    const { ctx } = claude({
      [`GET /v1/code/channels/${PROJECT}`]: json({ channel: { id: PROJECT } }),
      [`GET /v1/code/channels/${PROJECT}/timeline`]: json({ data: page }),
    })
    const out = await readMessages.run(
      ctx,
      readMessages.input.parse({ projectId: PROJECT, after: '2026-11-20T05:00:00Z' }),
    )
    expect(out.messages).toHaveLength(50)
    expect(out.missedSome).toBe(true)
    // No coordinator session to ask: not working.
    expect(out.working).toBe(false)
  })

  it('reads one thread, working while any of its sessions is', async () => {
    const { ctx, calls } = claude({
      [`GET /v1/code/channels/${PROJECT}/threads/${THREAD}`]: json({
        data: [
          message(THREAD, '2026-11-20T05:00:00Z', 'Fix the export button', true),
          { ...message('cmsg_r1', '2026-11-20T05:01:00Z', 'Looking now.'), thread_any_session_working: true },
        ],
        linked_sessions: [],
      }),
    })
    const out = await readMessages.run(
      ctx,
      readMessages.input.parse({ projectId: PROJECT, threadId: THREAD }),
    )
    expect(out.messages.map((m) => m.text)).toEqual(['Fix the export button', 'Looking now.'])
    expect(out.working).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('reports a missing thread or project as not-found', async () => {
    const { ctx } = claude({})
    await expect(
      readMessages.run(ctx, readMessages.input.parse({ projectId: PROJECT, threadId: THREAD })),
    ).rejects.toMatchObject({ errorClass: 'not-found' })
    await expect(
      readMessages.run(ctx, readMessages.input.parse({ projectId: PROJECT })),
    ).rejects.toMatchObject({
      errorClass: 'not-found',
    })
    const noTimeline = claude({ [`GET /v1/code/channels/${PROJECT}`]: json(CHANNEL) })
    await expect(
      readMessages.run(noTimeline.ctx, readMessages.input.parse({ projectId: PROJECT })),
    ).rejects.toMatchObject({ errorClass: 'not-found' })
  })

  it('refuses a cursor that isn’t one', () => {
    for (const after of ['yesterday', '2026-11-20', '2026-11-20T05:00:00Z&scope=all'])
      expect(readMessages.input.safeParse({ projectId: PROJECT, after }).success).toBe(false)
  })
})

describe('send_message', () => {
  it('sends to the coordinator and waits for its reply to finish', async () => {
    const mine = message('cmsg_mine', '2026-11-20T05:10:00Z', 'How is Valet going?', true)
    const reply = message('cmsg_reply', '2026-11-20T05:10:05Z', 'Two PRs merged today.')
    let reads = 0
    const { ctx, calls } = claude({
      [`POST /v1/code/channels/${PROJECT}/messages`]: json({ message_id: 'cmsg_mine' }),
      [`GET /v1/code/channels/${PROJECT}`]: json(CHANNEL),
      [`GET /v1/code/channels/${PROJECT}/timeline`]: () => {
        reads++
        return json({ data: reads === 1 ? [mine] : [reply, mine] })
      },
      [`GET /v1/code/sessions/${SESSION}`]: () => session(reads < 3 ? 'running' : 'idle'),
    })
    const out = await sendMessage.run(
      ctx,
      sendMessage.input.parse({ projectId: PROJECT, text: 'How is Valet going?' }),
    )
    const sent = calls[0]
    expect(sent?.method).toBe('POST')
    const body = sent?.init?.json as Record<string, unknown>
    expect(body['body']).toBe('How is Valet going?')
    expect(body['client_message_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(body).not.toHaveProperty('reply_to_message_id')
    expect(out).toEqual({
      messageId: 'cmsg_mine',
      messages: [
        expect.objectContaining({ id: 'cmsg_reply', from: 'claude', text: 'Two PRs merged today.' }),
      ],
      cursor: '2026-11-20T05:10:05Z',
      working: false,
    })
    // The coordinator's session was looked up once, not on every read.
    expect(calls.filter((c) => c.path === `/v1/code/channels/${PROJECT}`)).toHaveLength(1)
  })

  it('sends into a thread as a reply to its root, and can return at once', async () => {
    const mine = message('cmsg_mine', '2026-11-20T05:10:00Z', 'Go ahead', true)
    const { ctx, calls } = claude({
      [`POST /v1/code/channels/${PROJECT}/messages`]: json({ message_id: 'cmsg_mine' }),
      [`GET /v1/code/channels/${PROJECT}/threads/${THREAD}`]: json({
        data: [message(THREAD, '2026-11-20T05:00:00Z', 'Root', true), mine],
      }),
    })
    const out = await sendMessage.run(
      ctx,
      sendMessage.input.parse({ projectId: PROJECT, threadId: THREAD, text: 'Go ahead', wait: false }),
    )
    expect(calls[0]?.init?.json).toMatchObject({ reply_to_message_id: THREAD })
    expect(out).toEqual({
      messageId: 'cmsg_mine',
      messages: [],
      cursor: '2026-11-20T05:10:00Z',
      working: true,
    })
    expect(calls).toHaveLength(2)
  })

  it('stops waiting within its request budget and says the reply is still coming', async () => {
    const mine = message('cmsg_mine', '2026-11-20T05:10:00Z', 'Plan the trip', true)
    const partial = {
      ...message('cmsg_r', '2026-11-20T05:10:03Z', 'Starting…'),
      thread_any_session_working: true,
    }
    const { ctx, calls } = claude({
      [`POST /v1/code/channels/${PROJECT}/messages`]: json({ message_id: 'cmsg_mine' }),
      [`GET /v1/code/channels/${PROJECT}/threads/${THREAD}`]: json({ data: [mine, partial] }),
    })
    const out = await sendMessage.run(
      ctx,
      sendMessage.input.parse({ projectId: PROJECT, threadId: THREAD, text: 'Plan the trip' }),
    )
    expect(out.working).toBe(true)
    expect(out.messages.map((m) => m.id)).toEqual(['cmsg_r'])
    expect(calls.length).toBeLessThanOrEqual(26)
  })

  it('never sends twice: a refused send signs in and sends once more, a failed read after it does not', async () => {
    let posts = 0
    const { ctx } = claude({
      [`POST /v1/code/channels/${PROJECT}/messages`]: () => {
        posts++
        return posts === 1 ? json({}, 401) : json({ message_id: 'cmsg_mine' })
      },
      [`GET /v1/code/channels/${PROJECT}/threads/${THREAD}`]: json({}, 401),
    })
    await expect(
      sendMessage.run(ctx, sendMessage.input.parse({ projectId: PROJECT, threadId: THREAD, text: 'Hi' })),
    ).rejects.toMatchObject({ errorClass: 'not-logged-in' })
    expect(posts).toBe(2)
  })

  it('reports a send the site didn’t give an id for', async () => {
    const { ctx } = claude({ [`POST /v1/code/channels/${PROJECT}/messages`]: json({ ok: true }) })
    await expect(
      sendMessage.run(ctx, sendMessage.input.parse({ projectId: PROJECT, text: 'Hi' })),
    ).rejects.toMatchObject({
      errorClass: 'unexpected-shape',
    })
  })

  it('refuses an empty message and a wait past 30 seconds', () => {
    expect(sendMessage.input.safeParse({ projectId: PROJECT, text: '  ' }).success).toBe(false)
    expect(sendMessage.input.safeParse({ projectId: PROJECT, text: 'x', waitSeconds: 31 }).success).toBe(
      false,
    )
  })
})

describe('the claude.ai manifest', () => {
  it('signs in, declares exactly the calls the tools make, and writes only messages', () => {
    const manifest = createManifest()
    expect(hasLogin(manifest)).toBe(true)
    expect(manifest.egress).toEqual(['claude.ai'])
    expect(manifest.secrets).toEqual({})
    expect(manifest.session.cookieDomains).toEqual(['claude.ai'])
    expect(manifest.auth.frameOrigins).toEqual(['https://challenges.cloudflare.com'])
    expect(manifest.requests.filter((r) => r.method !== 'GET')).toEqual([
      { method: 'POST', path: '/v1/code/channels/:channel/messages', purpose: 'write' },
    ])
    expect(manifest.tools.map((t) => [t.name, t.sideEffect])).toEqual([
      ['list_projects', 'read'],
      ['list_threads', 'read'],
      ['read_messages', 'read'],
      ['send_message', 'write'],
    ])
    expect(() => createAdapter()).not.toThrow()
  })

  it('refuses anything else on claude.ai: archiving, members, settings, other APIs', () => {
    const manifest = createManifest()
    for (const [method, path] of [
      ['POST', `/v1/code/channels/${PROJECT}/archive`],
      ['POST', `/v1/code/channels/${PROJECT}/leave`],
      ['POST', `/v1/code/channels/${PROJECT}/members`],
      ['GET', `/v1/code/channels/${PROJECT}/config`],
      ['GET', '/api/organizations'],
      ['POST', `/v1/code/channels/${PROJECT}/threads/${THREAD}`],
      ['GET', `/v1/sessions/session_1/events`],
    ] as const) {
      expect(
        decideRequest(method, `https://claude.ai${path}`, manifest.egress, manifest.requests).allowed,
      ).toBe(false)
    }
  })

  it('hands the sign-in to the person when claude.ai stays on its sign-in page', () => {
    const steps = createManifest().auth.steps
    expect(steps[0]).toEqual({ op: 'goto', url: 'https://claude.ai/login' })
    expect(JSON.stringify(steps)).toContain(NOTES.signIn)
    expect(steps.at(-1)).toEqual({ op: 'assertLoggedIn' })
    expect(createManifest({ origin: ORIGIN }).auth.frameOrigins).toEqual([])
  })
})

// As the app runs them: bundled, in the tool process's context, which has no URL, URLSearchParams
// or crypto.
describe('in the tool process', () => {
  it('runs each tool against the captured responses', async () => {
    const script = await buildToolScript(new URL('../src/tools.ts', import.meta.url).pathname)
    const mine = message('cmsg_mine', '2026-11-20T05:10:00Z', 'Hi', true)
    const reply = message('cmsg_reply', '2026-11-20T05:10:01Z', 'Hello')
    const { ctx, calls } = claude({
      'GET /v1/code/channels': json({ data: [{ id: PROJECT, name: 'Valet', topic: 'MVP' }] }),
      [`GET /v1/code/channels/${PROJECT}/threads`]: json({ sections: [] }),
      [`GET /v1/code/channels/${PROJECT}`]: json(CHANNEL),
      [`GET /v1/code/channels/${PROJECT}/timeline`]: json({ data: [reply, mine] }),
      [`GET /v1/code/sessions/${SESSION}`]: session('idle'),
      [`POST /v1/code/channels/${PROJECT}/messages`]: json({ message_id: 'cmsg_mine' }),
    })
    expect(await runInToolContext(script, 'list_projects', {}, ctx)).toMatchObject({
      projects: [{ id: PROJECT, title: 'Valet' }],
    })
    expect(await runInToolContext(script, 'list_threads', { projectId: PROJECT }, ctx)).toEqual({
      threads: [],
    })
    expect(await runInToolContext(script, 'read_messages', { projectId: PROJECT }, ctx)).toMatchObject({
      messages: [{ id: 'cmsg_mine' }, { id: 'cmsg_reply' }],
    })
    expect(
      await runInToolContext(script, 'send_message', { projectId: PROJECT, text: 'Hi' }, ctx),
    ).toMatchObject({
      messageId: 'cmsg_mine',
      messages: [{ id: 'cmsg_reply' }],
      working: false,
    })
    expect(calls[0]?.query).toEqual({ scope: 'joined', limit: '50' })
  })
})
